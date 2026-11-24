import { decodeConfig } from '@/lib/blog-content/graphics/encode';
import type { GraphicConfig } from '@/lib/blog-content/graphics/types';
import { sanitizeBlogHtml } from '@/lib/sanitize-blog-html';
import { renderGraphic } from '@/lib/blog-content/graphics/render';

// Token classification for text comparison:
// - 'added': Substring present in the newer revision but absent from the older baseline (rendered in emerald).
// - 'removed': Substring present in the older baseline but deleted in the newer revision (rendered in rose / line-through).
// - 'unchanged': Substring identical across both versions (rendered with normal neutral typography).
export type DiffTokenType = 'added' | 'removed' | 'unchanged';

// Atomic unit of a diff sequence associating a continuous string slice with its change status.
export interface DiffToken {
  type: DiffTokenType;
  text: string;
}

// Structured comparison outcome for an individual content model property (e.g., title, excerpt, metadata).
// Carries change flag, stringified values, token array for highlighting, and word-level addition/deletion counts.
export interface FieldDiffResult {
  isChanged: boolean;
  oldValue: string;
  newValue: string;
  tokens: DiffToken[];
  additions: number;
  deletions: number;
}

// Splits continuous prose into alternating sequences of non-whitespace words (\S+) and whitespace characters (\s+).
// Why: Standard String.prototype.split(' ') strips trailing spaces, indentation, and newlines.
// Matching /\S+|\s+/g preserves all layout formatting and spaces so tokens can be reassembled with zero character loss.
export function tokenizeWords(text: string): string[] {
  if (!text) return [];
  return text.match(/\S+|\s+/g) || [];
}

// Line-level Longest Common Subsequence (LCS) diff algorithm.
// Serves as an O(N*M) fallback for large multi-thousand-word documents when word-level matrix computation
// would exceed memory/performance budgets.
export function computeLineDiff(oldText: string, newText: string): DiffToken[] {
  // Normalize empty or undefined inputs and decompose text into newline-delimited rows.
  const linesOld = (oldText || '').split('\n');
  const linesNew = (newText || '').split('\n');
  const n = linesOld.length;
  const m = linesNew.length;

  // Short-circuit: When both inputs are strictly identical, return a single unchanged token in O(1) time.
  if (oldText === newText) {
    return oldText ? [{ type: 'unchanged', text: oldText }] : [];
  }

  // DP Matrix initialization: dp[i][j] stores the length of the longest common line subsequence between linesOld[0..i-1] and linesNew[0..j-1].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (linesOld[i - 1] === linesNew[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtracking path traversal: Walk backwards from bottom-right (n, m) to top-left (0, 0)
  // to construct the edit script of additions, deletions, and unchanged line blocks.
  const result: DiffToken[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesOld[i - 1] === linesNew[j - 1]) {
      // Diagonal step: Line exists in both versions unchanged.
      result.unshift({ type: 'unchanged', text: linesOld[i - 1] + (i < n ? '\n' : '') });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Horizontal step: Line was added in the newer version.
      result.unshift({ type: 'added', text: linesNew[j - 1] + (j < m ? '\n' : '') });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      // Vertical step: Line was removed from the older version.
      result.unshift({ type: 'removed', text: linesOld[i - 1] + (i < n ? '\n' : '') });
      i--;
    }
  }

  // Merge contiguous tokens of identical status to minimize DOM nodes in the UI.
  return mergeDiffTokens(result);
}

