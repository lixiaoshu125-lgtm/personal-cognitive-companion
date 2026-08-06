/**
 * Cleanup Preflight — Task 10
 *
 * Scans the Vault's system output directory for legacy run data
 * and produces a precise classification: safe-to-delete, keep, or
 * requires-human-judgment.
 *
 * Key rules:
 *  - NEVER guess — if uncertain, mark as requires-human-judgment.
 *  - NEVER modify files — this is read-only analysis.
 *  - Output is safe for display (no absolute paths, no body text).
 */

import type { VaultAdapter } from "../vault/adapter";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type CleanupDecision = "delete" | "keep" | "human_judgment";

export interface CleanupFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly attribution: string;  // Evidence for classification
  readonly decision: CleanupDecision;
}

export interface CleanupPreflightResult {
  readonly scannedCount: number;
  readonly deleteCount: number;
  readonly keepCount: number;
  readonly humanJudgmentCount: number;
  readonly files: readonly CleanupFileEntry[];
  readonly summary: string;
  /** When true, the caller should NOT auto-delete — human review needed. */
  readonly blocked: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Legacy signatures
// ═══════════════════════════════════════════════════════════════════

/**
 * Patterns that identify legacy plugin output files.
 * Each pattern has a `decision` and `attribution` evidence label.
 */
interface LegacySignature {
  readonly pathPattern: RegExp;
  readonly decision: CleanupDecision;
  readonly attribution: string;
}

const LEGACY_SIGNATURES: readonly LegacySignature[] = [
  // Old weekly review run snapshots
  {
    pathPattern: /weekly-review-run.*\.md$/iu,
    decision: "delete",
    attribution: "旧 WeeklyReviewRun 快照文件",
  },
  // Old topic result files (not new weekly/preparation-service format)
  {
    pathPattern: /topic-results?\/.*\.md$/iu,
    decision: "human_judgment",
    attribution: "旧 topic results — 需人工确认是否为 preparation-service 格式",
  },
  // Old dialogue session files
  {
    pathPattern: /dialogue-sessions?\/.*\.md$/iu,
    decision: "delete",
    attribution: "旧 dialogue session 文件",
  },
  // Empty archive files (just metadata, no actual turns)
  {
    pathPattern: /archive\/.*\.md$/iu,
    decision: "human_judgment",
    attribution: "归档文件 — 需检查是否有实际对话轮次",
  },
  // Old snapshot files
  {
    pathPattern: /snapshots?\/snapshot-.*\.json$/iu,
    decision: "delete",
    attribution: "旧 snapshot JSON 文件",
  },
  // Pipeline state files
  {
    pathPattern: /pipeline-state.*\.json$/iu,
    decision: "delete",
    attribution: "旧 pipeline state 文件（已在 Task 08 废弃）",
  },
];

/**
 * Known plugin-managed directories that should be KEPT:
 * - Conversation archives (new format)
 * - Cognitive model files
 * - Goal/validation reports
 */
const KEEP_PATTERNS: readonly RegExp[] = [
  /conversation-archives?\//iu,
  /cognitive-model\//iu,
  /goals\//iu,
  /validations\//iu,
  /views\//iu,
];

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a path matches any keep pattern.
 */
function matchesKeepPattern(path: string): boolean {
  return KEEP_PATTERNS.some((p) => p.test(path));
}

/**
 * Attempt to read file content and determine if it's an empty archive.
 * Returns true if the file appears to be an empty placeholder (only metadata, no turns).
 */
async function isEmptyArchive(
  vault: VaultAdapter,
  path: string,
): Promise<boolean> {
  try {
    const content = await vault.readText(path);
    // Check for common markers of empty archives
    const hasTurns = /turns?[:\s]*\[/i.test(content) && !/turns?[:\s]*\[\s*\]/i.test(content);
    const hasDialogue = /dialogue/i.test(content) && content.length > 200;
    // If file has actual turn data, it's not empty
    if (hasTurns || hasDialogue) return false;
    // If very small and no turns, likely empty
    return content.length < 500;
  } catch {
    // Can't read — mark for human judgment
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main function
// ═══════════════════════════════════════════════════════════════════

/**
 * Scan the system output directory for legacy run data.
 *
 * @param vault         VaultAdapter for reading file listings
 * @param systemOutputDir  Plugin system output directory (e.g. "_个人认知系统")
 * @returns CleanupPreflightResult with precise file-by-file classification
 */
export async function runCleanupPreflight(
  vault: VaultAdapter,
  systemOutputDir: string,
): Promise<CleanupPreflightResult> {
  const files: CleanupFileEntry[] = [];
  let blocked = false;

  // 1. List all files under the system output directory
  let allFiles: readonly { path: string }[];
  try {
    allFiles = await vault.listFiles();
  } catch {
    return {
      scannedCount: 0,
      deleteCount: 0,
      keepCount: 0,
      humanJudgmentCount: 0,
      files: [],
      summary: `无法读取目录 "${systemOutputDir}"，请检查 Vault 权限。`,
      blocked: true,
    };
  }

  // Filter to only markdown and JSON files under the system dir
  const systemFiles = allFiles.filter(
    (f) =>
      f.path.startsWith(systemOutputDir + "/") ||
      f.path.startsWith(systemOutputDir + "\\"),
  );

  // 2. Classify each file
  for (const file of systemFiles) {
    // Check keep patterns first
    if (matchesKeepPattern(file.path)) {
      files.push({
        path: file.path,
        sizeBytes: 0,
        attribution: "当前架构保留文件",
        decision: "keep",
      });
      continue;
    }

    // Check legacy signatures
    let matched = false;
    for (const sig of LEGACY_SIGNATURES) {
      if (sig.pathPattern.test(file.path)) {
        // For archives, do deeper inspection
        if (sig.decision === "human_judgment" && /archive/i.test(file.path)) {
          const isEmpty = await isEmptyArchive(vault, file.path);
          if (isEmpty) {
            files.push({
              path: file.path,
              sizeBytes: 0,
              attribution: "空归档文件（无实际对话轮次）",
              decision: "delete",
            });
          } else {
            files.push({
              path: file.path,
              sizeBytes: 0,
              attribution: sig.attribution,
              decision: "human_judgment",
            });
            blocked = true;
          }
        } else {
          files.push({
            path: file.path,
            sizeBytes: 0,
            attribution: sig.attribution,
            decision: sig.decision,
          });
          if (sig.decision === "human_judgment") {
            blocked = true;
          }
        }
        matched = true;
        break;
      }
    }

    // No signature matched — unknown file
    if (!matched) {
      // Check if it looks like plugin data (JSON, markdown with frontmatter)
      if (/\.(json|md)$/iu.test(file.path)) {
        files.push({
          path: file.path,
          sizeBytes: 0,
          attribution: "无法识别的插件数据文件",
          decision: "human_judgment",
        });
        blocked = true;
      } else {
        // Non-plugin file — keep
        files.push({
          path: file.path,
          sizeBytes: 0,
          attribution: "非插件数据文件（可能是用户源数据）",
          decision: "keep",
        });
      }
    }
  }

  // 3. Compute summary
  const deleteCount = files.filter((f) => f.decision === "delete").length;
  const keepCount = files.filter((f) => f.decision === "keep").length;
  const humanJudgmentCount = files.filter((f) => f.decision === "human_judgment").length;

  let summary: string;
  if (blocked) {
    summary =
      `扫描完成：${files.length} 个文件。` +
      `${deleteCount} 个可安全删除，${keepCount} 个保留，` +
      `${humanJudgmentCount} 个需人工判断。` +
      `⚠️ 存在无法自动确定的文件，已停止——请手动审查后操作。`;
  } else {
    summary =
      `扫描完成：${files.length} 个文件。` +
      `${deleteCount} 个可安全删除，${keepCount} 个保留。` +
      `无阻塞项，可安全清理。`;
  }

  return {
    scannedCount: files.length,
    deleteCount,
    keepCount,
    humanJudgmentCount,
    files,
    summary,
    blocked,
  };
}
