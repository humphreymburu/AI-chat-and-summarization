import { config } from './config';
import { logger } from './logger';
import { processPendingBatch, startupHealthCheck } from './embeddingPipeline';

async function main(): Promise<void> {
  await startupHealthCheck();

  const limit = Number(process.argv[2] ?? config.scheduler.batchSize);
  logger.info({ limit }, 'backfill_start');

  // One flaky article (API timeout, malformed HTML, ...) must not abort the
  // whole batch — processPendingBatch logs it to chunks_state and continues.
  const result = await processPendingBatch(limit);

  logger.info(result, 'backfill_complete');
  if (result.articlesFailed > 0) {
    logger.warn({ articlesFailed: result.articlesFailed }, 'backfill_had_failures');
  }
}

main().catch(err => {
  logger.error({ err }, 'backfill_failed');
  process.exit(1);
});
