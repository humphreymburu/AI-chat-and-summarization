import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { ArticleDoc, Chunk, chunkArticle } from './chunker';
import { config } from './config';
import { logger } from './logger';
import { embedTexts } from './openrouter';
import { ChunkViews, emptyViewsFor, generateViews } from './prompts';

export interface ProcessArticleResult {
  articleId: string;
  chunksWritten: number;
  summariesGenerated: number;
  questionsGenerated: number;
  elapsedMs: number;
}

export interface TickResult {
  articlesProcessed: number;
  articlesFailed: number;
  chunksWritten: number;
}

const opensearch = new OpenSearchClient({
  node: config.opensearch.url,
  auth: {
    username: config.opensearch.username,
    password: config.opensearch.password,
  },
});

const ARTICLE_SOURCE_FIELDS = [
  'title',
  'body',
  'langcode',
  'publication_date',
  'path',
  'site_name',
  'topics',
  'country',
  'story_type',
  'type',
  'resource_type',
  'uuid',
  'nid',
];

// How many candidate IDs to scan per page when looking for pending articles.
const SCAN_PAGE_SIZE = 500;

export async function startupHealthCheck(): Promise<void> {
  await opensearch.ping();
  if (config.embedding.provider === 'openrouter') {
    // Fail fast on a bad key/model/dimension before touching any article.
    await embedTexts(['startup health check']);
  }
}

/**
 * Find up to `limit` articles that still need processing at the current
 * EMBED_VERSION, newest first. chunks_state is the source of truth: an
 * article is done when its state doc says status=done for this version.
 */
export async function fetchPendingArticles(limit = config.scheduler.batchSize): Promise<ArticleDoc[]> {
  const pendingIds: string[] = [];

  let response = await opensearch.search({
    index: config.indexes.articles,
    scroll: '2m',
    body: {
      size: SCAN_PAGE_SIZE,
      _source: false,
      sort: [{ publication_date: { order: 'desc', unmapped_type: 'date' } }],
      query: {
        bool: {
          filter: [
            { term: { langcode: config.source.langcode } },
            { terms: { type: config.source.contentTypes } },
          ],
        },
      },
    },
  });
  let scrollId: string | undefined = response.body?._scroll_id;

  try {
    while (pendingIds.length < limit) {
      const ids: string[] = (response.body?.hits?.hits ?? []).map((hit: any) => hit._id);
      if (ids.length === 0) break;

      const skip = await idsToSkip(ids);
      for (const id of ids) {
        if (!skip.has(id)) pendingIds.push(id);
        if (pendingIds.length >= limit) break;
      }
      if (pendingIds.length >= limit || !scrollId) break;

      response = await opensearch.scroll({ scroll_id: scrollId, scroll: '2m' } as any);
      scrollId = response.body?._scroll_id ?? scrollId;
    }
  } finally {
    if (scrollId) {
      await opensearch.clearScroll({ body: { scroll_id: scrollId } } as any).catch(() => undefined);
    }
  }

  return fetchArticlesByIds(pendingIds);
}

/** IDs already done at this version (or errored, unless RETRY_ERRORS). */
async function idsToSkip(ids: string[]): Promise<Set<string>> {
  const response = await opensearch.mget({
    index: config.indexes.chunksState,
    body: { ids },
    _source: ['status', 'embed_version'],
  } as any);

  const skip = new Set<string>();
  for (const doc of response.body?.docs ?? []) {
    const state = doc.found ? doc._source : undefined;
    if (!state || state.embed_version !== config.embedding.version) continue;
    if (state.status === 'done') skip.add(doc._id);
    if (state.status === 'error' && !config.pipeline.retryErrors) skip.add(doc._id);
  }
  return skip;
}

