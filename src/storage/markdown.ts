import type { Claim, GoalState, ValidationExperiment } from "../domain/types";
import type { DialogueArchiveRecord, DialogueResultArchiveRecord } from "../dialogue/session";
import { sha256 } from "../vault/scanner";

// ─── Part 1: Safe Markdown Escaping ─────────────────────────────

/**
 * Escape user-provided text so it renders as literal text in Markdown,
 * never as formatting syntax. The output is safe to embed in Markdown body
 * but NOT safe for YAML frontmatter (use escapeYamlValue for that).
 *
 * Processing order (each .replace() scans the result of the previous one;
 * g-flag replacements do not re-scan their own output):
 *
 * 1. Break ``` and ~~~ fences with zero-width space
 * 2. ![[…]] → !\[\[...\]\] (preserve ! unescaped)
 * 3. [[…]] → \[\[...\]\]
 * 4. [text](url) and ![alt](url) → escaped brackets/parens
 * 5. Line-start patterns: #, >, -, +, digit-list, ---
 * 6. Individual markdown chars: * _ { } + - . | ~ `
 *    (Excludes \ # ! — \ causes double-escaping, # mid-text is safe,
 *     ! is only dangerous with [[…]]/[…](…) which are already handled)
 * 7. Remaining unescaped [ ] ( ) via negative-lookbehind
 * 8. HTML entity encoding (LAST — after all backslash insertions so
 *    entities like &#39; aren't mangled by subsequent escaping steps)
 *
 * NOTE: > is NOT HTML-encoded. In HTML context > is safe, and encoding
 * it would conflict with line-start blockquote escaping.
 */
