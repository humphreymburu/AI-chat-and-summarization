import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { ArticleDoc, Chunk, chunkArticle } from './chunker';
import { config } from './config';
import { logger } from './logger';
import { emptyViewsFor } from './prompts';

export interface ProcessArticleResult {
  articleId: string;
  chunksWritten: number;
  summariesGenerated: number;
  questionsGenerated: number;
  elapsedMs: number;
}

export interface TickResult {
  articlesProcessed: number;
  chunksWritten: number;
}

const opensearch = new OpenSearchClient({
  node: config.opensearch.url,
  auth: {
    username: config.opensearch.username,
    password: config.opensearch.password,
  },
});

export async function startupHealthCheck(): Promise<void> {
  await opensearch.ping();
}

export async function fetchPendingArticles(limit = config.scheduler.batchSize): Promise<ArticleDoc[]> {
  const response = await opensearch.search({
    index: config.indexes.articles,
    body: {
      size: limit,
      sort: [{ publication_date: { order: 'desc', unmapped_type: 'date' } }],
      _source: [
        'title',
        'body',
        'langcode',
        'publication_date',
        'path',
        'site_name',
        'topics',
        'country',
        'story_type',
        'uuid',
        'nid',
      ],
      query: {
        bool: {
          filter: [
            { term: { langcode: config.source.langcode } },
            { terms: { type: config.source.contentTypes } },
          ],
          must_not: [
            { term: { embedded: true } },
          ],
        },
      },
    },
  });

  const hits = response.body?.hits?.hits ?? [];
  return hits.map((hit: any) => ({
    _id: hit._id,
    title: hit._source?.title ?? '',
    body: hit._source?.body ?? '',
    langcode: hit._source?.langcode,
    publication_date: hit._source?.publication_date,
    path: hit._source?.path,
    site_name: hit._source?.site_name,
    topics: hit._source?.topics,
    country: hit._source?.country,
    story_type: hit._source?.story_type,
    uuid: hit._source?.uuid,
    nid: hit._source?.nid,
  }));
}

export async function processArticle(article: ArticleDoc): Promise<ProcessArticleResult> {
  const startedAt = Date.now();
  const chunks = chunkArticle(article, config.chunker);

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

  const docs = chunks.map((chunk, index) => toChunkDocument(article, chunk, chunks.length, index));
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

export async function runVectorizationTick(): Promise<TickResult> {
  const articles = await fetchPendingArticles();
  let chunksWritten = 0;

  for (const article of articles) {
    try {
      const result = await processArticle(article);
      chunksWritten += result.chunksWritten;
      logger.info({ articleId: article._id, chunks: result.chunksWritten }, 'article_processed');
    } catch (err) {
      logger.error({ articleId: article._id, err }, 'article_failed');
      await writeErrorState(article, err);
    }
  }

  return {
    articlesProcessed: articles.length,
    chunksWritten,
  };
}

function toChunkDocument(article: ArticleDoc, chunk: Chunk, chunkTotal: number, index: number) {
  const views = emptyViewsFor(chunk);
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
    has_summary: views.has_summary,
    has_questions: views.has_questions,
    low_content: chunk.low_content,
    token_count: chunk.token_count,
    embed_version: config.embedding.version,
    embedding: zeroVector(),
    summary_embedding: zeroVector(),
    questions_embedding: zeroVector(),
    document_id: `${article._id}:${index}`,
  };
}

async function bulkIndexChunks(docs: any[]): Promise<void> {
  if (docs.length === 0) return;

  const body = docs.flatMap(doc => [
    { index: { _index: config.indexes.chunks, _id: doc.document_id } },
    doc,
  ]);

  const response = await opensearch.bulk({ refresh: false, body });
  if (response.body?.errors) {
    throw new Error('OpenSearch bulk chunk indexing completed with errors');
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

function normalizeNamedList(value: ArticleDoc['topics']): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
}

function zeroVector(): number[] {
  return Array(config.embedding.dimension).fill(0);
}
