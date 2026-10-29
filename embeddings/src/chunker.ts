/**
 * UNEP article chunker.
 *
 * Pure function: (article HTML + metadata) → Chunk[].
 * No OpenSearch, no LLM, no embedding calls.
 *
 * Strategy (per design doc Section 5):
 *   1. HTML cleanup
 *   2. Boilerplate section detection and removal
 *   3. Primary split on <hr>, <h2>, <h3>
 *   4. Secondary split by token count
 *   5. Heading propagation into chunk.text
 *
 * Dependencies (install in conversational-embedding):
 *   - cheerio        HTML parsing
 *   - js-tiktoken    Token counting (sync, no WASM)
 */

import * as cheerio from 'cheerio';
import { getEncoding } from 'js-tiktoken';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArticleDoc {
  _id: string;
  title: string;
  body: string;
  langcode?: string;
  publication_date?: string;
  path?: string;
  site_name?: string;
  topics?: Array<{ name: string }> | string[];
  country?: Array<{ name: string }> | string[];
  story_type?: Array<{ name: string; id?: string }> | string[];
  uuid?: string;
  nid?: string;
}

export interface Chunk {
  /** What gets embedded: title + heading + body */
  text: string;
  /** Chunk prose only — used for lexical (BM25) match */
  body: string;
  /** The <h2>/<h3> this chunk came from, or empty string */
  section_heading: string;
  /** 0-based index of this chunk within the article */
  chunk_index: number;
  /** Token count of body (for monitoring; uses tiktoken approximation) */
  token_count: number;
  /** True if total cleaned text was very short and likely image-heavy */
  low_content: boolean;
}

export interface ChunkerOptions {
  targetTokens?: number;       // default 400
  maxTokens?: number;          // default 600
  minTokens?: number;          // default 100
  overlapTokens?: number;      // default 50
  maxChunksPerArticle?: number; // default 20
  /** If total cleaned tokens fall below this, flag low_content: true */
  lowContentThreshold?: number; // default 100
  /** Heuristic: heading followed by < N tokens of body is decorative */
  decorativeHeadingThreshold?: number; // default 50
  /** Boilerplate detection: links-to-text ratio above which a section is dropped */
  boilerplateLinkRatio?: number; // default 0.6
  /** Boilerplate detection: max section tokens to be considered boilerplate */
  boilerplateMaxTokens?: number; // default 200
}

const DEFAULTS: Required<ChunkerOptions> = {
  targetTokens: 400,
  maxTokens: 600,
  minTokens: 100,
  overlapTokens: 50,
  maxChunksPerArticle: 20,
  lowContentThreshold: 100,
  decorativeHeadingThreshold: 50,
  boilerplateLinkRatio: 0.6,
  boilerplateMaxTokens: 200,
};

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

// cl100k_base is close enough to Qwen3's tokenizer for sizing decisions.
// For Chinese/Arabic content, plan to swap in a language-specific counter
// in a future iteration (see design doc Section 12.1).
const tokenizer = getEncoding('cl100k_base');

export function countTokens(text: string): number {
  if (!text) return 0;
  return tokenizer.encode(text).length;
}

// ---------------------------------------------------------------------------
// Section type used internally
// ---------------------------------------------------------------------------

