import { config } from './config';
import { logger } from './logger';
import {
  fetchPendingArticles,
  processArticle,
  startupHealthCheck,
} from './embeddingPipeline';
import type { ProcessArticleResult } from './embeddingPipeline';

async function main(): Promise<void> {
  await startupHealthCheck();

  const limit = Number(process.argv[2] ?? config.scheduler.batchSize);
  const articles = await fetchPendingArticles(limit);

  logger.info({ articles: articles.length }, 'backfill_start');

  let chunksWritten = 0;
  for (const article of articles) {
    const result: ProcessArticleResult = await processArticle(article);
    chunksWritten += result.chunksWritten;
    logger.info({ articleId: article._id, chunks: result.chunksWritten }, 'backfill_article_complete');
  }

  logger.info({ articles: articles.length, chunksWritten }, 'backfill_complete');
}

main().catch(err => {
  logger.error({ err }, 'backfill_failed');
  process.exit(1);
});
