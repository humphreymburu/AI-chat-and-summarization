import * as dotenv from 'dotenv';

dotenv.config();

function readString(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalString(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

export const config = {
  log: {
    level: readOptionalString('LOG_LEVEL', 'info'),
  },
  health: {
    enabled: readBoolean('HEALTH_SERVER_ENABLED', true),
    port: readNumber('HEALTH_PORT', 8081),
  },
  scheduler: {
    enabled: readBoolean('SCHEDULER_ENABLED', true),
    intervalMs: readNumber('SCHEDULER_INTERVAL_MS', 120_000),
    batchSize: readNumber('BATCH_SIZE', 10),
  },
  chunker: {
    targetTokens: readNumber('CHUNK_TARGET_TOKENS', 400),
    maxTokens: readNumber('CHUNK_MAX_TOKENS', 600),
    minTokens: readNumber('CHUNK_MIN_TOKENS', 100),
    overlapTokens: readNumber('CHUNK_OVERLAP_TOKENS', 50),
    maxChunksPerArticle: readNumber('MAX_CHUNKS_PER_ARTICLE', 20),
  },
  opensearch: {
    url: readString('OPENSEARCH_URL', process.env.OPENSEARCH_SERVICE_URL),
    username: readString('OPENSEARCH_USER', process.env.OPENSEARCH_USER_NAME ?? 'admin'),
    password: readString('OPENSEARCH_PASS', process.env.OPENSEARCH_PASSWORD),
  },
  indexes: {
    articles: readString('ARTICLES_INDEX', process.env.OPEN_SEARCH_INDEX ?? 'v5'),
    chunks: readString('CHUNKS_INDEX', 'chunks_v1'),
    chunksState: readString('CHUNKS_STATE_INDEX', 'chunks_state'),
    chunksAlias: readString('CHUNKS_ALIAS', 'chunks_current'),
  },
  embedding: {
    version: readString('EMBED_VERSION', 'qwen3-8b_1024_chunked-multivec_v1'),
    dimension: readNumber('EMBEDDING_DIMENSION', 1024),
    provider: readOptionalString('EMBEDDING_PROVIDER', 'stub'),
  },
  source: {
    langcode: readOptionalString('SOURCE_LANGCODE', 'en'),
    contentTypes: readList('SOURCE_CONTENT_TYPES', [
      'article',
      'resource',
      'press_release',
      'technical_highlight',
      'report_flagship',
    ]),
  },
};

export type AppConfig = typeof config;
