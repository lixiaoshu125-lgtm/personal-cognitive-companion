/**
 * CognitiveContextService — builds a finite, relevant, traceable cognitive context
 * for a Conversation from MD notes and Wiki pages (note-driven PCC).
 *
 * Sources:
 *   1. Current Vault notes (non-excluded .md files) — deterministic keyword matching
 *   2. Wiki pages (files in wikiOutputDir) — deterministic keyword matching
 *   3. Current Conversation state (recent turns)
 *
 * Key constraints:
 *   - Deterministic: same input → same sorted output (no AI, no randomness)
 *   - Unicode-safe truncation (never splits surrogate pairs)
 *   - Exclusion rules (cc-exclude frontmatter + directory exclusion) are mandatory
 *   - No external embeddings, no AI calls, no cognitive-model access
 */

import type { Conversation } from "../conversation/model";
import type { VaultAdapter } from "../vault/adapter";
import type { ExcludeRules } from "./exclusion";
import { checkNoteExclusion } from "./exclusion";
import type { NoteIndex, NoteIndexMatch } from "../vault/note-index";
import { searchNoteIndex } from "../vault/note-index";

// ─── Supporting types ───

export interface ActiveGoalSummary {
  readonly goal_id: string;
  readonly text: string;
  readonly status: string;
}

export interface PendingFeedbackSummary {
  readonly experiment_id: string;
  readonly hypothesis: string;
  readonly action: string;
  readonly deadline: string;
}

// ═══════════════════════════════════════════════════════════════
// Public Types
// ═══════════════════════════════════════════════════════════════

export interface CognitiveContextOptions {
  /** Max vault note snippets to include. Default: 5 (strengthened from 3). */
  readonly maxVaultSnippets?: number;
  /** Max wiki page snippets to include. Default: 3. */
  readonly maxWikiSnippets?: number;
  /** Max total characters across all snippets. Default: 1200. */
  readonly maxSnippetChars?: number;
  /** Whether vault search is enabled by user. Default: true. */
  readonly includeVaultSearch?: boolean;
}

export interface CognitiveContextRequest {
  readonly conversation: Conversation;
  /** Current user input — used for relevance matching alongside conversation history. */
  readonly query?: string;
  readonly options?: CognitiveContextOptions;
}

export interface VaultSnippet {
  readonly note_id: string;
  /** Relative path (safe — no absolute paths exposed). */
  readonly note_path: string;
  /** Human-readable note title (derived from filename, stripped of .md). */
  readonly note_title: string;
  /** Unicode-safe truncated snippet text. */
  readonly snippet: string;
  readonly char_count: number;
  readonly excluded_reason?: string;
}

export interface WikiSnippet {
  readonly wiki_path: string;
  /** Extracted from frontmatter or filename. */
  readonly title: string;
  /** Unicode-safe truncated snippet text. */
  readonly snippet: string;
  readonly char_count: number;
}

export interface ExclusionRecord {
  readonly note_path: string;
  readonly reason: string;
}

export interface ContextMetadata {
  readonly vault_notes_scanned: number;
  readonly vault_notes_matched: number;
  readonly vault_notes_excluded: number;
  readonly wiki_pages_scanned: number;
  readonly wiki_pages_matched: number;
  readonly snippet_chars_used: number;
  readonly budget_exceeded: boolean;
}

export interface CognitiveContext {
  readonly vaultSnippets: readonly VaultSnippet[];
  readonly wikiSnippets: readonly WikiSnippet[];
  readonly exclusions: readonly ExclusionRecord[];
  readonly truncated: boolean;
  readonly metadata: ContextMetadata;

  /**
   * Current active goals (read-only, from GoalState).
   * Populated by the caller — CognitiveContextService does not fetch goals itself.
   */
  readonly activeGoals?: readonly ActiveGoalSummary[];

  /**
   * Validations waiting for user feedback (read-only).
   * Populated by the caller — CognitiveContextService does not fetch validations itself.
   */
  readonly pendingValidations?: readonly PendingFeedbackSummary[];
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MAX_VAULT_SNIPPETS = 5;
const DEFAULT_MAX_WIKI_SNIPPETS = 3;
const DEFAULT_MAX_SNIPPET_CHARS = 1200;
const MAX_TURNS_FOR_KEYWORDS = 10;

// Common English stop words to filter out from keyword extraction.
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "i", "you", "he",
  "she", "it", "we", "they", "me", "him", "her", "us", "them", "my",
  "your", "his", "its", "our", "their", "this", "that", "these", "those",
  "and", "or", "but", "not", "if", "then", "else", "when", "where",
  "why", "how", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "no", "only", "own", "same", "so", "than",
  "too", "very", "just", "about", "above", "after", "again", "against",
  "between", "into", "through", "during", "before", "after", "from",
  "with", "for", "of", "in", "on", "at", "to", "by",
]);

