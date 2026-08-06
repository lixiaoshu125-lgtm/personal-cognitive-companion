/**
 * Wiki Page Generator — Phase 6
 *
 * Generates a Wiki `.md` page from a conversation conclusion.
 * The page lives alongside user notes in the same Vault, connected
 * via Obsidian [[wikilink]] bidirectional links.
 *
 * Key design:
 *  - Wiki pages go into a configurable output directory (default: _Wiki/).
 *  - Each page has YAML frontmatter + conclusion body + [[关联笔记]] list.
 *  - Filename is a slug of the title to avoid filesystem issues.
 *  - Idempotent: generating the same title twice overwrites (update semantics).
 */

import type { MarkdownFileSystem } from "../storage/markdown";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface WikiGenerationParams {
  /** Wiki page title (becomes the H1 and filename). */
  readonly title: string;
  /** The distilled conclusion text (Markdown — will be rendered as-is). */
  readonly conclusion: string;
  /** Related note paths for [[wikilink]] generation.
   *  Each entry: [notePath, annotation] — annotation is a one-line note on why it's linked. */
  readonly relatedNotes: ReadonlyArray<{
    readonly notePath: string;
    readonly annotation: string;
  }>;
  /** Output directory relative to vault root (default: _Wiki). */
  readonly outputDir: string;
}

export interface WikiGenerationResult {
  /** The relative path of the generated Wiki file. */
  readonly path: string;
  /** The full markdown content written. */
  readonly content: string;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Sanitize a title into a safe filename slug. */
function slugify(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")   // Windows-illegal chars → dash
    .replace(/\s+/g, "-")            // whitespace → dash
    .replace(/-{2,}/g, "-")          // collapse dashes
    .replace(/^-|-$/g, "")           // trim leading/trailing dash
    .slice(0, 120);                  // reasonable max length
}

/** Generate YAML frontmatter for a Wiki page. */
function buildFrontmatter(title: string, createdAt: string): string {
  return [
    "---",
    "type: wiki",
    `topic: "${title.replace(/"/g, '\\"')}"`,
    `created: ${createdAt}`,
    "---",
    "",
  ].join("\n");
}

/**
 * Extract the display name from a note path.
 * E.g. "日记/2024-01-15.md" → "2024-01-15"
 */
function noteDisplayName(notePath: string): string {
  const filename = notePath.split("/").pop() ?? notePath;
  return filename.replace(/\.md$/i, "");
}

/** Build the [[关联笔记]] section with annotated wikilinks. */
function buildRelatedNotesSection(
  notes: ReadonlyArray<{ notePath: string; annotation: string }>,
): string {
  if (notes.length === 0) return "";

  const lines = ["## 关联笔记", ""];
  for (const { notePath, annotation } of notes) {
    const name = noteDisplayName(notePath);
    if (annotation) {
      lines.push(`- [[${name}]] — ${annotation}`);
    } else {
      lines.push(`- [[${name}]]`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a Wiki page and write it to the vault via the given filesystem.
 *
 * The generated file:
 *   {outputDir}/{slugified-title}.md
 *
 * Contains:
 *   - YAML frontmatter (type: wiki, topic, created)
 *   - # {title}
 *   - ## 结论 — conclusion body
 *   - ## 关联笔记 — [[wikilink]] list with annotations
 */
export async function generateWikiPage(
  params: WikiGenerationParams,
  fs: MarkdownFileSystem,
  clock: () => Date = () => new Date(),
): Promise<WikiGenerationResult> {
  const { title, conclusion, relatedNotes, outputDir } = params;

  const createdAt = clock().toISOString().split("T")[0]!; // YYYY-MM-DD
  const slug = slugify(title);
  const dir = outputDir.replace(/\/+$/u, ""); // strip trailing slash
  const relativePath = `${dir}/${slug}.md`;

  // Build markdown
  const frontmatter = buildFrontmatter(title, createdAt);
  const body = [
    `# ${title}`,
    "",
    "## 结论",
    "",
    conclusion.trim(),
    "",
    buildRelatedNotesSection(relatedNotes),
  ].join("\n");

  const content = frontmatter + body;

  // Write via filesystem
  await fs.writeFile(relativePath, content);

  return { path: relativePath, content };
}

/**
 * Build the markdown content without writing to disk.
 * Useful for previews or testing.
 */
export function buildWikiContent(params: WikiGenerationParams, clock: () => Date = () => new Date()): string {
  const { title, conclusion, relatedNotes } = params;
  const createdAt = clock().toISOString().split("T")[0]!;

  const frontmatter = buildFrontmatter(title, createdAt);
  const body = [
    `# ${title}`,
    "",
    "## 结论",
    "",
    conclusion.trim(),
    "",
    buildRelatedNotesSection(relatedNotes),
  ].join("\n");

  return frontmatter + body;
}