interface Section {
  heading: string;
  body: string;
  linkTokens: number;   // tokens that were inside <a> tags
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function chunkArticle(
  article: ArticleDoc,
  options: ChunkerOptions = {}
): Chunk[] {
  const opts = { ...DEFAULTS, ...options };

  // 1. Parse and extract sections from HTML
  const rawSections = extractSections(article.body || '');

  // 2. Drop boilerplate
  const sections = rawSections.filter(s => !isBoilerplate(s, opts));

  // Check for low-content article
  const totalTokens = sections.reduce((s, sec) => s + sec.totalTokens, 0);
  const isLowContent = totalTokens < opts.lowContentThreshold;

  // 3. Apply primary + secondary split rules
  const chunks: Chunk[] = [];
  let buffered: Section | null = null;

  for (const section of sections) {
    if (section.totalTokens < opts.minTokens) {
      // Too small → buffer for merging
      buffered = buffered ? mergeSections(buffered, section) : section;
      continue;
    }

    // Flush any buffered small section by merging it into this one
    const working = buffered ? mergeSections(buffered, section) : section;
    buffered = null;

    if (working.totalTokens <= opts.maxTokens) {
      // Fits within size cap → one chunk
      chunks.push(buildChunk(article, working, chunks.length, isLowContent));
    } else {
      // Too large → secondary token-based split
      const subChunks = splitByTokens(
        working.body,
        opts.targetTokens,
        opts.maxTokens,
        opts.overlapTokens
      );
      for (const sub of subChunks) {
        chunks.push(
          buildChunk(
            article,
            { heading: working.heading, body: sub, linkTokens: 0, totalTokens: countTokens(sub) },
            chunks.length,
            isLowContent
          )
        );
      }
    }
  }

  // Trailing buffered small section that never got merged
  if (buffered) {
    if (chunks.length > 0) {
      // Merge into the last chunk instead of making a tiny standalone one
      const last = chunks[chunks.length - 1];
      const mergedBody = `${last.body}\n\n${buffered.body}`.trim();
      chunks[chunks.length - 1] = {
        ...last,
        body: mergedBody,
        text: composeText(article.title, last.section_heading, mergedBody),
        token_count: countTokens(mergedBody),
      };
    } else {
      // No prior chunks → emit it on its own even if small
      chunks.push(buildChunk(article, buffered, 0, isLowContent));
    }
  }

  // Safety cap — truncate if chunker went haywire
  if (chunks.length > opts.maxChunksPerArticle) {
    console.warn(
      `[chunker] article ${article._id} produced ${chunks.length} chunks ` +
      `(cap ${opts.maxChunksPerArticle}); truncating`
    );
    return chunks.slice(0, opts.maxChunksPerArticle);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// HTML cleanup and section extraction
// ---------------------------------------------------------------------------

/**
 * Parse the article HTML and return a list of sections.
 * Sections are split on <hr>, <h2>, <h3>. Headings are captured.
 * Returns sections with cleaned plain-text body and link-token tracking.
 */
function extractSections(html: string): Section[] {
  if (!html.trim()) return [];

  // Cheerio gives us a jQuery-like API over HTML
  const $ = cheerio.load(html, { decodeEntities: true });

  // Remove elements we never want
  $('script, style, nav, footer, aside').remove();
  $('img').remove();
  $('figure').remove();

  // Tables → flat prose
  $('table').each((_, el) => {
    const rows: string[] = [];
    $(el).find('tr').each((__, tr) => {
      const cells: string[] = [];
      $(tr).find('th, td').each((___, cell) => {
        cells.push($(cell).text().trim());
      });
      if (cells.length) rows.push(cells.join(': '));
    });
    $(el).replaceWith(`<p>${rows.join('. ')}</p>`);
  });

  // Lists → plain text paragraphs
  $('ul, ol').each((_, el) => {
    const items: string[] = [];
    $(el).find('li').each((__, li) => {
      const text = $(li).text().trim();
      if (text) items.push(`- ${text}`);
    });
    $(el).replaceWith(`<p>${items.join('\n')}</p>`);
  });

  // Now walk top-level content and split into sections on <hr>, <h2>, <h3>
  // We work with the body's serialized HTML to handle inline link tracking.
  const sections: Section[] = [];
  let currentHeading = '';
  let currentParts: string[] = [];
  let currentLinkChars = 0;

  const flush = () => {
    const rawText = currentParts.join('\n\n');
    const cleaned = collapseWhitespace(rawText);
    if (cleaned.trim().length === 0) {
      currentParts = [];
      currentLinkChars = 0;
      return;
    }
    const totalTokens = countTokens(cleaned);
    // Estimate link tokens by ratio of link characters to total characters
    const linkTokens = cleaned.length > 0
      ? Math.round((currentLinkChars / cleaned.length) * totalTokens)
      : 0;
    sections.push({
      heading: currentHeading,
      body: cleaned,
      linkTokens,
      totalTokens,
    });
    currentParts = [];
    currentLinkChars = 0;
  };

  // Walk article/body children so headings and <hr> remain visible as split
  // boundaries. Cheerio wraps fragments under <html><body>, so $.root()
  // would otherwise hide the useful top-level content one level down.
  const topLevelNodes = $('body').length > 0 ? $('body').contents() : $.root().contents();

  topLevelNodes.each((_, node) => {
    if (node.type === 'tag') {
      const tag = ((node as any).tagName || '').toLowerCase();

      if (tag === 'hr') {
        flush();
        currentHeading = '';
        return;
      }

      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        flush();
        currentHeading = $(node).text().trim();
        return;
      }

      // For paragraphs and other content nodes:
      // Extract text and count characters that came from <a> tags
      const linkChars = $(node).find('a').toArray()
        .reduce((sum, a) => sum + ($(a).text() || '').length, 0);
      currentLinkChars += linkChars;
      const text = $(node).text().replace(/\s+/g, ' ').trim();
      if (text) currentParts.push(text);
    } else if (node.type === 'text') {
      const text = ((node as any).data || '').replace(/\s+/g, ' ').trim();
      if (text) currentParts.push(text);
    }
  });

  flush();
  return sections;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Boilerplate detection
// ---------------------------------------------------------------------------

function isBoilerplate(section: Section, opts: Required<ChunkerOptions>): boolean {
  if (section.totalTokens === 0) return true;
  if (section.totalTokens >= opts.boilerplateMaxTokens) return false;
  const linkRatio = section.linkTokens / section.totalTokens;
  return linkRatio > opts.boilerplateLinkRatio;
}

// ---------------------------------------------------------------------------
// Section merging
// ---------------------------------------------------------------------------

function mergeSections(a: Section, b: Section): Section {
  // Prefer the longer heading; if equal, keep `a`'s
  const heading = b.heading && (!a.heading || b.heading.length > a.heading.length)
    ? b.heading
    : a.heading;
  const body = `${a.body}\n\n${b.body}`.trim();
  return {
    heading,
    body,
    linkTokens: a.linkTokens + b.linkTokens,
    totalTokens: countTokens(body),
  };
}

// ---------------------------------------------------------------------------
// Secondary split by tokens
// ---------------------------------------------------------------------------

function splitByTokens(
  text: string,
  target: number,
  maxSize: number,
  overlap: number
): string[] {
  // Split by paragraphs (double newline) first
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = countTokens(para);

    // Single paragraph larger than maxSize → sentence-split it
    if (paraTokens > maxSize) {
      // Flush whatever we had
      if (current.length) {
        chunks.push(current.join('\n\n'));
        current = [];
        currentTokens = 0;
      }
      const sentenceChunks = splitParagraphBySentences(para, target, maxSize, overlap);
      chunks.push(...sentenceChunks);
      continue;
    }

    // Adding this paragraph keeps us under maxSize?
    if (currentTokens + paraTokens <= maxSize) {
      current.push(para);
      currentTokens += paraTokens;
      continue;
    }

    // Adding would overflow → flush, start new chunk with overlap from last
    if (current.length > 0) {
      chunks.push(current.join('\n\n'));
      const overlapText = takeLastTokens(current.join('\n\n'), overlap);
      current = overlapText ? [overlapText, para] : [para];
      currentTokens = countTokens(current.join('\n\n'));
    } else {
      // This is the first paragraph and it fits within maxSize but we
      // had no buffer — just start fresh with it
      current = [para];
      currentTokens = paraTokens;
    }
  }

  if (current.length) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}

function splitParagraphBySentences(
  paragraph: string,
  target: number,
  maxSize: number,
  overlap: number
): string[] {
  // Lightweight sentence split. Good enough for English/Western text.
  // Per-language sentence boundaries are deferred to v2 (design doc 12.1).
  const sentences = paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .filter(s => s.trim().length > 0);

  if (sentences.length <= 1) {
    // Can't split sensibly — return as-is (chunker may exceed maxSize, but
    // it's better than splitting mid-sentence)
    return [paragraph];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sent of sentences) {
    const sentTokens = countTokens(sent);
    if (currentTokens + sentTokens <= maxSize) {
      current.push(sent);
      currentTokens += sentTokens;
    } else {
      if (current.length) {
        chunks.push(current.join(' '));
        const overlapText = takeLastTokens(current.join(' '), overlap);
        current = overlapText ? [overlapText, sent] : [sent];
        currentTokens = countTokens(current.join(' '));
      } else {
        current = [sent];
        currentTokens = sentTokens;
      }
    }
  }

  if (current.length) {
    chunks.push(current.join(' '));
  }

  return chunks;
}

function takeLastTokens(text: string, n: number): string {
  if (n <= 0) return '';
  const tokens = tokenizer.encode(text);
  if (tokens.length <= n) return text;
  const last = tokens.slice(-n);
  return tokenizer.decode(last);
}

// ---------------------------------------------------------------------------
// Chunk construction
// ---------------------------------------------------------------------------

function buildChunk(
  article: ArticleDoc,
  section: Section,
  index: number,
  lowContent: boolean
): Chunk {
  const body = section.body.trim();
  return {
    text: composeText(article.title, section.heading, body),
    body,
    section_heading: section.heading || '',
    chunk_index: index,
    token_count: countTokens(body),
    low_content: lowContent,
  };
}

function composeText(title: string, heading: string, body: string): string {
  const parts: string[] = [];
  if (title?.trim()) parts.push(title.trim());
  if (heading?.trim()) parts.push(heading.trim());
  parts.push(body);
  return parts.join('\n\n');
}
