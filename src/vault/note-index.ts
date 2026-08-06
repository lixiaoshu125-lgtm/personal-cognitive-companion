/**
 * Note Index — Phase 11
 *
 * Builds and searches a lightweight in-memory index of vault notes
 * using frontmatter metadata (concepts, summary, category) + filename.
 *
 * Replaces the slow O(N×readFile) vault search with O(N×stringMatch) index
 * search. With 7000+ notes, this is the difference between "instant" and
 * "tens of seconds per message".
 *
 * Key design:
 *  - Index entries are tiny (~200 bytes each) → 7000 entries ≈ 1.4 MB
 *  - Built once during vault scan, stored in PluginState, updated on rescan
 *  - Search matches against concepts + summary + title + category
 *  - Only reads full note content for the top-K matched entries
 */

import type { VaultAdapter } from "./adapter";

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface NoteIndexEntry {
  /** Relative vault path (e.g. "七年笔记MD文件/2024/xxx.md"). */
  readonly path: string;
  /** Display title — filename without .md extension. */
  readonly title: string;
  /** Frontmatter concepts array, joined as space-separated for matching. */
  readonly concepts: string;
  /** Frontmatter summary (one-liner). */
  readonly summary: string;
  /** Frontmatter category. */
  readonly category: string;
  /** Content hash for change detection. */
  readonly contentHash: string;
}

export interface NoteIndex {
  /** Schema version for migration. */
  readonly version: 1;
  /** All indexed entries. */
  readonly entries: readonly NoteIndexEntry[];
  /** ISO timestamp of last build. */
  readonly builtAt: string;
  /** Total note count at build time. */
  readonly totalNotes: number;
}

export interface NoteIndexMatch {
  readonly entry: NoteIndexEntry;
  /** Combined match score (concepts + summary + title). */
  readonly score: number;
  /** Which fields matched and how many times. */
  readonly matches: {
    readonly concepts: number;
    readonly summary: number;
    readonly title: number;
    readonly category: number;
  };
}

// ═══════════════════════════════════════════════════════════
// Frontmatter Parser (lightweight, zero-dependency)
// ═══════════════════════════════════════════════════════════

interface ParsedFrontmatter {
  concepts: string[];
  summary: string;
  category: string;
}

/**
 * Parse minimal frontmatter fields needed for indexing.
 * Only extracts: concepts, summary, category.
 * Returns empty defaults if no frontmatter or parse fails.
 */
