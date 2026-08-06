import { describe, expect, it } from "vitest";
import {
  escapeMarkdownText,
  escapeYamlValue,
  safeFrontmatter,
  validateWritePath,
  atomicWriteMarkdown,
  renderEndorsedMarkdown,
  renderConfirmedObservationsMarkdown,
  renderAiHypothesesMarkdown,
  renderToVerifyMarkdown,
  renderCurrentGoalsMarkdown,
  renderGoalHistoryMarkdown,
  renderActiveValidationsMarkdown,
  renderValidationHistoryMarkdown,
  renderDialogueArchiveMarkdown,
  renderWeeklyReviewMarkdown,
  type MarkdownFileSystem,
  type AtomicWriteOptions,
} from "../src/storage/markdown";
import type { Claim, GoalState, ValidationExperiment } from "../src/domain/types";
import type { DialogueArchiveRecord } from "../src/dialogue/session";

// ─── MemoryFileSystem ──────────────────────────────────────────

class MemoryFileSystem implements MarkdownFileSystem {
  private files = new Map<string, string>();

  async writeFile(relativePath: string, content: string): Promise<number> {
    const encoded = new TextEncoder().encode(content);
    this.files.set(relativePath, content);
    return encoded.length;
  }

  async readFile(relativePath: string): Promise<string> {
    const content = this.files.get(relativePath);
    if (content === undefined) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return content;
  }

  async fileExists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath);
  }

  async copyFile(sourcePath: string, targetPath: string): Promise<void> {
    const content = this.files.get(sourcePath);
    if (content === undefined) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }
    this.files.set(targetPath, content);
  }

  async deleteFile(relativePath: string): Promise<void> {
    this.files.delete(relativePath);
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    const result: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        result.push(key);
      }
    }
    return result.sort();
  }

  /** For testing: get raw file count */
  fileCount(): number {
    return this.files.size;
  }

  /** For testing: list all paths */
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

// ─── Test Helpers ──────────────────────────────────────────────

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    schema_version: "1.1",
    claim_id: overrides.claim_id ?? "claim-001",
    canonical_text: overrides.canonical_text ?? "Test claim text",
    claim_type: overrides.claim_type ?? "current_viewpoint",
    epistemic_status: overrides.epistemic_status ?? "user_confirmed",
    user_stance: overrides.user_stance ?? "endorsed",
    objective_truth_status: overrides.objective_truth_status ?? "unknown",
    formed_at: overrides.formed_at ?? "2024-01-01",
    time_scope: overrides.time_scope ?? "present",
    applicable_contexts: overrides.applicable_contexts ?? [],
    scope_limits: overrides.scope_limits ?? "",
    source_note_ids: overrides.source_note_ids ?? [],
    source_topic_ids: overrides.source_topic_ids ?? [],
    source_dialogue_refs: overrides.source_dialogue_refs ?? [],
    support_evidence_ids: overrides.support_evidence_ids ?? [],
    counterexample_candidate_ids: overrides.counterexample_candidate_ids ?? [],
    missing_context: overrides.missing_context ?? "",
    version: overrides.version ?? 1,
    created_at: overrides.created_at ?? "2024-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2024-01-01T00:00:00.000Z",
  };
}

function makeGoalState(overrides: Partial<GoalState> = {}): GoalState {
  return {
    long_term_goals: overrides.long_term_goals ?? [],
    lower_priority_candidates: overrides.lower_priority_candidates ?? [],
    super_long_term_candidates: overrides.super_long_term_candidates ?? [],
    weekly_result: overrides.weekly_result ?? null,
  };
}

function makeValidation(overrides: Partial<ValidationExperiment> = {}): ValidationExperiment {
  return {
    experiment_id: overrides.experiment_id ?? "exp-001",
    hypothesis_claim_id: overrides.hypothesis_claim_id ?? "claim-001",
    action: overrides.action ?? "Test action",
    status: overrides.status ?? "active",
    started_at: overrides.started_at ?? "2024-06-01T00:00:00.000Z",
    deadline_at: overrides.deadline_at ?? "2024-06-02T00:00:00.000Z",
    expected_minutes: overrides.expected_minutes ?? 60,
  };
}

function makeTextArchive(overrides: Record<string, unknown> = {}): DialogueArchiveRecord {
  return {
    role: (overrides.role as DialogueArchiveRecord["role"]) ?? "user_statement",
    content: (overrides.content as string) ?? "Hello",
    topic_id: (overrides.topic_id as string) ?? "topic-1",
    recorded_at: (overrides.recorded_at as string) ?? "2024-01-01T00:00:00.000Z",
  } as DialogueArchiveRecord;
}