// ═══════════════════════════════════════════════════════════════
// Keyword Extraction
// ═══════════════════════════════════════════════════════════════

/**
 * Extract keywords from text sources (conversation turns + query).
 * Returns a deduplicated array preserving insertion order.
 *
 * Handles:
 *   - English words (3+ chars, filtered against stop words)
 *   - Chinese character sequences (2+ characters from Han script)
 *   - Combined alphanumeric tokens
 */
function extractKeywords(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  function add(word: string): void {
    const lower = word.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      keywords.push(lower);
    }
  }

  for (const text of texts) {
    if (!text) continue;

    // Extract Chinese character sequences (2+ consecutive Han characters).
    // Also generate 2-gram and 3-gram substrings for better partial matching.
    const hanMatches = text.match(/\p{Script=Han}{2,}/gu);
    if (hanMatches) {
      for (const m of hanMatches) {
        // Add the full sequence
        add(m);
        // Also add 2-gram and 3-gram substrings for partial matching
        if (m.length >= 2) {
          for (let i = 0; i <= m.length - 2; i++) {
            add(m.slice(i, i + 2));
          }
        }
        if (m.length >= 3) {
          for (let i = 0; i <= m.length - 3; i++) {
            add(m.slice(i, i + 3));
          }
        }
      }
    }

    // Extract English/alphabetic words (3+ chars)
    const wordMatches = text.match(/[a-zA-Z]{3,}/g);
    if (wordMatches) {
      for (const w of wordMatches) {
        const lower = w.toLowerCase();
        if (!STOP_WORDS.has(lower) && !seen.has(lower)) {
          seen.add(lower);
          keywords.push(lower);
        }
      }
    }
  }

  return keywords;
}

// ═══════════════════════════════════════════════════════════════
// Unicode-Safe Truncation
// ═══════════════════════════════════════════════════════════════

/**
 * Truncate text to at most `maxChars` Unicode code points.
 * Never splits a surrogate pair — uses Array.from() to iterate code points.
 *
 * @returns [truncated_text, was_truncated]
 */
function truncateUnicode(text: string, maxChars: number): [string, boolean] {
  if (maxChars <= 0) return ["", text.length > 0];
  const chars = [...text]; // Array.from() equivalent — code point safe
  if (chars.length <= maxChars) return [text, false];
  return [chars.slice(0, maxChars).join(""), true];
}

/**
 * Count Unicode code points in a string (surrogate-pair aware).
 */
function unicodeLength(text: string): number {
  return [...text].length;
}

/**
 * Extract a human-readable display name from a note path.
 * Strips directory prefix and .md extension.
 * E.g. "日记/2024-01-15.md" → "2024-01-15"
 */
function noteDisplayName(notePath: string): string {
  const filename = notePath.split("/").pop() ?? notePath;
  return filename.replace(/\.md$/i, "");
}

// ═══════════════════════════════════════════════════════════════
// Vault Search (Note Index powered — Phase 11)
// ═══════════════════════════════════════════════════════════════

interface VaultCandidate {
  note_id: string;
  note_path: string;
  note_title: string;
  snippet: string;
  match_count: number;
}

/**
 * Search vault notes for keyword matches using the pre-built NoteIndex.
 *
 * Phase 11: Instead of reading every .md file (O(N) file I/O), we search the
 * in-memory index (O(N) string comparison). Only the top-K matched notes
 * have their full content read for snippet extraction.
 *
 * Falls back to empty results when no index is available.
 */
