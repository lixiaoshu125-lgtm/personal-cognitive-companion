/**
 * Exclusion rules for the CognitiveContextService.
 *
 * Determines which vault notes should be excluded from context retrieval.
 * Rules are evaluated in priority order:
 *   1. System paths (internal Obsidian directories)
 *   2. Directory exclusion (user-configured excluded directories)
 *   3. Frontmatter cc-exclude flag (per-note opt-out)
 *
 * All checks are pure, synchronous functions — no I/O, no AI.
 */

// ─── Types ──────────────────────────────────────────────────

export interface ExcludeRules {
  readonly excludedDirs: readonly string[];
  checkNote(note: { path: string; frontmatter?: Record<string, unknown> }): ExclusionResult;
}

export type ExclusionResult =
  | { excluded: false }
  | { excluded: true; reason: ExclusionReason };

export type ExclusionReason =
  | "cc_exclude_frontmatter"
  | "excluded_directory"
  | "system_path";

// ─── Default system paths ───────────────────────────────────

const SYSTEM_PATH_PREFIXES = [
  ".obsidian/",
  ".trash/",
  ".git/",
  "node_modules/",
  "_个人认知系统/",
] as const;

/** Paths considered internal and always excluded, regardless of user config.
 *  These are exact directory matches (not prefix-based). */
const SYSTEM_PATH_EXACT: readonly string[] = [];

// ─── Path helpers ───────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isWithinFolder(filePath: string, folder: string): boolean {
  const p = normalizePath(filePath).toLowerCase();
  const f = normalizePath(folder).toLowerCase().replace(/\/$/, "");
  return p === f || p.startsWith(f + "/");
}

// ─── Factory ────────────────────────────────────────────────

/**
 * Create an ExcludeRules instance with the given user-configured
 * directory exclusions. System paths are always excluded regardless.
 */
export function createExcludeRules(userExcludedDirs: readonly string[] = []): ExcludeRules {
  const normalized = userExcludedDirs.map(normalizePath).filter((d) => d.length > 0);

  return {
    excludedDirs: normalized,

    checkNote(note: { path: string; frontmatter?: Record<string, unknown> }): ExclusionResult {
      const notePath = normalizePath(note.path);

      // 1. System path check (always excluded)
      for (const prefix of SYSTEM_PATH_PREFIXES) {
        if (isWithinFolder(notePath, prefix)) {
          return { excluded: true, reason: "system_path" };
        }
      }
      for (const exact of SYSTEM_PATH_EXACT) {
        if (isWithinFolder(notePath, exact)) {
          return { excluded: true, reason: "system_path" };
        }
      }

      // 2. User-configured directory exclusion
      for (const dir of normalized) {
        if (isWithinFolder(notePath, dir)) {
          return { excluded: true, reason: "excluded_directory" };
        }
      }

      // 3. Frontmatter cc-exclude check
      if (note.frontmatter !== undefined) {
        const ccExclude = note.frontmatter["cc-exclude"];
        // Accept boolean true or string "true"
        if (ccExclude === true || ccExclude === "true") {
          return { excluded: true, reason: "cc_exclude_frontmatter" };
        }
      }

      return { excluded: false };
    },
  };
}

// ─── Frontmatter parser (minimal, zero-dependency) ──────────

/**
 * Parse YAML frontmatter from raw note content.
 * Returns undefined if no valid frontmatter block is found.
 * This is a minimal parser — it only handles top-level scalar/boolean values,
 * which is sufficient for the cc-exclude check.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  if (!normalized.startsWith("---\n")) return undefined;

  const lines = normalized.split("\n");
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd === -1) return undefined;

  const fmBody = lines.slice(1, fmEnd).join("\n");
  const result: Record<string, unknown> = {};

  for (const line of fmBody.split("\n")) {
    const match = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) {
      const key = match[1]!;
      const value = match[2]!;
      // Parse boolean
      if (value === "true") result[key] = true;
      else if (value === "false") result[key] = false;
      // Parse number
      else if (/^-?\d+(\.\d+)?$/.test(value)) result[key] = Number(value);
      // Parse quoted string
      else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        result[key] = value.slice(1, -1);
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

// ─── Content-based exclusion (convenience wrapper) ──────────

/**
 * Check if a note should be excluded based on both its path and content.
 * This is a convenience function that first checks path-based rules,
 * then reads frontmatter from content to check cc-exclude.
 */
export function checkNoteExclusion(
  rules: ExcludeRules,
  notePath: string,
  noteContent: string,
): ExclusionResult {
  // First check path-based rules (system + directory)
  const pathCheck = rules.checkNote({ path: notePath });
  if (pathCheck.excluded) return pathCheck;

  // Then check frontmatter for cc-exclude
  const frontmatter = parseFrontmatter(noteContent);
  if (frontmatter !== undefined) {
    return rules.checkNote({ path: notePath, frontmatter });
  }
  return { excluded: false };
}
