/**
 * Health server.
 *
 * Exposes `GET /health` for liveness probes (k8s, ECS, Docker Compose
 * healthcheck). Returns 200 once startup completes and stays 200 unless the
 * scheduler explicitly marks itself unhealthy (e.g. after N consecutive
 * tick failures).
 *
 * Kept separate from the main scheduler loop so the loop can be killed
 * without taking down the probe endpoint. Optional — disable via
 * HEALTH_SERVER_ENABLED=false.
 */

import http from 'http';
import { config } from './config';
import { logger } from './logger';

interface HealthState {
  ready: boolean;
  lastTickAt: Date | null;
  lastTickError: string | null;
  consecutiveFailures: number;
  articlesProcessedTotal: number;
  chunksWrittenTotal: number;
}

export const healthState: HealthState = {
  ready: false,
  lastTickAt: null,
  lastTickError: null,
  consecutiveFailures: 0,
  articlesProcessedTotal: 0,
  chunksWrittenTotal: 0,
};

export function markReady(): void {
  healthState.ready = true;
}

export function recordTickSuccess(articles: number, chunks: number): void {
  healthState.lastTickAt = new Date();
  healthState.lastTickError = null;
  healthState.consecutiveFailures = 0;
  healthState.articlesProcessedTotal += articles;
  healthState.chunksWrittenTotal += chunks;
}

export function recordTickFailure(err: unknown): void {
  healthState.lastTickAt = new Date();
  healthState.lastTickError = err instanceof Error ? err.message : String(err);
  healthState.consecutiveFailures += 1;
}

export function startHealthServer(): void {
  if (!config.health.enabled) {
    logger.info('health_server_disabled');
    return;
  }

  const server = http.createServer((req, res) => {
    if (!req.url) return;

    if (req.url === '/health' || req.url === '/healthz') {
      // Healthy until 5 consecutive failures
      const healthy = healthState.ready && healthState.consecutiveFailures < 5;
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'ok' : 'degraded',
        ...healthState,
      }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        articlesProcessedTotal: healthState.articlesProcessedTotal,
        chunksWrittenTotal: healthState.chunksWrittenTotal,
        consecutiveFailures: healthState.consecutiveFailures,
        lastTickAt: healthState.lastTickAt,
      }));
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(config.health.port, () => {
    logger.info({ port: config.health.port }, 'health_server_listening');
  });
}