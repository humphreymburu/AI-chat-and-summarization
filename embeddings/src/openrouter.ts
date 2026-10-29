/**
 * OpenRouter client for the embeddings worker: document embeddings (Qwen3)
 * and the short LLM calls that write each chunk's summary/questions views.
 *
 * Embeddings must match the RAG backend's query embeddings (same model, same
 * dimension, raw text with no instruction prefix) or kNN scores are meaningless.
 */

import axios, { AxiosError } from 'axios';
import { config } from './config';
import { logger } from './logger';

const MAX_ATTEMPTS = 4;

function client() {
  if (!config.openrouter.apiKey) {
    throw new Error('OPENROUTER_API_KEY is required when EMBEDDING_PROVIDER=openrouter');
  }
  return axios.create({
    baseURL: config.openrouter.baseUrl.replace(/\/$/, ''),
    timeout: 60_000,
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
  });
}

function isRetryable(err: unknown): boolean {
  const status = (err as AxiosError)?.response?.status;
  // No status = network error or timeout.
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

async function postWithRetry<T>(path: string, body: unknown): Promise<T> {
  const http = client();
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await http.post<T>(path, body);
      return response.data;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) {
        const status = (err as AxiosError)?.response?.status;
        const detail = JSON.stringify((err as AxiosError)?.response?.data ?? '').slice(0, 300);
        throw new Error(`OpenRouter ${path} failed (status ${status ?? 'none'}): ${detail || String(err)}`);
      }
      const delayMs = 1000 * 2 ** (attempt - 1);
      logger.warn({ path, attempt, delayMs }, 'openrouter_retry');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

/** Embed texts in batches; returns one vector per input, in order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  const batchSize = config.openrouter.embeddingBatchSize;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const data = await postWithRetry<{ data?: Array<{ index: number; embedding: number[] }> }>(
      '/embeddings',
      {
        model: config.openrouter.embeddingModel,
        input: batch,
        dimensions: config.embedding.dimension,
      },
    );

    const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
    if (rows.length !== batch.length) {
      throw new Error(`Embedding count mismatch: sent ${batch.length}, got ${rows.length}`);
    }
    for (const row of rows) {
      if (row.embedding.length !== config.embedding.dimension) {
        throw new Error(
          `Embedding dimension mismatch: expected ${config.embedding.dimension}, got ${row.embedding.length}`,
        );
      }
      vectors.push(row.embedding);
    }
  }

  return vectors;
}

/** Single-turn completion; returns the trimmed text. */
export async function completeText(prompt: string, maxTokens = 300): Promise<string> {
  const data = await postWithRetry<{ choices?: Array<{ message?: { content?: string } }> }>(
    '/chat/completions',
    {
      model: config.openrouter.viewsModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.2,
    },
  );
  return (data.choices?.[0]?.message?.content ?? '').trim();
}
