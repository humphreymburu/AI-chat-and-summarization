import { Chunk } from './chunker';

export interface ChunkViews {
  summary: string;
  questions: string[];
  has_summary: boolean;
  has_questions: boolean;
}

export function shouldGenerateSummary(chunk: Chunk): boolean {
  return chunk.token_count >= 200;
}

export function shouldGenerateQuestions(chunk: Chunk): boolean {
  return chunk.token_count >= 150;
}

export function buildSummaryPrompt(chunk: Chunk): string {
  return [
    'Summarize this UNEP article section in one concise institutional sentence.',
    '',
    chunk.text,
  ].join('\n');
}

export function buildQuestionsPrompt(chunk: Chunk): string {
  return [
    'Write 2-3 natural-language questions this UNEP article section answers.',
    'Return only the questions, one per line.',
    '',
    chunk.text,
  ].join('\n');
}

export function emptyViewsFor(chunk: Chunk): ChunkViews {
  return {
    summary: '',
    questions: [],
    has_summary: shouldGenerateSummary(chunk),
    has_questions: shouldGenerateQuestions(chunk),
  };
}
