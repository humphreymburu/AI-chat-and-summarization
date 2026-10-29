import { Chunk } from './chunker';
import { completeText } from './openrouter';

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
    'Respond with only that sentence, no preamble.',
    '',
    chunk.text,
  ].join('\n');
}

export function buildQuestionsPrompt(chunk: Chunk): string {
  return [
    'Write 2-3 natural-language questions this UNEP article section answers.',
    'Return only the questions, one per line, with no numbering or preamble.',
    '',
    chunk.text,
  ].join('\n');
}

/** No views. Flags stay false so retrieval never trusts an empty view. */
export function emptyViewsFor(_chunk: Chunk): ChunkViews {
  return {
    summary: '',
    questions: [],
    has_summary: false,
    has_questions: false,
  };
}

/** Strip list markers/numbering and keep lines that read like questions. */
export function parseQuestions(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(line => line.length > 10 && line.endsWith('?'))
    .slice(0, 3);
}

/** Generate the summary/questions views a chunk qualifies for. */
export async function generateViews(chunk: Chunk): Promise<ChunkViews> {
  if (chunk.low_content) return emptyViewsFor(chunk);

  const [summary, questions] = await Promise.all([
    shouldGenerateSummary(chunk) ? completeText(buildSummaryPrompt(chunk), 200) : Promise.resolve(''),
    shouldGenerateQuestions(chunk)
      ? completeText(buildQuestionsPrompt(chunk), 300).then(parseQuestions)
      : Promise.resolve([] as string[]),
  ]);

  return {
    summary,
    questions,
    has_summary: summary.length > 0,
    has_questions: questions.length > 0,
  };
}