export function escapeMarkdownText(text: string): string {
  let result = text;

  // Step 1: Break fence sequences
  // Insert U+200B ZERO WIDTH SPACE between consecutive backticks/tildes
  result = result.replace(/```/g, "`\u200B``");
  result = result.replace(/~~~/g, "~\u200B~~");

  // Step 2: Break embed syntax — ! must stay unescaped so the result
  // is !\[\[…\]\] (renders ! followed by literal [[…]], not embed)
  result = result.replace(/!\[\[/g, "!\\[\\[");

  // Step 3: Escape wikilinks — [[…]] → \[\[…\]\]
  result = result.replace(/\[\[/g, "\\[\\[");

  // Step 4: Escape link/image syntax [text](url) and ![alt](url)
  // Match optional ! prefix, then [text], then (url)
  result = result.replace(/(!?)\[([^\]]*)\]\(([^)]*)\)/g, "$1\\[$2\\]\\($3\\)");

  // Step 5: Line-start patterns (multiline mode)
  // Insert a backslash before dangerous line-start characters.
  result = result.replace(/^(#{1,6})\s/gm, "\\$1 ");
  result = result.replace(/^>/gm, "\\>");
  result = result.replace(/^([\-+])\s/gm, "\\$1 ");
  result = result.replace(/^(\d+)\.\s/gm, "$1\\. ");
  // Break frontmatter delimiter --- by inserting zero-width space
  result = result.replace(/^---/gm, "-​--");

  // Step 6: Escape individual markdown format characters.
  // Includes: * _ { } | ~ `
  // Excludes: \ ! (see docstring), [ ] ( ) (handled separately)
  // Also excludes: # - + . (handled with lookbehind below to avoid
  // double-escaping the line-start patterns from step 5)
  result = result.replace(/([*_{}|~`])/g, "\\$1");

  // Step 6b: Escape # - + . individually, but only when NOT preceded by
  // a backslash (to avoid double-escaping line-start patterns from step 5).
  result = result.replace(/(?<!\\)#/g, "\\#");
  result = result.replace(/(?<!\\)\-/g, "\\-");
  result = result.replace(/(?<!\\)\+/g, "\\+");
  result = result.replace(/(?<!\\)\./g, "\\.");

  // Step 7: Escape remaining unescaped brackets and parentheses.
  // A bracket is "unescaped" if not preceded by a backslash.
  // Using negative lookbehind ensures we don't double-escape.
  result = result.replace(/(?<!\\)\[/g, "\\[");
  result = result.replace(/(?<!\\)\]/g, "\\]");
  result = result.replace(/(?<!\\)\(/g, "\\(");
  result = result.replace(/(?<!\\)\)/g, "\\)");

  // Step 8: HTML entity encoding (LAST, after all markdown escaping)
  // Encode & first to avoid re-encoding entities we just produced.
  // NOTE: > is intentionally NOT encoded — it is safe in HTML context
  // and encoding it would break line-start blockquote escaping.
  result = result
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return result;
}

/**
 * Escape a value for safe inclusion in a YAML frontmatter field.
 * Returns the value as a YAML scalar:
 * - Simple safe strings are returned unquoted
 * - Strings needing escaping are returned double-quoted with escapes
 */
export function escapeYamlValue(value: string): string {
  // If empty, return quoted empty string
  if (value.length === 0) {
    return '""';
  }

  // Check if the value needs quoting.
  // YAML plain scalars cannot contain control chars or: : { } [ ] " ' & * ? # | > ! % @ ` \
  // They also cannot start with: " ' - ? : , [ ] { } # & * ! | > % @ `
  // and cannot be a reserved word.
  const needsQuoting =
    /[:{}[\]"'&\*?#|>!%@`\\]/.test(value) ||
    value.includes(": ") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    /^["'\-?:,\[\]{}#&*!|>%@`]/.test(value) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(value);

  if (!needsQuoting) {
    return value;
  }

  // Escape backslashes and double quotes, encode newlines
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");

  return `"${escaped}"`;
}

/**
 * Generate a safe YAML frontmatter block.
 * Keys are plugin-generated (trusted); values are escaped.
 * Returns the complete frontmatter string including leading/trailing ---.
 */
export function safeFrontmatter(
  fields: Record<string, string | number | boolean | null>
): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(fields)) {
    if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${escapeYamlValue(value)}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
}

// ─── Part 2: File System Adapter ───────────────────────────────

/** File system abstraction used by atomicWriteMarkdown.
 *  In tests, implement with an in-memory store.
 *  In Obsidian, implement with the Vault API. */
export interface MarkdownFileSystem {
  writeFile(relativePath: string, content: string): Promise<number>;
  readFile(relativePath: string): Promise<string>;
  fileExists(relativePath: string): Promise<boolean>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  listFiles(dirPath: string): Promise<string[]>;
}

/** Default allowed root for write operations within the plugin's system directory. */
export const SYSTEM_OUTPUT_ROOT = "_个人认知系统";

/**
 * Validate that a relative path is safe to write to.
 * Rejects:
 * - Paths containing ..  (directory traversal)
 * - Absolute paths (Windows D:\… or Unix /…)
 * - Paths under .obsidian/
 * - Paths outside the allowed root
 */
export function validateWritePath(relativePath: string, allowedRoot: string): void {
  // Reject empty paths
  if (relativePath.length === 0) {
    throw new Error("Write path must not be empty");
  }

  // Normalize separators
  const normalized = relativePath.replace(/\\/g, "/");

  // Reject ..
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new Error(`Path traversal rejected: ${relativePath}`);
  }

  // Reject absolute paths (Unix)
  if (normalized.startsWith("/")) {
    throw new Error(`Absolute path rejected: ${relativePath}`);
  }

  // Reject absolute paths (Windows — drive letter)
  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    throw new Error(`Absolute path rejected: ${relativePath}`);
  }

  // Reject .obsidian/ at any level
  if (
    normalized === ".obsidian" ||
    normalized.startsWith(".obsidian/") ||
    normalized.includes("/.obsidian/")
  ) {
    throw new Error(`Write to .obsidian/ rejected: ${relativePath}`);
  }

  // Reject paths outside the allowed root
  const rootNormalized = allowedRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (
    normalized !== rootNormalized &&
    !normalized.startsWith(rootNormalized + "/")
  ) {
    throw new Error(`Write outside allowed root rejected: ${relativePath}`);
  }
}

// ─── Part 3: Atomic Write ──────────────────────────────────────

export interface AtomicWriteOptions {
  /** If provided, the written content must match this exactly on re-read. */
  readonly expectedContent?: string;
  /** If provided, the SHA-256 hash of the content must match (alternative to expectedContent). */
  readonly expectedHash?: string;
}

const RENAME_RETRY_DELAYS_MS = [50, 150, 500] as const;

/**
 * Write a Markdown file atomically following the 9-step protocol from AGENT.md.
 *
 * 1. Write to filename.tmp-<operation-id> in the same directory
 * 2. flush/close (no-op in our abstraction; writeFile is complete)
 * 3. Re-read and schema/hash verify
 * 4. If target exists, copy to filename.bak
 * 5. Rename temp to final (via copy + delete in our abstraction)
 * 6. Keep only one recent .bak
 * 7. Delete stale temp files
 * 8. Rename failure: retry 3 times (50ms, 150ms, 500ms), keep old+temp on failure
 * 9. Never delete the old file before rename succeeds
 */
export async function atomicWriteMarkdown(
  fs: MarkdownFileSystem,
  relativePath: string,
  content: string,
  operationId: string,
  options?: AtomicWriteOptions
): Promise<void> {
  // Validate the path before any I/O
  validateWritePath(relativePath, SYSTEM_OUTPUT_ROOT);

  const lastSlash = relativePath.lastIndexOf("/");
  const dirPath = lastSlash >= 0 ? relativePath.substring(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? relativePath.substring(lastSlash + 1) : relativePath;
  const tempPath = dirPath
    ? `${dirPath}/${fileName}.tmp-${operationId}`
    : `${fileName}.tmp-${operationId}`;
  const bakPath = `${relativePath}.bak`;

  // Step 1: Write temp file
  await fs.writeFile(tempPath, content);

  // Step 2: flush/close — no-op in our abstraction

  // Step 3: Re-read and verify
  const written = await fs.readFile(tempPath);
  if (written !== content) {
    throw new Error(
      `Atomic write verification failed: content mismatch after write for ${relativePath}`
    );
  }

  if (options?.expectedContent !== undefined && written !== options.expectedContent) {
    throw new Error(
      `Atomic write verification failed: expectedContent mismatch for ${relativePath}`
    );
  }

  if (options?.expectedHash !== undefined) {
    const actualHash = sha256(written);
    if (actualHash !== options.expectedHash) {
      throw new Error(
        `Atomic write verification failed: hash mismatch for ${relativePath} (expected ${options.expectedHash}, got ${actualHash})`
      );
    }
  }

  // Step 4: If target exists, copy to .bak
  const targetExists = await fs.fileExists(relativePath);
  if (targetExists) {
    await fs.copyFile(relativePath, bakPath);
  }

  // Step 5: Rename temp → target (via writeFile in our abstraction)
  let renamed = false;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Copy temp content to target path
      await fs.writeFile(relativePath, content);
      renamed = true;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < RENAME_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]!)
        );
      }
    }
  }

  if (!renamed) {
    // Step 8 failure: keep both old file (if exists) and temp file, report error
    throw new Error(
      `Atomic write rename failed after ${RENAME_RETRY_DELAYS_MS.length + 1} attempts for ${relativePath}: ${String(lastError)}`
    );
  }

  // Step 6: Retain only one recent .bak
  if (dirPath) {
    const dirFiles = await fs.listFiles(dirPath);
    const bakFiles = dirFiles
      .filter((f) => f.endsWith(".bak") && f.startsWith(dirPath + "/"))
      .sort();
    // Keep only the most recent (last sorted)
    for (const bak of bakFiles.slice(0, -1)) {
      try {
        await fs.deleteFile(bak);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // Step 7: Clean up stale temp files
  try {
    await fs.deleteFile(tempPath);
  } catch {
    // Best-effort
  }

  // Clean up any other stale .tmp-* files in the directory
  if (dirPath) {
    const dirFiles2 = await fs.listFiles(dirPath);
    const staleTmps = dirFiles2.filter(
      (f) => f.includes(".tmp-") && f.startsWith(dirPath + "/") && f !== tempPath
    );
    for (const tmp of staleTmps) {
      try {
        await fs.deleteFile(tmp);
      } catch {
        // Best-effort
      }
    }
  }
}

// ─── Part 4: Cognitive Model View Generation ───────────────────

const MODEL_VERSION = "1.1";

/** Escape user-provided text for inline display (safe against markdown syntax). */
function escapeUserText(value: string): string {
  return escapeMarkdownText(value).replace(/\r?\n/g, " ");
}

function renderClaimEntry(claim: Claim): string {
  // Only canonical_text, scope_limits, and missing_context contain
  // user/AI-generated text. All other fields are domain enum values.
  const escapedText = escapeUserText(claim.canonical_text);

  return [
    `### ${escapedText}`,
    "",
    `- **状态**: ${claim.epistemic_status}`,
    `- **版本**: ${claim.version}`,
    `- **形成时间**: ${claim.formed_at}`,
    `- **类型**: ${claim.claim_type}`,
    claim.scope_limits
      ? `- **范围限制**: ${escapeUserText(claim.scope_limits)}`
      : null,
    claim.missing_context
      ? `- **缺失上下文**: ${escapeUserText(claim.missing_context)}`
      : null,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function cognitiveViewFrontmatter(viewLabel: string, claimCount: number): string {
  return safeFrontmatter({
    generated_at: new Date().toISOString(),
    claim_count: claimCount,
    model_version: MODEL_VERSION,
  });
}

export function renderEndorsedMarkdown(claims: readonly Claim[]): string {
  const frontmatter = cognitiveViewFrontmatter("current_endorsed", claims.length);
  const body = [
    "# 当前明确认可",
    "",
    claims.length === 0
      ? "_暂无明确认可的观点_"
      : claims.map(renderClaimEntry).join("\n"),
    "",
  ].join("\n");
  return `${frontmatter}\n\n${body}`;
}

export function renderConfirmedObservationsMarkdown(
  claims: readonly Claim[]
): string {
  const frontmatter = cognitiveViewFrontmatter("confirmed_observations", claims.length);
  const body = [
    "# 已确认观察",
    "",
    claims.length === 0
      ? "_暂无已确认的观察_"
      : claims.map(renderClaimEntry).join("\n"),
    "",
  ].join("\n");
  return `${frontmatter}\n\n${body}`;
}

export function renderAiHypothesesMarkdown(claims: readonly Claim[]): string {
  const frontmatter = cognitiveViewFrontmatter("ai_hypotheses", claims.length);
  const body = [
    "# AI 工作假设",
    "",
    "> ⚠️ 以下内容为 AI 推测，尚未经用户确认。",
    "",
    claims.length === 0
      ? "_暂无 AI 假设_"
      : claims.map(renderClaimEntry).join("\n"),
    "",
  ].join("\n");
  return `${frontmatter}\n\n${body}`;
}

export function renderToVerifyMarkdown(claims: readonly Claim[]): string {
  const frontmatter = cognitiveViewFrontmatter("to_verify", claims.length);
  const body = [
    "# 待验证想法",
    "",
    "> 🔍 以下想法需要进行验证。",
    "",
    claims.length === 0
      ? "_暂无待验证想法_"
      : claims.map(renderClaimEntry).join("\n"),
    "",
  ].join("\n");
  return `${frontmatter}\n\n${body}`;
}

// ─── Part 5: Goals and Validation Views ────────────────────────

export function renderCurrentGoalsMarkdown(goals: GoalState): string {
  const activeLongTerm = goals.long_term_goals.filter(
    (g) => g.status === "active"
  );
  const frontmatter = safeFrontmatter({
    generated_at: new Date().toISOString(),
    active_long_term: activeLongTerm.length,
    lower_priority_count: goals.lower_priority_candidates.length,
    super_long_term_count: goals.super_long_term_candidates.length,
    has_weekly_result: goals.weekly_result !== null,
  });

  const lines: string[] = [
    frontmatter,
    "",
    "# 当前目标",
    "",
    "## 长期目标",
    "",
  ];

  if (activeLongTerm.length === 0) {
    lines.push("_暂无活跃长期目标_", "");
  } else {
    for (const goal of activeLongTerm) {
      lines.push(
        `- **${escapeUserText(goal.text)}** (${goal.goal_id})`,
        ""
      );
    }
  }

  lines.push("## 本周目标", "");
  if (goals.weekly_result === null) {
    lines.push("_暂无本周目标_", "");
  } else {
    lines.push(
      `- **${escapeUserText(goals.weekly_result.text)}** (${goals.weekly_result.goal_id})`,
      ""
    );
  }

  if (goals.lower_priority_candidates.length > 0) {
    lines.push(
      `## 低优先候选 (${goals.lower_priority_candidates.length})`,
      ""
    );
    for (const g of goals.lower_priority_candidates) {
      lines.push(`- ${escapeUserText(g.text)}`, "");
    }
  }

  if (goals.super_long_term_candidates.length > 0) {
    lines.push(
      `## 超长期候选 (${goals.super_long_term_candidates.length})`,
      ""
    );
    for (const g of goals.super_long_term_candidates) {
      lines.push(`- ${escapeUserText(g.text)}`, "");
    }
  }

  return lines.join("\n");
}

export function renderGoalHistoryMarkdown(
  goals: readonly GoalState[]
): string {
  const frontmatter = safeFrontmatter({
    generated_at: new Date().toISOString(),
    entry_count: goals.length,
  });

  const lines: string[] = [
    frontmatter,
    "",
    "# 目标历史",
    "",
  ];

  if (goals.length === 0) {
    lines.push("_暂无历史目标记录_", "");
  } else {
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i]!;
      lines.push(`## 记录 ${i + 1}`, "");
      const allGoals = [
        ...g.long_term_goals,
        ...g.lower_priority_candidates,
        ...g.super_long_term_candidates,
        ...(g.weekly_result ? [g.weekly_result] : []),
      ];
      for (const goal of allGoals) {
        lines.push(
          `- [${goal.status}] [${goal.horizon}] ${escapeUserText(goal.text)} (${goal.goal_id})`,
          ""
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function renderActiveValidationsMarkdown(
  validations: readonly ValidationExperiment[]
): string {
  const active = validations.filter((v) => v.status === "active");
  const frontmatter = safeFrontmatter({
    generated_at: new Date().toISOString(),
    active_count: active.length,
    total_count: validations.length,
  });

  const lines: string[] = [
    frontmatter,
    "",
    "# 正在验证",
    "",
  ];

  if (active.length === 0) {
    lines.push("_暂无正在进行的验证_", "");
  } else {
    for (const v of active) {
      lines.push(
        `## ${escapeUserText(v.action)}`,
        "",
        `- **实验 ID**: ${v.experiment_id}`,
        `- **假设 Claim**: ${v.hypothesis_claim_id}`,
        `- **开始时间**: ${v.started_at}`,
        `- **截止时间**: ${v.deadline_at}`,
        `- **预计耗时**: ${v.expected_minutes} 分钟`,
        "",
      );
    }
  }

  return lines.join("\n");
}

export function renderValidationHistoryMarkdown(
  validations: readonly ValidationExperiment[]
): string {
  const frontmatter = safeFrontmatter({
    generated_at: new Date().toISOString(),
    total_count: validations.length,
  });

  const lines: string[] = [
    frontmatter,
    "",
    "# 验证历史",
    "",
  ];

  if (validations.length === 0) {
    lines.push("_暂无验证历史_", "");
  } else {
    for (const v of validations) {
      lines.push(
        `- [${v.status}] ${escapeUserText(v.action)} (${v.experiment_id}) — 截止 ${v.deadline_at}`,
        ""
      );
    }
  }

  return lines.join("\n");
}

// ─── Part 6: Dialogue Archive and Weekly Review ────────────────

function isResultRecord(
  record: DialogueArchiveRecord
): record is DialogueResultArchiveRecord {
  return (
    record.role === "formal_result" ||
    record.role === "ai_inferred_result" ||
    record.role === "to_verify_result"
  );
}

function renderArchiveRecord(record: DialogueArchiveRecord): string {
  if (isResultRecord(record)) {
    const lines = [
      `### ${record.role}: ${record.candidate_id}`,
      "",
      `- **文本**: ${escapeUserText(record.text)}`,
      `- **解释**: ${escapeUserText(record.explanation)}`,
      `- **类型**: ${record.claim_type}`,
      `- **来源**: ${record.origin}`,
      `- **认识状态**: ${record.epistemic_status}`,
      `- **主题**: ${record.topic_id}`,
      `- **时间**: ${record.recorded_at}`,
    ];

    if (record.revision_target !== null) {
      lines.push(
        `- **修订目标**: ${record.revision_target.claim_id} @ v${record.revision_target.version}`
      );
    }

    if (record.confirmation !== null) {
      lines.push(
        `- **确认**: ${escapeUserText(record.confirmation.user_statement)}`
      );
    }

    lines.push("");
    return lines.join("\n");
  }

  // Text archive record
  const lines = [
    `### ${record.role}`,
    "",
    `> ${escapeUserText(record.content)}`,
    "",
  ];

  if (record.topic_id !== null) {
    lines.push(`- **主题**: ${record.topic_id}`, "");
  }

  if (record.status !== undefined) {
    lines.push(`- **状态**: ${record.status}`, "");
  }

  lines.push(`- **时间**: ${record.recorded_at}`, "");
  return lines.join("\n");
}

export function renderDialogueArchiveMarkdown(
  archive: readonly DialogueArchiveRecord[],
  sessionId: string,
  dateLabel: string
): string {
  const frontmatter = safeFrontmatter({
    generated_at: new Date().toISOString(),
    session_id: sessionId,
    date: dateLabel,
    record_count: archive.length,
  });

  const lines: string[] = [
    frontmatter,
    "",
    `# 对话归档: ${dateLabel}`,
    "",
    `**会话 ID**: ${sessionId}`,
    "",
    `**记录数**: ${archive.length}`,
    "",
    "---",
    "",
  ];

  if (archive.length === 0) {
    lines.push("_暂无对话记录_", "");
  } else {
    for (const record of archive) {
      lines.push(renderArchiveRecord(record));
    }
  }

  return lines.join("\n");
}

export function renderWeeklyReviewMarkdown(
  weekLabel: string,
  snapshotNoteCount: number,
  goalsSummary: string,
  validationFeedback: string,
  keyTakeaways: readonly string[]
): string {
  const frontmatter = safeFrontmatter({
    generated_at: new Date().toISOString(),
    week: weekLabel,
    note_count: snapshotNoteCount,
    takeaway_count: keyTakeaways.length,
  });

  const lines: string[] = [
    frontmatter,
    "",
    `# 每周回顾: ${weekLabel}`,
    "",
    "## 笔记概况",
    "",
    `本周快照包含 **${snapshotNoteCount}** 条新笔记。`,
    "",
    "## 目标进展",
    "",
    escapeMarkdownText(goalsSummary),
    "",
    "## 验证反馈",
    "",
    escapeMarkdownText(validationFeedback),
    "",
    "## 关键收获",
    "",
  ];

  if (keyTakeaways.length === 0) {
    lines.push("_暂无关键收获_", "");
  } else {
    for (const takeaway of keyTakeaways) {
      lines.push(`- ${escapeMarkdownText(takeaway)}`, "");
    }
  }

  return lines.join("\n");
}