// ─── escapeMarkdownText ────────────────────────────────────────

describe("escapeMarkdownText", () => {
  it("encodes HTML entities (& < \" ')", () => {
    // NOTE: > is intentionally NOT HTML-encoded — it is safe in HTML
    // and encoding it would break line-start blockquote escaping.
    const input = '& < > " \'';
    const result = escapeMarkdownText(input);
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    // > is NOT encoded
    expect(result).not.toContain("&gt;");
    expect(result).toContain("&quot;");
    expect(result).toContain("&#39;");
  });

  it("escapes markdown format characters", () => {
    const input = "\\ * _ { } # + - . ! | ~ `";
    const result = escapeMarkdownText(input);
    // Characters that are individually escaped: * _ { } + - . | ~ `
    // Characters intentionally NOT escaped:
    //   \\  — prevents double-escaping of our inserted backslashes
    //   #   — safe mid-text (line-start # handled separately)
    //   !   — safe when [[…]]/[…](…) are already escaped
    for (const ch of ["*", "_", "{", "}", "+", "-", ".", "|", "~", "`"]) {
      expect(result).toContain(`\\${ch}`);
    }
  });

  it("escapes wikilinks [[...]]", () => {
    const result = escapeMarkdownText("[[my note]]");
    expect(result).toContain("\\[\\[my note\\]\\]");
    expect(result).not.toMatch(/[^\\]\[\[/); // No unescaped [[
  });

  it("escapes embed syntax ![[...]]", () => {
    const result = escapeMarkdownText("![[embed note]]");
    expect(result).toContain("!\\[\\[embed note\\]\\]");
    // ! should NOT be escaped, preserving the break pattern
    expect(result).not.toMatch(/\\!\[\[/);
  });

  it("escapes link syntax [text](url)", () => {
    const result = escapeMarkdownText("[click here](https://example.com)");
    // Brackets, parens, and dots should all be escaped
    expect(result).toMatch(/\\\[click here\\\]\\\(https:\/\/example\\\.com\\\)/);
  });

  it("breaks triple backtick fences", () => {
    const result = escapeMarkdownText("```code```");
    // Should contain zero-width space (U+200B) between backticks
    expect(result).toContain("\u200B");
    // Should not contain three consecutive backticks
    expect(result).not.toMatch(/```/);
  });

  it("breaks triple tilde fences", () => {
    const result = escapeMarkdownText("~~~text~~~");
    expect(result).toContain("\u200B");
    expect(result).not.toMatch(/~~~/);
  });

  it("escapes line-start # heading", () => {
    const result = escapeMarkdownText("# Heading");
    expect(result).toMatch(/^\\# Heading$/);
  });

  it("escapes line-start > blockquote", () => {
    const result = escapeMarkdownText("> quote");
    expect(result).toMatch(/^\\> quote$/);
  });

  it("escapes line-start - list item", () => {
    const result = escapeMarkdownText("- item");
    expect(result).toMatch(/^\\- item$/);
  });

  it("escapes line-start + list item", () => {
    const result = escapeMarkdownText("+ item");
    // \+ at line start prevents list parsing
    expect(result).toBe("\\+ item");
  });

  it("escapes line-start number list", () => {
    const result = escapeMarkdownText("1. first");
    expect(result).toMatch(/^1\\\. first$/);
  });

  it("escapes line-start --- frontmatter delimiter with zero-width space", () => {
    const result = escapeMarkdownText("---");
    // Should contain zero-width space to break the frontmatter pattern
    expect(result).toContain("​");
    expect(result).not.toMatch(/^---$/);
  });

  it("preserves original newline characters (\\n)", () => {
    const result = escapeMarkdownText("line1\nline2\nline3");
    expect(result).toContain("\n");
    expect(result.split("\n").length).toBe(3);
  });

  it("preserves original newline characters (\\r\\n)", () => {
    const result = escapeMarkdownText("line1\r\nline2");
    expect(result).toContain("\r\n");
  });

  it("escapes line-start patterns on each line in multi-line text", () => {
    const result = escapeMarkdownText("# heading\n- item\n> quote");
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^\\# heading$/);
    expect(lines[1]).toMatch(/^\\- item$/);
    expect(lines[2]).toMatch(/^\\> quote$/);
  });

  it("does not escape mid-line special characters twice", () => {
    const result = escapeMarkdownText("text # not heading");
    // # in mid-line should be escaped, not line-start escaped
    expect(result).toContain("\\#");
    expect(result).not.toMatch(/^\\#/); // line doesn't start with #
  });
});

// ─── escapeYamlValue ───────────────────────────────────────────

describe("escapeYamlValue", () => {
  it("returns simple strings unquoted", () => {
    expect(escapeYamlValue("hello")).toBe("hello");
  });

  it("quotes strings with special characters", () => {
    expect(escapeYamlValue("hello: world")).toContain('"');
  });

  it("escapes double quotes within values", () => {
    const result = escapeYamlValue('say "hello"');
    expect(result).toContain('\\"');
  });

  it("escapes backslashes in values", () => {
    const result = escapeYamlValue("path\\to\\file");
    expect(result).toContain("\\\\");
  });

  it("handles newlines in values", () => {
    const result = escapeYamlValue("line1\nline2");
    // Should encode newline as \n in YAML double-quoted string
    expect(result).toContain("\\n");
  });
});

// ─── safeFrontmatter ───────────────────────────────────────────

describe("safeFrontmatter", () => {
  it("generates valid YAML frontmatter", () => {
    const result = safeFrontmatter({ key: "value", count: 42 });
    expect(result).toContain("---");
    expect(result).toContain("key:");
    expect(result).toContain("count: 42");
  });

  it("escapes values with special characters", () => {
    const result = safeFrontmatter({ text: "hello: world" });
    expect(result).toContain('"hello: world"');
  });

  it("handles null values", () => {
    const result = safeFrontmatter({ missing: null });
    expect(result).toContain("missing:");
    expect(result).toContain("null");
  });

  it("handles boolean values", () => {
    const result = safeFrontmatter({ flag: true });
    expect(result).toContain("flag: true");
  });

  it("handles multiple fields", () => {
    const result = safeFrontmatter({ a: 1, b: "two", c: false, d: null });
    expect(result).toContain("a: 1");
    expect(result).toContain("b: two");
    expect(result).toContain("c: false");
    expect(result).toContain("d: null");
  });
});

// ─── validateWritePath ─────────────────────────────────────────

describe("validateWritePath", () => {
  const allowed = "_个人认知系统";

  it("accepts paths under allowed root", () => {
    expect(() => validateWritePath("_个人认知系统/test.md", allowed)).not.toThrow();
  });

  it("rejects paths with ..", () => {
    expect(() => validateWritePath("_个人认知系统/../escape.md", allowed)).toThrow();
  });

  it("rejects absolute paths (Windows)", () => {
    expect(() => validateWritePath("D:\\test.md", allowed)).toThrow();
  });

  it("rejects absolute paths (Unix)", () => {
    expect(() => validateWritePath("/etc/passwd", allowed)).toThrow();
  });

  it("rejects paths under .obsidian/", () => {
    expect(() => validateWritePath(".obsidian/secret.json", allowed)).toThrow();
  });

  it("rejects paths outside allowed root", () => {
    expect(() => validateWritePath("somewhere/else.md", allowed)).toThrow();
  });

  it("rejects paths escaping via .obsidian even under allowed root", () => {
    expect(() => validateWritePath("_个人认知系统/.obsidian/config.json", allowed)).toThrow();
  });

  it("accepts nested paths under allowed root", () => {
    expect(() => validateWritePath("_个人认知系统/当前认知/test.md", allowed)).not.toThrow();
  });
});

// ─── atomicWriteMarkdown ───────────────────────────────────────

describe("atomicWriteMarkdown", () => {
  const allowedRoot = "_个人认知系统";

  it("writes a file atomically", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";
    const content = "# Hello\n\nWorld";

    await atomicWriteMarkdown(fs, path, content, "op-001");

    expect(await fs.fileExists(path)).toBe(true);
    expect(await fs.readFile(path)).toBe(content);
    // Temp file should be cleaned up
    const files = await fs.listFiles("_个人认知系统/");
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("creates backup when overwriting existing file", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";

    // Write initial content
    await atomicWriteMarkdown(fs, path, "old content", "op-001");
    // Overwrite
    await atomicWriteMarkdown(fs, path, "new content", "op-002");

    expect(await fs.readFile(path)).toBe("new content");

    // Should have a .bak file
    const files = await fs.listFiles("_个人认知系统/");
    const bakFiles = files.filter((f) => f.endsWith(".bak"));
    expect(bakFiles.length).toBe(1);
    expect(await fs.readFile(bakFiles[0]!)).toBe("old content");
  });

  it("is idempotent: writing same content twice works", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";
    const content = "same content";

    await atomicWriteMarkdown(fs, path, content, "op-001");
    await atomicWriteMarkdown(fs, path, content, "op-001");

    expect(await fs.readFile(path)).toBe(content);
  });

  it("keeps only one recent .bak file", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";

    await atomicWriteMarkdown(fs, path, "v1", "op-001");
    await atomicWriteMarkdown(fs, path, "v2", "op-002");
    await atomicWriteMarkdown(fs, path, "v3", "op-003");

    const files = await fs.listFiles("_个人认知系统/");
    const bakFiles = files.filter((f) => f.endsWith(".bak"));
    expect(bakFiles.length).toBe(1);
    // Most recent bak should contain v2
    expect(await fs.readFile(bakFiles[0]!)).toBe("v2");
  });

  it("verifies content with expectedContent option", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";

    await atomicWriteMarkdown(fs, path, "hello", "op-001", {
      expectedContent: "hello",
    });

    expect(await fs.readFile(path)).toBe("hello");
  });

  it("throws when expectedContent mismatches", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";

    await expect(
      atomicWriteMarkdown(fs, path, "actual", "op-001", {
        expectedContent: "different",
      })
    ).rejects.toThrow();
  });

  it("verifies content with expectedHash option", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";
    const { sha256 } = await import("../src/vault/scanner");
    const content = "verify me";
    const hash = sha256(content);

    await atomicWriteMarkdown(fs, path, content, "op-001", {
      expectedHash: hash,
    });

    expect(await fs.readFile(path)).toBe(content);
  });

  it("throws when expectedHash mismatches", async () => {
    const fs = new MemoryFileSystem();
    const path = "_个人认知系统/test.md";

    await expect(
      atomicWriteMarkdown(fs, path, "actual", "op-001", {
        expectedHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      })
    ).rejects.toThrow();
  });

  it("rejects writes outside allowed root", async () => {
    const fs = new MemoryFileSystem();

    await expect(
      atomicWriteMarkdown(fs, "outside/file.md", "content", "op-001")
    ).rejects.toThrow();
  });
});

// ─── renderEndorsedMarkdown ────────────────────────────────────

describe("renderEndorsedMarkdown", () => {
  it("generates frontmatter and body for endorsed claims", () => {
    const claims: Claim[] = [
      makeClaim({ claim_id: "c1", canonical_text: "I believe in testing", claim_type: "current_viewpoint" }),
    ];
    const result = renderEndorsedMarkdown(claims);

    // Frontmatter present
    expect(result).toContain("---");
    expect(result).toContain("generated_at:");
    expect(result).toContain("claim_count: 1");
    expect(result).toContain("model_version:");

    // Body: title
    expect(result).toContain("# ");
    // Body: claim text escaped
    expect(result).toContain("I believe in testing");
    // Body: epistemic status
    expect(result).toContain("user_confirmed");
  });

  it("handles empty claims array", () => {
    const result = renderEndorsedMarkdown([]);
    expect(result).toContain("claim_count: 0");
  });

  it("escapes dangerous characters in claim text", () => {
    const claims: Claim[] = [
      makeClaim({ canonical_text: "<script>alert('xss')</script>" }),
    ];
    const result = renderEndorsedMarkdown(claims);
    // < and ' are HTML-encoded; > is not (it's safe in HTML context)
    expect(result).toContain("&lt;script>");
    expect(result).toContain("&#39;");
    expect(result).not.toContain("<script>");
  });
});

// ─── renderConfirmedObservationsMarkdown ───────────────────────

describe("renderConfirmedObservationsMarkdown", () => {
  it("generates frontmatter and body", () => {
    const claims: Claim[] = [
      makeClaim({ claim_id: "o1", canonical_text: "Observed pattern", claim_type: "observation" }),
    ];
    const result = renderConfirmedObservationsMarkdown(claims);
    expect(result).toContain("---");
    expect(result).toContain("claim_count: 1");
    expect(result).toContain("Observed pattern");
  });
});

// ─── renderAiHypothesesMarkdown ────────────────────────────────

describe("renderAiHypothesesMarkdown", () => {
  it("generates frontmatter and body", () => {
    const claims: Claim[] = [
      makeClaim({
        claim_id: "h1",
        canonical_text: "AI hypothesis",
        epistemic_status: "ai_inferred",
        user_stance: "unconfirmed",
      }),
    ];
    const result = renderAiHypothesesMarkdown(claims);
    expect(result).toContain("---");
    expect(result).toContain("claim_count: 1");
    expect(result).toContain("ai_inferred");
  });
});

// ─── renderToVerifyMarkdown ────────────────────────────────────

describe("renderToVerifyMarkdown", () => {
  it("generates frontmatter and body", () => {
    const claims: Claim[] = [
      makeClaim({
        claim_id: "v1",
        canonical_text: "Need to verify this",
        epistemic_status: "to_verify",
        user_stance: "unconfirmed",
      }),
    ];
    const result = renderToVerifyMarkdown(claims);
    expect(result).toContain("---");
    expect(result).toContain("claim_count: 1");
    expect(result).toContain("to_verify");
  });
});

// ─── renderCurrentGoalsMarkdown ────────────────────────────────

describe("renderCurrentGoalsMarkdown", () => {
  it("generates frontmatter with goal counts", () => {
    const goals = makeGoalState({
      long_term_goals: [
        { goal_id: "g1", text: "Learn TypeScript", horizon: "long_term", status: "active" },
      ],
      weekly_result: { goal_id: "w1", text: "Write tests", horizon: "weekly", status: "active" },
    });
    const result = renderCurrentGoalsMarkdown(goals);
    expect(result).toContain("---");
    expect(result).toContain("active_long_term: 1");
    expect(result).toContain("Learn TypeScript");
    expect(result).toContain("Write tests");
  });

  it("handles empty goals", () => {
    const result = renderCurrentGoalsMarkdown(makeGoalState());
    expect(result).toContain("active_long_term: 0");
  });

  it("escapes dangerous content in goal text", () => {
    const goals = makeGoalState({
      long_term_goals: [
        { goal_id: "g1", text: "Test <script> & [[link]]", horizon: "long_term", status: "active" },
      ],
    });
    const result = renderCurrentGoalsMarkdown(goals);
    expect(result).not.toContain("<script>");
    expect(result).not.toMatch(/[^\\]\[\[/);
  });
});

// ─── renderGoalHistoryMarkdown ─────────────────────────────────

describe("renderGoalHistoryMarkdown", () => {
  it("generates frontmatter with total count", () => {
    const history: GoalState[] = [
      makeGoalState({
        long_term_goals: [
          { goal_id: "g1", text: "Goal 1", horizon: "long_term", status: "completed" },
        ],
      }),
    ];
    const result = renderGoalHistoryMarkdown(history);
    expect(result).toContain("---");
    expect(result).toContain("entry_count: 1");
    expect(result).toContain("completed");
  });

  it("handles empty history", () => {
    const result = renderGoalHistoryMarkdown([]);
    expect(result).toContain("entry_count: 0");
  });
});

// ─── renderActiveValidationsMarkdown ───────────────────────────

describe("renderActiveValidationsMarkdown", () => {
  it("generates frontmatter and body for active validations", () => {
    const validations: ValidationExperiment[] = [
      makeValidation({ experiment_id: "v1", action: "Run experiment", status: "active" }),
    ];
    const result = renderActiveValidationsMarkdown(validations);
    expect(result).toContain("---");
    expect(result).toContain("active_count: 1");
    expect(result).toContain("Run experiment");
    expect(result).toContain("active");
  });

  it("filters to only active validations", () => {
    const validations: ValidationExperiment[] = [
      makeValidation({ experiment_id: "v1", status: "active" }),
      makeValidation({ experiment_id: "v2", status: "completed" }),
      makeValidation({ experiment_id: "v3", status: "backlog" }),
    ];
    const result = renderActiveValidationsMarkdown(validations);
    expect(result).toContain("active_count: 1");
    expect(result).toContain("v1");
    expect(result).not.toContain("v2");
  });
});

// ─── renderValidationHistoryMarkdown ───────────────────────────

describe("renderValidationHistoryMarkdown", () => {
  it("generates frontmatter with total count", () => {
    const validations: ValidationExperiment[] = [
      makeValidation({ status: "completed" }),
      makeValidation({ experiment_id: "v2", status: "cancelled" }),
    ];
    const result = renderValidationHistoryMarkdown(validations);
    expect(result).toContain("---");
    expect(result).toContain("total_count: 2");
  });
});

// ─── renderDialogueArchiveMarkdown ─────────────────────────────

describe("renderDialogueArchiveMarkdown", () => {
  it("generates frontmatter with session metadata", () => {
    const archive: DialogueArchiveRecord[] = [
      makeTextArchive({ role: "ai_question", content: "What do you think?" }),
    ];
    const result = renderDialogueArchiveMarkdown(archive, "session-1", "2024-01-01");
    expect(result).toContain("---");
    expect(result).toContain("session_id: session-1");
    expect(result).toContain("date: 2024-01-01");
    expect(result).toContain("record_count: 1");
  });

  it("escapes dangerous content in archive records", () => {
    const archive: DialogueArchiveRecord[] = [
      makeTextArchive({ content: "<script>alert(1)</script>" }),
    ];
    const result = renderDialogueArchiveMarkdown(archive, "s1", "2024-01-01");
    expect(result).not.toContain("<script>");
    // < is HTML-encoded to &lt;; > is not encoded (safe in HTML)
    expect(result).toContain("&lt;script>");
  });

  it("handles result archive records", () => {
    const record: DialogueArchiveRecord = {
      role: "formal_result",
      candidate_id: "cand-1",
      text: "A formal conclusion",
      explanation: "Based on evidence",
      claim_type: "current_viewpoint",
      origin: "dialogue",
      epistemic_status: "user_confirmed",
      revision_target: null,
      confirmation: {
        user_statement: "I agree",
        confirmed_at: "2024-01-01T00:00:00.000Z",
        session_id: "s1",
        turn_index: 0,
        candidate_ids: ["cand-1"],
      },
      topic_id: "topic-1",
      recorded_at: "2024-01-01T00:00:00.000Z",
    };
    const result = renderDialogueArchiveMarkdown([record], "s1", "2024-01-01");
    expect(result).toContain("cand-1");
    expect(result).toContain("formal_result");
  });
});

// ─── renderWeeklyReviewMarkdown ────────────────────────────────

describe("renderWeeklyReviewMarkdown", () => {
  it("generates frontmatter with week metadata", () => {
    const result = renderWeeklyReviewMarkdown(
      "2026-W31",
      42,
      "Completed 2 goals",
      "3 validations in progress",
      ["Key insight 1", "Key insight 2"]
    );
    expect(result).toContain("---");
    expect(result).toContain("week: 2026-W31");
    expect(result).toContain("note_count: 42");
    expect(result).toContain("# 每周回顾: 2026-W31");
  });

  it("includes all sections", () => {
    const result = renderWeeklyReviewMarkdown(
      "2026-W31",
      10,
      "Goals summary here",
      "Validation feedback here",
      ["Takeaway A", "Takeaway B"]
    );
    expect(result).toContain("## 笔记概况");
    expect(result).toContain("## 目标进展");
    expect(result).toContain("## 验证反馈");
    expect(result).toContain("## 关键收获");
    expect(result).toContain("Takeaway A");
    expect(result).toContain("Takeaway B");
  });

  it("escapes dangerous characters in summaries", () => {
    const result = renderWeeklyReviewMarkdown(
      "2026-W31",
      5,
      "<script>xss</script>",
      "[[dangerous]]",
      []
    );
    expect(result).not.toContain("<script>");
    expect(result).not.toMatch(/[^\\]\[\[/);
  });
});

// ─── MemoryFileSystem CRUD ─────────────────────────────────────

describe("MemoryFileSystem", () => {
  it("supports write and read", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("test.md", "hello");
    expect(await fs.readFile("test.md")).toBe("hello");
  });

  it("supports fileExists", async () => {
    const fs = new MemoryFileSystem();
    expect(await fs.fileExists("test.md")).toBe(false);
    await fs.writeFile("test.md", "hello");
    expect(await fs.fileExists("test.md")).toBe(true);
  });

  it("supports copyFile", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("source.md", "data");
    await fs.copyFile("source.md", "target.md");
    expect(await fs.readFile("target.md")).toBe("data");
  });

  it("supports deleteFile", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("test.md", "data");
    await fs.deleteFile("test.md");
    expect(await fs.fileExists("test.md")).toBe(false);
  });

  it("supports listFiles with prefix filtering", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("dir/a.md", "a");
    await fs.writeFile("dir/b.md", "b");
    await fs.writeFile("other/c.md", "c");

    const dirFiles = await fs.listFiles("dir/");
    expect(dirFiles).toHaveLength(2);
    expect(dirFiles).toContain("dir/a.md");
    expect(dirFiles).toContain("dir/b.md");
  });

  it("throws on reading non-existent file", async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.readFile("nope.md")).rejects.toThrow();
  });

  it("throws on copying non-existent source", async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.copyFile("nope.md", "target.md")).rejects.toThrow();
  });
});