async function fetchArticlesByIds(ids: string[]): Promise<ArticleDoc[]> {
  if (ids.length === 0) return [];
  const response = await opensearch.mget({
    index: config.indexes.articles,
    body: { ids },
    _source: ARTICLE_SOURCE_FIELDS,
  } as any);

  return (response.body?.docs ?? [])
    .filter((doc: any) => doc.found)
    .map((doc: any) => toArticleDoc(doc._id, doc._source));
}

export function toArticleDoc(id: string, source: any): ArticleDoc {
  return {
    _id: id,
    title: source?.title ?? '',
    body: source?.body ?? '',
    langcode: source?.langcode,
    publication_date: source?.publication_date,
    path: source?.path,
    site_name: source?.site_name,
    topics: source?.topics,
    country: source?.country,
    story_type: source?.story_type,
    type: source?.type,
    resource_type: source?.resource_type,
    uuid: source?.uuid,
    nid: source?.nid,
  };
}

export async function processArticle(article: ArticleDoc): Promise<ProcessArticleResult> {
  const startedAt = Date.now();
  const chunks = chunkArticle(article, config.chunker);

  // Drop chunks from any earlier run first, so a shorter re-chunk or a
  // version bump never leaves stale chunks behind.
  await deleteArticleChunks(article._id);

  if (chunks.length === 0) {
    await writeState(article, [], 'done', 0, 0);
    return {
      articleId: article._id,
      chunksWritten: 0,
      summariesGenerated: 0,
      questionsGenerated: 0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const views = await buildViews(chunks);
  const vectors = await embedChunks(chunks, views);
  const docs = chunks.map((chunk, index) =>
    toChunkDocument(article, chunk, chunks.length, index, views[index], vectors[index]),
  );
  await bulkIndexChunks(docs);

  const summariesGenerated = docs.filter(doc => doc.has_summary).length;
  const questionsGenerated = docs.filter(doc => doc.has_questions).length;
  await writeState(article, chunks, 'done', summariesGenerated, questionsGenerated);

  return {
    articleId: article._id,
    chunksWritten: chunks.length,
    summariesGenerated,
    questionsGenerated,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Process up to `limit` pending articles; one failure doesn't stop the batch. */
export async function processPendingBatch(limit = config.scheduler.batchSize): Promise<TickResult> {
  const articles = await fetchPendingArticles(limit);
  let chunksWritten = 0;
  let articlesFailed = 0;

  for (const article of articles) {
    try {
      const result = await processArticle(article);
      chunksWritten += result.chunksWritten;
      logger.info(
        {
          articleId: article._id,
          chunks: result.chunksWritten,
          summaries: result.summariesGenerated,
          questions: result.questionsGenerated,
          elapsedMs: result.elapsedMs,
        },
        'article_processed',
      );
    } catch (err) {
      articlesFailed += 1;
      logger.error({ articleId: article._id, err }, 'article_failed');
      await writeErrorState(article, err);
    }
  }

  return { articlesProcessed: articles.length, articlesFailed, chunksWritten };
}

export async function runVectorizationTick(): Promise<TickResult> {
  return processPendingBatch(config.scheduler.batchSize);
}

async function buildViews(chunks: Chunk[]): Promise<ChunkViews[]> {
  if (config.embedding.provider !== 'openrouter') return chunks.map(emptyViewsFor);
  return mapLimit(chunks, config.pipeline.viewsConcurrency, generateViews);
}

interface ChunkVectors {
  embedding?: number[];
  summary_embedding?: number[];
  questions_embedding?: number[];
}

/** Embed every view in one batched pass; absent views get no vector. */
async function embedChunks(chunks: Chunk[], views: ChunkViews[]): Promise<ChunkVectors[]> {
  const result: ChunkVectors[] = chunks.map(() => ({}));
  if (config.embedding.provider !== 'openrouter') return result;

  const jobs: Array<{ index: number; field: keyof ChunkVectors; text: string }> = [];
  chunks.forEach((chunk, index) => {
    jobs.push({ index, field: 'embedding', text: chunk.text });
    if (views[index].has_summary) {
      jobs.push({ index, field: 'summary_embedding', text: views[index].summary });
    }
    if (views[index].has_questions) {
      jobs.push({ index, field: 'questions_embedding', text: views[index].questions.join('\n') });
    }
  });

  const vectors = await embedTexts(jobs.map(job => job.text));
  jobs.forEach((job, i) => {
    result[job.index][job.field] = vectors[i];
  });
  return result;
}

function toChunkDocument(
  article: ArticleDoc,
  chunk: Chunk,
  chunkTotal: number,
  index: number,
  views: ChunkViews,
  vectors: ChunkVectors,
) {
  return {
    article_id: article._id,
    article_title: article.title,
    article_url: article.path ? `https://www.unep.org${article.path}` : '',
    publication_date: article.publication_date,
    topics: normalizeNamedList(article.topics),
    countries: normalizeNamedList(article.country),
    site_name: article.site_name ?? '',
    section_heading: chunk.section_heading,
    body: chunk.body,
    summary: views.summary,
    questions: views.questions.join('\n'),
    chunk_index: chunk.chunk_index,
    chunk_total: chunkTotal,
    langcode: article.langcode ?? config.source.langcode,
    story_type: normalizeNamedList(article.story_type),
    // Used by the backend's scope filters ("Publications only", "Policy docs").
    content_type: article.type ?? '',
    resource_type: normalizeNamedList(article.resource_type),
    has_summary: views.has_summary,
    has_questions: views.has_questions,
    low_content: chunk.low_content,
    token_count: chunk.token_count,
    embed_version: config.embedding.version,
    // Vector fields are omitted when a view is absent, which keeps the chunk
    // out of that kNN branch instead of matching on a meaningless vector.
    ...vectors,
    document_id: `${article._id}:${index}`,
  };
}

async function deleteArticleChunks(articleId: string): Promise<void> {
  await opensearch.deleteByQuery({
    index: config.indexes.chunks,
    body: { query: { term: { article_id: articleId } } },
    conflicts: 'proceed',
    refresh: true,
  } as any);
}

async function bulkIndexChunks(docs: any[]): Promise<void> {
  if (docs.length === 0) return;

  const body = docs.flatMap(doc => [
    { index: { _index: config.indexes.chunks, _id: doc.document_id } },
    doc,
  ]);

  const response = await opensearch.bulk({ refresh: false, body });
  if (response.body?.errors) {
    const firstError = (response.body.items ?? [])
      .map((item: any) => item.index?.error)
      .find(Boolean);
    throw new Error(
      `OpenSearch bulk chunk indexing completed with errors: ${JSON.stringify(firstError ?? {}).slice(0, 300)}`,
    );
  }
}

async function writeState(
  article: ArticleDoc,
  chunks: Chunk[],
  status: 'done' | 'pending' | 'error' | 'stale_version',
  summariesGenerated: number,
  questionsGenerated: number,
): Promise<void> {
  await opensearch.index({
    index: config.indexes.chunksState,
    id: article._id,
    body: {
      article_id: article._id,
      status,
      embed_version: config.embedding.version,
      chunk_count: chunks.length,
      summaries_generated: summariesGenerated,
      questions_generated: questionsGenerated,
      last_attempt: new Date().toISOString(),
      last_embedded_at: status === 'done' ? new Date().toISOString() : null,
      error: '',
    },
  });
}

async function writeErrorState(article: ArticleDoc, err: unknown): Promise<void> {
  await opensearch.index({
    index: config.indexes.chunksState,
    id: article._id,
    body: {
      article_id: article._id,
      status: 'error',
      embed_version: config.embedding.version,
      chunk_count: 0,
      summaries_generated: 0,
      questions_generated: 0,
      last_attempt: new Date().toISOString(),
      last_embedded_at: null,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

/** Map with at most `limit` promises in flight; preserves order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeNamedList(value: ArticleDoc['topics']): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
}