async function searchVault(
  vaultAdapter: VaultAdapter,
  excludeRules: ExcludeRules,
  keywords: readonly string[],
  noteIndex: NoteIndex | null,
): Promise<{
  candidates: VaultCandidate[];
  exclusions: ExclusionRecord[];
  notesScanned: number;
}> {
  const exclusions: ExclusionRecord[] = [];

  if (!noteIndex || noteIndex.entries.length === 0 || keywords.length === 0) {
    return { candidates: [], exclusions, notesScanned: noteIndex?.totalNotes ?? 0 };
  }

  // ── 1. Search the index (instant — no file I/O) ─────────
  const indexMatches: NoteIndexMatch[] = searchNoteIndex(
    noteIndex,
    keywords,
    30, // Find top 30 candidates from index, then read their content
  );

  // ── 2. Read content only for matched notes ──────────────
  const candidates: VaultCandidate[] = [];

  for (const match of indexMatches) {
    const entry = match.entry;

    // Check exclusion
    let content: string;
    try {
      content = await vaultAdapter.readText(entry.path);
    } catch {
      continue;
    }

    const exclusion = checkNoteExclusion(excludeRules, entry.path, content);
    if (exclusion.excluded) {
      exclusions.push({ note_path: entry.path, reason: exclusion.reason });
      continue;
    }

    // Extract matching lines as snippet context
    const matchLines: string[] = [];
    for (const line of content.split("\n")) {
      const lowerLine = line.toLowerCase();
      for (const kw of keywords) {
        if (lowerLine.includes(kw.toLowerCase())) {
          matchLines.push(line.trim());
          break;
        }
      }
      if (matchLines.length >= 8) break;
    }

    const snippet = matchLines.length > 0
      ? matchLines.join("\n")
      : entry.summary || content.slice(0, 200);

    candidates.push({
      note_id: entry.path,
      note_path: entry.path,
      note_title: entry.title,
      snippet,
      match_count: match.score,
    });
  }

  // ── 3. Sort by score descending, then path ascending ────
  candidates.sort((a, b) => {
    if (a.match_count !== b.match_count) return b.match_count - a.match_count;
    return a.note_path.localeCompare(b.note_path, "en");
  });

  return {
    candidates,
    exclusions,
    notesScanned: noteIndex.totalNotes,
  };
}

// ═══════════════════════════════════════════════════════════════
// Wiki Search
// ═══════════════════════════════════════════════════════════════

interface WikiCandidate {
  wiki_path: string;
  title: string;
  snippet: string;
  match_count: number;
}

/**
 * Search wiki pages in wikiOutputDir for keyword matches.
 * Extracts title from frontmatter `title:` or `topic:` field, falling back to filename.
 * Returns candidates sorted deterministically by match count desc, then path asc.
 */
