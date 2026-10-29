import { startHealthServer, markReady, recordTickFailure, recordTickSuccess } from './health';
import { config } from './config';
import { logger } from './logger';
import { runVectorizationTick, startupHealthCheck } from './embeddingPipeline';

let running = false;
let timer: NodeJS.Timeout | null = null;

async function runTick(): Promise<void> {
  if (running) {
    logger.warn('vectorization_tick_skipped_already_running');
    return;
  }

  running = true;
  try {
    const result = await runVectorizationTick();
    recordTickSuccess(result.articlesProcessed, result.chunksWritten);
    logger.info(result, 'vectorization_tick_complete');
  } catch (err) {
    recordTickFailure(err);
    logger.error({ err }, 'vectorization_tick_failed');
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  startHealthServer();
  await startupHealthCheck();
  markReady();

  if (!config.scheduler.enabled) {
    logger.info('scheduler_disabled');
    return;
  }

  await runTick();
  timer = setInterval(runTick, config.scheduler.intervalMs);
  logger.info({ intervalMs: config.scheduler.intervalMs }, 'scheduler_started');
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'scheduler_stopping');
  if (timer) clearInterval(timer);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
  logger.error({ err }, 'scheduler_start_failed');
  process.exit(1);
});
