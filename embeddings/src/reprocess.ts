/**
 * Manually reprocess a single article by ID.
 *
 * Usage:
 *   npm run reprocess -- <article_id>
 *   npm run reprocess -- 12345
 *
 * Used for:
 *   - Debugging chunker output on a known problem article
 *   - Forcing a re-embed after fixing a content issue
 *   - One-off tests of prompt changes
 *
 * Does NOT update chunks_state — call from scheduler if you want
 * state tracking.
 */

import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { config } from './config';
import { logger } from './logger';
import { processArticle, startupHealthCheck } from './embeddingPipeline';
import { ArticleDoc } from './chunker';

async function main(): Promise<void> {
  const articleId = process.argv[2];
  if (!articleId) {
    console.error('Usage: npm run reprocess -- <article_id>');
    process.exit(1);
  }

  await startupHealthCheck();

  const opensearch = new OpenSearchClient({
    node: config.opensearch.url,
    auth: {
      username: config.opensearch.username,
      password: config.opensearch.password,
    },
  });

  logger.info({ articleId }, 'reprocess_start');

  const response = await opensearch.get({
    index: config.indexes.articles,
    id: articleId,
  });

  const article = response.body._source as ArticleDoc;
  article._id = articleId;

  const result = await processArticle(article);

  logger.info({
    articleId,
    chunks: result.chunksWritten,
    summariesGenerated: result.summariesGenerated,
    questionsGenerated: result.questionsGenerated,
    elapsedMs: result.elapsedMs,
  }, 'reprocess_complete');
}

main().catch(err => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reprocess_failed');
  process.exit(1);
});