async function searchWiki(
  vaultAdapter: VaultAdapter,
  wikiOutputDir: string,
  keywords: readonly string[],
): Promise<{ candidates: WikiCandidate[]; pagesScanned: number }> {
  const candidates: WikiCandidate[] = [];
  let pagesScanned = 0;

  // Normalize wiki dir: strip leading/trailing slashes
  const wikiDir = wikiOutputDir.replace(/^\/+|\/+$/g, "");

  let files: readonly { path: string }[];
  try {
    files = await vaultAdapter.listFiles();
  } catch {
    return { candidates, pagesScanned: 0 };
  }

  for (const file of files) {
    // Only .md files within the wiki directory
    if (!/\.md$/iu.test(file.path)) continue;
    if (!file.path.startsWith(wikiDir + "/") && file.path !== wikiDir) continue;

    let content: string;
    try {
      content = await vaultAdapter.readText(file.path);
    } catch {
      continue;
    }

    pagesScanned++;

    if (keywords.length === 0) continue;

    // Extract title from frontmatter
    let title = file.path.replace(/^.*[\\/]/, "").replace(/\.md$/i, "");
    const fmMatch = content.match(
      /^---\s*\n(.*?)\n---/s,
    );
    if (fmMatch && fmMatch[1]) {
      const fm = fmMatch[1];
      const titleMatch = fm.match(/^(?:title|topic):\s*(.+)$/m);
      if (titleMatch && titleMatch[1]) {
        title = titleMatch[1].trim();
      }
    } else {
      // Try to extract from first # heading
      const headingMatch = content.match(/^#\s+(.+)$/m);
      if (headingMatch && headingMatch[1]) {
        title = headingMatch[1].trim();
      }
    }

    // Keyword matching
    const lowerContent = content.toLowerCase();
    let matchCount = 0;
    const matchLines: string[] = [];

    for (const line of content.split("\n")) {
      const lowerLine = line.toLowerCase();
      let lineMatches = 0;
      for (const kw of keywords) {
        if (lowerLine.includes(kw)) {
          lineMatches++;
          matchCount++;
        }
      }
      if (lineMatches > 0 && matchLines.length < 8) {
        matchLines.push(line.trim());
      }
    }

    if (matchCount > 0) {
      candidates.push({
        wiki_path: file.path,
        title,
        snippet: matchLines.join("\n"),
        match_count: matchCount,
      });
    }
  }

  // Deterministic sort: match count descending, then path ascending
  candidates.sort((a, b) => {
    if (a.match_count !== b.match_count) return b.match_count - a.match_count;
    return a.wiki_path.localeCompare(b.wiki_path, "en");
  });

  return { candidates, pagesScanned };
}

// ═══════════════════════════════════════════════════════════════
// Main Builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build cognitive context from vault notes, wiki pages, and conversation.
 *
 * Pure retrieval — no AI calls, no embeddings, no cognitive-model access.
 * Vault notes are the primary retrieval source; wiki pages supplement with
 * previously distilled conclusions.
 */
export async function buildCognitiveContext(
  request: CognitiveContextRequest,
  vaultAdapter: VaultAdapter,
  excludeRules: ExcludeRules,
  noteIndex: NoteIndex | null,
  wikiOutputDir?: string,
): Promise<CognitiveContext> {
  const opts: Required<CognitiveContextOptions> = {
    maxVaultSnippets: request.options?.maxVaultSnippets ?? DEFAULT_MAX_VAULT_SNIPPETS,
    maxWikiSnippets: request.options?.maxWikiSnippets ?? DEFAULT_MAX_WIKI_SNIPPETS,
    maxSnippetChars: request.options?.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS,
    includeVaultSearch: request.options?.includeVaultSearch ?? true,
  };

  // ── 1. Extract keywords from conversation + query ──────────
  const turnTexts = request.conversation.turns
    .slice(-MAX_TURNS_FOR_KEYWORDS)
    .map((t) => t.text);
  const queryTexts = request.query ? [request.query] : [];
  const keywords = extractKeywords([...turnTexts, ...queryTexts]);

  // ── 2. Search vault notes (primary retrieval source) ──────
  let vaultSnippets: VaultSnippet[] = [];
  let vaultExclusions: ExclusionRecord[] = [];
  let vaultNotesScanned = 0;
  let vaultNotesMatched = 0;

  if (opts.includeVaultSearch && keywords.length > 0) {
    const result = await searchVault(vaultAdapter, excludeRules, keywords, noteIndex);
    vaultExclusions = result.exclusions;
    vaultNotesScanned = result.notesScanned;
    vaultNotesMatched = result.candidates.length;

    // Apply budget: truncate snippets and limit count
    let charsUsed = 0;
    for (const candidate of result.candidates.slice(0, opts.maxVaultSnippets)) {
      const remaining = opts.maxSnippetChars - charsUsed;
      if (remaining <= 0) break;

      const [truncatedSnippet] = truncateUnicode(candidate.snippet, remaining);
      const actualLength = unicodeLength(truncatedSnippet);
      charsUsed += actualLength;

      vaultSnippets.push({
        note_id: candidate.note_id,
        note_path: candidate.note_path,
        note_title: noteDisplayName(candidate.note_path),
        snippet: truncatedSnippet,
        char_count: actualLength,
      });
    }
  } else if (opts.includeVaultSearch && keywords.length === 0) {
    // No keywords to search with — count notes but don't match
    try {
      const files = await vaultAdapter.listFiles();
      vaultNotesScanned = files.filter((f) => /\.md$/iu.test(f.path)).length;
    } catch {
      vaultNotesScanned = 0;
    }
  }

  // ── 3. Search wiki pages ──────────────────────────────────
  let wikiSnippets: WikiSnippet[] = [];
  let wikiPagesScanned = 0;
  let wikiPagesMatched = 0;
  let charsUsed = vaultSnippets.reduce((sum, s) => sum + s.char_count, 0);

  if (wikiOutputDir && keywords.length > 0) {
    const wikiResult = await searchWiki(vaultAdapter, wikiOutputDir, keywords);
    wikiPagesScanned = wikiResult.pagesScanned;
    wikiPagesMatched = wikiResult.candidates.length;

    for (const candidate of wikiResult.candidates.slice(0, opts.maxWikiSnippets)) {
      const remaining = opts.maxSnippetChars - charsUsed;
      if (remaining <= 0) break;

      const [truncatedSnippet] = truncateUnicode(candidate.snippet, remaining);
      const actualLength = unicodeLength(truncatedSnippet);
      charsUsed += actualLength;

      wikiSnippets.push({
        wiki_path: candidate.wiki_path,
        title: candidate.title,
        snippet: truncatedSnippet,
        char_count: actualLength,
      });
    }
  }

  // ── 4. Compute metadata ──────────────────────────────────
  const totalChars = [...vaultSnippets, ...wikiSnippets].reduce(
    (sum, s) => sum + s.char_count,
    0,
  );
  const budgetExceeded = totalChars >= opts.maxSnippetChars;

  const metadata: ContextMetadata = {
    vault_notes_scanned: vaultNotesScanned,
    vault_notes_matched: vaultNotesMatched,
    vault_notes_excluded: vaultExclusions.length,
    wiki_pages_scanned: wikiPagesScanned,
    wiki_pages_matched: wikiPagesMatched,
    snippet_chars_used: totalChars,
    budget_exceeded: budgetExceeded,
  };

  return {
    vaultSnippets,
    wikiSnippets,
    exclusions: vaultExclusions,
    truncated:
      budgetExceeded ||
      vaultNotesMatched > opts.maxVaultSnippets ||
      wikiPagesMatched > opts.maxWikiSnippets,
    metadata,
  };
}