// Word-level Longest Common Subsequence (LCS) diff algorithm.
// Produces granular word-by-word highlights for titles, excerpts, descriptions, and body paragraphs.
export function computeWordDiff(oldText: string, newText: string): DiffToken[] {
  // Convert text into word and whitespace tokens.
  const a = tokenizeWords(oldText || '');
  const b = tokenizeWords(newText || '');
  const n = a.length;
  const m = b.length;

  // Trivial edge cases: identical content, blank source, or blank destination.
  if (oldText === newText) {
    return oldText ? [{ type: 'unchanged', text: oldText }] : [];
  }
  if (n === 0) {
    return m > 0 ? [{ type: 'added', text: newText }] : [];
  }
  if (m === 0) {
    return n > 0 ? [{ type: 'removed', text: oldText }] : [];
  }

  // Circuit breaker: If token product exceeds 200,000 operations (e.g. comparing two 10,000-word articles),
  // drop to line-level diffing to prevent browser thread freeze and heap exhaustion.
  if (n * m > 200000) {
    return computeLineDiff(oldText, newText);
  }

  // DP Matrix: Allocates (n + 1) x (m + 1) table tracking longest common token sub-sequence.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtracking path reconstruction: Step backwards from (n, m) to (0, 0).
  const result: DiffToken[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      // Matching word: Unchanged.
      result.unshift({ type: 'unchanged', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Word present in new revision only: Added.
      result.unshift({ type: 'added', text: b[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      // Word present in old revision only: Removed.
      result.unshift({ type: 'removed', text: a[i - 1] });
      i--;
    }
  }

  // Consolidate adjacent tokens of identical type into unified string blocks.
  return mergeDiffTokens(result);
}

// Token compaction: Combines consecutive tokens of identical DiffTokenType.
// Why: Backtracking outputs one token per word/space. Rendering 1,000 individual <span> elements
// bloats the React virtual DOM; merging adjacent tokens collapses them to a fraction of DOM nodes.
export function mergeDiffTokens(tokens: DiffToken[]): DiffToken[] {
  const merged: DiffToken[] = [];
  for (const token of tokens) {
    if (merged.length > 0 && merged[merged.length - 1].type === token.type) {
      merged[merged.length - 1].text += token.text;
    } else {
      merged.push({ ...token });
    }
  }
  return merged;
}

// HTML Tag Stripper: Normalizes rich text HTML (e.g. Quill/DOM markup) into clean plain text prose.
// Why: Comparing raw HTML strings introduces noise from opening/closing tags (<p>, <strong>, etc.).
// Stripping tags allows editors to evaluate editorial wording changes rather than markup differences.
export function stripHtmlTags(input: string): string {
  if (!input) return '';
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Balanced HTML Parser for embedded Quill blog graphic widgets.
// Recursively tracks nested <div> depth so that the entire outer container (including all inner
// stat cards, comparison columns, and callout boxes) is cleanly replaced without leaving
// orphaned inner tags that cause duplicate ghost card rendering in the preview.
export function replaceBlogGraphics(
  html: string,
  replacer: (config: GraphicConfig, fullMatch: string) => string,
): string {
  if (!html) return '';

  let result = '';
  let i = 0;

  const divOpenRegex = /<div\b/gi;
  const divCloseRegex = /<\/div\s*>/gi;

  while (i < html.length) {
    divOpenRegex.lastIndex = i;
    const matchOpen = divOpenRegex.exec(html);
    if (!matchOpen) {
      result += html.slice(i);
      break;
    }

    const openIdx = matchOpen.index;
    result += html.slice(i, openIdx);

    // Find end of this <div...> opening tag
    const openTagEnd = html.indexOf('>', openIdx);
    if (openTagEnd === -1) {
      result += html.slice(openIdx);
      break;
    }

    const openTag = html.slice(openIdx, openTagEnd + 1);
    const isBlogGraphic = openTag.includes('data-config');

    if (!isBlogGraphic) {
      result += openTag;
      i = openTagEnd + 1;
      continue;
    }

    // Extract data-config attribute
    const configMatch = openTag.match(/data-config=["']([^"']+)["']/i);
    const encoded = configMatch ? configMatch[1] : '';

    // Walk forward tracking nested <div> and </div> until depth reaches 0
    let depth = 1;
    let curr = openTagEnd + 1;

    while (curr < html.length && depth > 0) {
      divOpenRegex.lastIndex = curr;
      divCloseRegex.lastIndex = curr;

      const nextOpen = divOpenRegex.exec(html);
      const nextClose = divCloseRegex.exec(html);

      if (!nextClose) {
        // Tag was unclosed; consume rest
        curr = html.length;
        break;
      }

      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        curr = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        curr = nextClose.index + nextClose[0].length;
      }
    }

    const fullMatch = html.slice(openIdx, curr);
    try {
      const config = decodeConfig(encoded);
      if (config) {
        result += replacer(config, fullMatch);
      } else {
        result += fullMatch;
      }
    } catch {
      result += fullMatch;
    }

    i = curr;
  }

  return result;
}

// Visual Body HTML Hydrator:
// Sanitizes incoming historical or draft HTML at the presentation boundary before injection,
// and replaces embedded graphic configs into visual components using balanced HTML div parsing.
// Neutralizes hostile markup (e.g. script injection, onerror handlers, dangerous protocols) at rendering boundary.
export function renderVisualBodyHtml(rawHtml: string): string {
  if (!rawHtml || !rawHtml.trim()) {
    return '<p class="text-stone-400 italic">No content</p>';
  }

  // Defensive sanitization: Neutralizes malicious tags, inline event listeners, and dangerous protocols
  // even if legacy or third-party database records bypassed previous write filters.
  const cleanHtml = sanitizeBlogHtml(rawHtml);

  return replaceBlogGraphics(cleanHtml, (config) => {
    return `<div class="blog-graphic my-4" data-graphic="${config.type}">${renderGraphic({ ...config, animate: false })}</div>`;
  });
}

// Structured HTML to Text Converter.
// Unlike naive tag stripping which squashes all text into a single line, this converter
// preserves paragraph breaks, table columns and rows, and provides human-readable summaries
// for embedded graphic cards (stat cards, callouts, comparisons).
export function htmlToStructuredText(input: string): string {
  if (!input) return '';

  // 1. Convert graphic blocks to clean readable summaries using balanced tag replacement
  let text = replaceBlogGraphics(input, (config) => {
    if (config.type === 'stat-cards') {
      const stats = config.cards
        .map((c) => `${c.prefix || ''}${c.number}${c.suffix || ''} ${c.label}`)
        .join(' | ');
      return `\n[Stat Cards: ${stats}]\n`;
    }
    if (config.type === 'callout') {
      const eyebrow = config.eyebrow ? `${config.eyebrow.toUpperCase()}: ` : '';
      return `\n[Callout: ${eyebrow}${config.text}]\n`;
    }
    if (config.type === 'comparison') {
      const col0 = config.columns?.[0] ? `${config.columns[0].heading}: ${config.columns[0].points.join(', ')}` : '';
      const col1 = config.columns?.[1] ? `${config.columns[1].heading}: ${config.columns[1].points.join(', ')}` : '';
      return `\n[Comparison: (${col0}) vs (${col1})]\n`;
    }
    return '';
  });

  // 2. Convert embedded media (images and video iframes) into structured tokens
  // preserving URLs and descriptive alt text for meaningful diffing and change detection.
  text = text.replace(/<img\b[^>]*>/gi, (match) => {
    const srcMatch = match.match(/\bsrc=["']([^"']+)["']/i);
    const altMatch = match.match(/\balt=["']([^"']*)["']/i);
    const src = srcMatch ? srcMatch[1] : '';
    const alt = altMatch ? altMatch[1].trim() : '';
    if (alt && src) return `\n[Image: ${alt} (${src})]\n`;
    if (src) return `\n[Image: ${src}]\n`;
    if (alt) return `\n[Image: ${alt}]\n`;
    return `\n[Image]\n`;
  });

  text = text.replace(/<iframe\b(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>(?:[\s\S]*?<\/iframe>)?|<iframe\b(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*\/>/gi, (_match, src1, src2) => {
    const src = src1 || src2 || '';
    return `\n[Video: ${src}]\n`;
  });

  text = text.replace(/<video\b(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>(?:[\s\S]*?<\/video>)?|<video\b(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*\/>/gi, (_match, src1, src2) => {
    const src = src1 || src2 || '';
    return `\n[Video: ${src}]\n`;
  });

  // 3. Format tables: separate cells with ' | ' and rows with newlines
  text = text.replace(/<\/td>\s*<td[^>]*>/gi, ' | ');
  text = text.replace(/<\/th>\s*<th[^>]*>/gi, ' | ');
  text = text.replace(/<\/tr>/gi, '\n');

  // 3. Convert block level elements and line breaks to newlines
  text = text.replace(/<(?:p|h[1-6]|li|blockquote|pre|tr|br)[^>]*>/gi, '');
  text = text.replace(/<\/(?:p|h[1-6]|li|blockquote|pre|tr)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 4. Strip any remaining HTML tags
  text = text.replace(/<[^>]*>/g, ' ');

  // 5. Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // 6. Normalize whitespace: keep newlines, collapse multiple spaces per line
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');

  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// High-level diff adapter for any document property.
// Accepts raw values, handles null/undefined coercion, runs word diffing, and calculates addition/deletion stats.
export function computeFieldDiff(oldVal: unknown, newVal: unknown): FieldDiffResult {
  // Coerce undefined or null values into empty strings.
  const oldStr = oldVal === undefined || oldVal === null ? '' : String(oldVal);
  const newStr = newVal === undefined || newVal === null ? '' : String(newVal);

  const isChanged = oldStr !== newStr;
  const tokens = isChanged ? computeWordDiff(oldStr, newStr) : [{ type: 'unchanged' as const, text: oldStr }];

  let additions = 0;
  let deletions = 0;

  // Calculate actual word metrics rather than internal whitespace tokens for human-friendly stats (+3 added / -1 removed).
  // Matching \S+ ensures we count real words and ignore whitespace tokens, giving accurate metrics on UI chips.
  for (const token of tokens) {
    const wordCount = (token.text.match(/\S+/g) || []).length;
    if (token.type === 'added') {
      additions += wordCount;
    } else if (token.type === 'removed') {
      deletions += wordCount;
    }
  }

  return {
    isChanged,
    oldValue: oldStr,
    newValue: newStr,
    tokens,
    additions,
    deletions,
  };
}

// Helper to parse any representation (ISO string, Date object, local YYYY-MM-DDTHH:mm string)
// into true epoch milliseconds with time-zone resolution.
export function normalizeDateToEpoch(val: unknown, timeZone?: string): number {
  if (!val) return 0;
  const str = String(val).trim();
  if (!str) return 0;
  const tz = timeZone && timeZone.trim() ? timeZone.trim() : 'UTC';

  // ISO strings ending with Z or explicit +/- timezone offsets are parsed directly as UTC instants.
  if (str.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(str)) {
    const parsed = Date.parse(str);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Local datetime strings without timezone (e.g. '2026-11-30T09:00' or '2026-11-30 09:00').
  try {
    const normalized = str.includes('T') ? str : str.replace(' ', 'T');
    const target = Date.parse(`${normalized.slice(0, 16)}:00Z`);
    if (Number.isFinite(target)) {
      let instant = target;
      for (let i = 0; i < 3; i++) {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date(instant));
        const p = (name: string) => parts.find((item) => item.type === name)?.value || '';
        const observed = Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:00Z`);
        instant += target - observed;
      }
      return instant;
    }
  } catch {
    // Fallback if custom timezone is not supported
  }

  const fallback = Date.parse(str);
  return Number.isFinite(fallback) ? fallback : 0;
}

// Date/time difference calculator with time-zone normalization.
// Resolves disparities between UTC database timestamps (e.g. '2026-11-30T03:30:00.000Z')
// and editor local form datetime values (e.g. '2026-11-30T09:00' in Asia/Kolkata).
export function computeDateTimeDiff(
  oldVal: unknown,
  newVal: unknown,
  timeZone?: string,
): FieldDiffResult {
  const tz = timeZone && timeZone.trim() ? timeZone.trim() : 'UTC';

  const oldEpoch = normalizeDateToEpoch(oldVal, tz);
  const newEpoch = normalizeDateToEpoch(newVal, tz);

  const formatDisplay = (val: unknown, epoch: number): string => {
    if (!val || !epoch) return '';
    const d = new Date(epoch);
    try {
      return d.toLocaleString('en-US', {
        timeZone: tz,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
  };

  const isChanged = oldEpoch !== newEpoch;
  const oldFormatted = formatDisplay(oldVal, oldEpoch);
  const newFormatted = formatDisplay(newVal, newEpoch);

  return {
    isChanged,
    oldValue: oldFormatted,
    newValue: newFormatted,
    tokens: isChanged
      ? computeWordDiff(oldFormatted, newFormatted)
      : [{ type: 'unchanged', text: oldFormatted }],
    additions: isChanged ? 1 : 0,
    deletions: isChanged ? 1 : 0,
  };
}