export function parseNoteFrontmatter(content: string): ParsedFrontmatter {
  const defaults: ParsedFrontmatter = { concepts: [], summary: "", category: "" };

  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.startsWith("---\n")) return defaults;

  const lines = normalized.split("\n");
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd === -1) return defaults;

  const fmBody = lines.slice(1, fmEnd).join("\n");

  // Extract concepts array: concepts: ["a", "b"] or concepts: [a, b]
  const concepts: string[] = [];
  const conceptsMatch = fmBody.match(/^concepts:\s*\[(.+?)\]\s*$/m);
  if (conceptsMatch && conceptsMatch[1]) {
    // Split by comma, strip quotes and whitespace
    const items = conceptsMatch[1].split(",");
    for (const item of items) {
      const cleaned = item.trim().replace(/^["']|["']$/g, "");
      if (cleaned) concepts.push(cleaned);
    }
  }

  // Extract summary: summary: "text"
  let summary = "";
  const summaryMatch = fmBody.match(/^summary:\s*["']?(.+?)["']?\s*$/m);
  if (summaryMatch && summaryMatch[1]) {
    summary = summaryMatch[1].trim();
  }

  // Extract category: category: text
  let category = "";
  const catMatch = fmBody.match(/^category:\s*["']?(.+?)["']?\s*$/m);
  if (catMatch && catMatch[1]) {
    category = catMatch[1].trim();
  }

  return { concepts, summary, category };
}

// ═══════════════════════════════════════════════════════════
// Index Builder
// ═══════════════════════════════════════════════════════════

function noteDisplayName(notePath: string): string {
  const filename = notePath.split("/").pop() ?? notePath;
  return filename.replace(/\.md$/i, "");
}

/**
 * Build a NoteIndex from all .md files in the vault.
 *
 * For each file:
 *  1. Read content
 *  2. Parse frontmatter for concepts/summary/category
 *  3. Compute content hash
 *  4. Store as NoteIndexEntry
 *
 * Files without frontmatter still get indexed — their concepts/summary
 * will be empty and matching falls back to title matching.
 */
export async function buildNoteIndex(
  vaultAdapter: VaultAdapter,
  options?: {
    /** Paths to exclude from indexing. */
    readonly excludedPaths?: readonly string[] | undefined;
    /** Progress callback. */
    readonly onProgress?: ((current: number, total: number, path: string) => void) | undefined;
  },
): Promise<NoteIndex> {
  const excluded = new Set(options?.excludedPaths ?? []);
  const files = await vaultAdapter.listFiles();
  const mdFiles = files.filter(
    (f) => /\.md$/iu.test(f.path) && !excluded.has(f.path),
  );

  const entries: NoteIndexEntry[] = [];
  let processed = 0;

  for (const file of mdFiles) {
    processed++;
    options?.onProgress?.(processed, mdFiles.length, file.path);

    let content: string;
    try {
      content = await vaultAdapter.readText(file.path);
    } catch {
      // Skip unreadable files
      continue;
    }

    const fm = parseNoteFrontmatter(content);
    const title = noteDisplayName(file.path);

    // Compute simple content hash for change detection
    const contentHash = simpleHash(content.slice(0, 2000));

    entries.push({
      path: file.path,
      title,
      concepts: fm.concepts.join(" "),
      summary: fm.summary,
      category: fm.category,
      contentHash,
    });
  }

  return {
    version: 1,
    entries: Object.freeze(entries),
    builtAt: new Date().toISOString(),
    totalNotes: entries.length,
  };
}

// ═══════════════════════════════════════════════════════════
// Index Searcher
// ═══════════════════════════════════════════════════════════

/**
 * Search the note index for entries matching the given keywords.
 *
 * Scoring:
 *  - concepts match: 3 points per keyword hit
 *  - summary match: 2 points per keyword hit
 *  - title match: 2 points per keyword hit
 *  - category match: 1 point per keyword hit
 *
 * Returns results sorted by score descending.
 */
export function searchNoteIndex(
  index: NoteIndex,
  keywords: readonly string[],
  maxResults: number = 10,
): NoteIndexMatch[] {
  if (keywords.length === 0) return [];

  const results: NoteIndexMatch[] = [];

  for (const entry of index.entries) {
    let conceptsMatches = 0;
    let summaryMatches = 0;
    let titleMatches = 0;
    let categoryMatches = 0;

    const lowerConcepts = entry.concepts.toLowerCase();
    const lowerSummary = entry.summary.toLowerCase();
    const lowerTitle = entry.title.toLowerCase();
    const lowerCategory = entry.category.toLowerCase();

    for (const kw of keywords) {
      const lower = kw.toLowerCase();

      // Count occurrences in each field
      const cm = countMatches(lowerConcepts, lower);
      conceptsMatches += cm;

      const sm = countMatches(lowerSummary, lower);
      summaryMatches += sm;

      const tm = countMatches(lowerTitle, lower);
      titleMatches += tm;

      const catm = countMatches(lowerCategory, lower);
      categoryMatches += catm;
    }

    const score =
      conceptsMatches * 3 +
      summaryMatches * 2 +
      titleMatches * 2 +
      categoryMatches * 1;

    if (score > 0) {
      results.push({
        entry,
        score,
        matches: {
          concepts: conceptsMatches,
          summary: summaryMatches,
          title: titleMatches,
          category: categoryMatches,
        },
      });
    }
  }

  // Sort by score descending, then by path ascending (deterministic)
  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.entry.path.localeCompare(b.entry.path, "en");
  });

  return results.slice(0, maxResults);
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/** Simple fast string hash (djb2 variant) for change detection. */
function simpleHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ═══════════════════════════════════════════════════════════
// Factory for empty index
// ═══════════════════════════════════════════════════════════

export function createEmptyNoteIndex(): NoteIndex {
  return {
    version: 1,
    entries: [],
    builtAt: new Date().toISOString(),
    totalNotes: 0,
  };
}
