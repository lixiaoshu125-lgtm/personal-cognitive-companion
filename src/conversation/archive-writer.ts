/**
 * Archive Writer — Task 09
 *
 * Persists ConversationArchive to Vault Markdown files.
 *
 * Key rules:
 *  - Structured data is the source of truth; Markdown is a safe human-readable view.
 *  - Failure returns explicit error — never silently swallowed.
 *  - Markdown output is fully escaped: no API keys, no absolute paths, no raw body text.
 */

import type { ConversationArchive } from "./archive";
import type { MarkdownFileSystem } from "../storage/markdown";
import { escapeMarkdownText, safeFrontmatter, validateWritePath, SYSTEM_OUTPUT_ROOT } from "../storage/markdown";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface ArchiveWriter {
  /**
   * Write an archive to a Vault Markdown file.
   * Structured data is the source of truth; Markdown is the safe human-readable view.
   * Failure returns an error result — never swallowed.
   */
  writeArchive(archive: ConversationArchive): Promise<ArchiveWriteResult>;

  /**
   * Retry a failed archive write.
   */
  retryArchive(conversationId: string): Promise<ArchiveWriteResult>;
}

export type ArchiveWriteResult =
  | { status: "written"; path: string }
  | { status: "retryable_error"; error: string }
  | { status: "fatal_error"; error: string };

// ═══════════════════════════════════════════════════════════════════
// Markdown Renderer
// ═══════════════════════════════════════════════════════════════════

const ARCHIVE_DIR = `${SYSTEM_OUTPUT_ROOT}/归档`;

/**
 * Render a ConversationArchive as a Markdown string.
 *
 * Safety requirements:
 *  - All body text is Markdown-escaped.
 *  - No API keys, absolute paths, or raw response bodies.
 *  - Frontmatter uses safe YAML escaping.
 */
export function renderArchiveMarkdown(archive: ConversationArchive): string {
  const frontmatter = safeFrontmatter({
    conversation_id: archive.conversation_id,
    seed_kind: archive.seed.kind,
    status: archive.status,
    end_reason: archive.end_reason,
    turn_count: archive.turns.length,
    has_wiki_conclusion: archive.wiki_conclusion !== null,
    vault_notes_referenced_count: archive.context_summary.vault_notes_referenced.length,
    created_at: archive.created_at,
    completed_at: archive.completed_at,
  });

  const lines: string[] = [
    frontmatter,
    "",
    "# 对话归档",
    "",
    `**对话 ID**: \`${archive.conversation_id}\``,
    `**类型**: ${escapeMarkdownText(seedLabel(archive))}`,
    `**结束方式**: ${escapeMarkdownText(endReasonLabel(archive.end_reason))}`,
    `**轮数**: ${archive.turns.length}`,
    `**Wiki 结论**: ${archive.wiki_conclusion ? "✅ 已生成" : "—"}`,
    `**创建时间**: ${archive.created_at}`,
    `**完成时间**: ${archive.completed_at}`,
    "",
    "---",
    "",
    "## 对话记录",
    "",
  ];

  if (archive.turns.length === 0) {
    lines.push("_（无对话记录）_", "");
  } else {
    for (const turn of archive.turns) {
      const roleLabel = turn.role === "user" ? "👤 用户" : turn.role === "assistant" ? "🤖 AI" : "⚙️ 系统";
      lines.push(
        `### ${roleLabel} — ${turn.timestamp}`,
        "",
        escapeMarkdownText(turn.text),
        "",
      );
    }
  }

  lines.push("---", "", "## 结论", "");

  if (!archive.wiki_conclusion) {
    if (archive.end_reason === "no_formal_result") {
      lines.push("_此对话无正式结论。_", "");
    } else {
      lines.push("_无结论。_", "");
    }
  } else {
    lines.push(escapeMarkdownText(archive.wiki_conclusion), "");
  }

  lines.push("## 引用的笔记", "");

  if (archive.context_summary.vault_notes_referenced.length === 0) {
    lines.push("_未引用 Vault 笔记。_", "");
  } else {
    for (const ref of archive.context_summary.vault_notes_referenced) {
      lines.push(`- [[${escapeMarkdownText(ref)}]]`, "");
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Labels (safe — no user text)
// ═══════════════════════════════════════════════════════════════════

function seedLabel(archive: ConversationArchive): string {
  switch (archive.seed.kind) {
    case "free_question":
      return "自由提问";
    case "current_note":
      return "当前笔记";
    case "weekly_topic":
      return "本周主题";
  }
}

function endReasonLabel(reason: string): string {
  switch (reason) {
    case "confirmed_results":
      return "确认结果";
    case "no_formal_result":
      return "无正式结论";
    default:
      return reason;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Vault Archive Writer
// ═══════════════════════════════════════════════════════════════════

/**
 * ArchiveWriter implementation backed by MarkdownFileSystem.
 *
 * Writes archives to `_个人认知系统/归档/<conversation_id>.md`.
 */
export class VaultArchiveWriter implements ArchiveWriter {
  private readonly archiveCache = new Map<string, ConversationArchive>();

  constructor(private readonly fs: MarkdownFileSystem) {}

  async writeArchive(archive: ConversationArchive): Promise<ArchiveWriteResult> {
    const path = `${ARCHIVE_DIR}/${archive.conversation_id}.md`;

    // Validate the path is safe to write
    try {
      validateWritePath(path, SYSTEM_OUTPUT_ROOT);
    } catch (err) {
      return {
        status: "fatal_error",
        error: `Archive path validation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Render markdown
    let markdown: string;
    try {
      markdown = renderArchiveMarkdown(archive);
    } catch (err) {
      return {
        status: "fatal_error",
        error: `Archive rendering failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Write to file system
    try {
      await this.fs.writeFile(path, markdown);
      this.archiveCache.set(archive.conversation_id, archive);
      return { status: "written", path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Determine if retryable (I/O errors) vs fatal (permission, disk full)
      if (isRetryableError(err)) {
        return { status: "retryable_error", error: message };
      }
      return { status: "fatal_error", error: message };
    }
  }

  async retryArchive(conversationId: string): Promise<ArchiveWriteResult> {
    const archive = this.archiveCache.get(conversationId);
    if (!archive) {
      return {
        status: "fatal_error",
        error: `Cannot retry: no cached archive for conversation ${conversationId}`,
      };
    }
    return this.writeArchive(archive);
  }
}

/**
 * Heuristic: network/transient I/O errors are retryable;
 * permission/disk-full errors are fatal.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network/transient errors
    if (msg.includes("enet") || msg.includes("econn") || msg.includes("timeout") || msg.includes("eagain")) {
      return true;
    }
    // Permission/disk errors → fatal
    if (msg.includes("eacces") || msg.includes("eperm") || msg.includes("enospc") || msg.includes("enotdir")) {
      return false;
    }
  }
  // Default: retryable (err on the side of allowing retry)
  return true;
}
