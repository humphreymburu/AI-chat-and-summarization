/**
 * Structured logger.
 *
 * Uses pino — fast, JSON-by-default, plays well with log aggregators.
 * Switch to `pino-pretty` in dev for human-readable output:
 *
 *   npm install --save-dev pino-pretty
 *   LOG_LEVEL=debug npm run dev | npx pino-pretty
 */

import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.log.level,
  base: { service: 'embedding-service' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});
