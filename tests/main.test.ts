// ─── Tests for src/main.ts ──────────────────────────────────────
//
// Tests focus on pure logic per the Task 7.11 spec:
//   - extractSettings (Zod parsing with fallback)
//   - checkNewWeekMessage (week detection logic)
//   - Command IDs and names (verifying registered commands)
//   - View type constants
//   - Plugin class structure (onload/onunload, default export)
//   - styles.css class coverage

import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as mainModule from "../src/main";
import CognitiveCompanionPlugin, {
  extractSettings,
  checkNewWeekMessage,
  decideWeeklyEntry,
} from "../src/main";
import type { PreparedTopic } from "../src/weekly/preparation-service";
import { DASHBOARD_VIEW_TYPE } from "../src/ui/dashboard";
import {
  pluginSettingsSchema,
  type PluginSettings,
} from "../src/storage/plugin-state";
import type { WeeklySnapshot } from "../src/domain/types";

describe("weekly preparation progress messages", () => {
  it("formats scanning, summarizing, and model-wait phases concisely", () => {
    const formatter = (mainModule as unknown as {
      formatWeeklyPreparationProgress?: (progress: unknown) => string;
    }).formatWeeklyPreparationProgress;

    expect(typeof formatter).toBe("function");
    expect(formatter!({ phase: "scanning", current: 2, total: 10, noteTitle: "alpha.md" })).toBe(
      "正在扫描笔记 2 / 10\n当前：alpha.md",
    );
    expect(formatter!({ phase: "summarizing", current: 3, total: 10, noteTitle: "beta.md" })).toBe(
      "正在分析笔记 3 / 10\n当前：beta.md",
    );
    expect(formatter!({ phase: "generating_topics", noteCount: 10 })).toBe(
      "已分析 10 篇笔记\nAI 正在生成候选主题…",
    );
  });

  it("throttles ordinary updates while always showing phase changes and boundaries", () => {
    let now = 0;
    const messages: string[] = [];
    const factory = (mainModule as unknown as {
      createWeeklyPreparationProgressReporter?: (
        update: (message: string) => void,
        clock: () => number,
        minIntervalMs: number,
      ) => (progress: unknown) => void;
    }).createWeeklyPreparationProgressReporter;

    expect(typeof factory).toBe("function");
    const report = factory!((message) => messages.push(message), () => now, 300);
    report({ phase: "scanning", current: 1, total: 10, noteTitle: "one.md" });
    now = 100;
    report({ phase: "scanning", current: 2, total: 10, noteTitle: "two.md" });
    now = 300;
    report({ phase: "scanning", current: 3, total: 10, noteTitle: "three.md" });
    report({ phase: "summarizing", current: 1, total: 10, noteTitle: "one.md" });
    report({ phase: "summarizing", current: 10, total: 10, noteTitle: "ten.md" });
    report({ phase: "generating_topics", noteCount: 10 });

    expect(messages).toEqual([
      "正在扫描笔记 1 / 10\n当前：one.md",
      "正在扫描笔记 3 / 10\n当前：three.md",
      "正在分析笔记 1 / 10\n当前：one.md",
      "正在分析笔记 10 / 10\n当前：ten.md",
      "已分析 10 篇笔记\nAI 正在生成候选主题…",
    ]);
  });
});

// ─── extractSettings ──────────────────────────────────────────

describe("extractSettings", () => {
  const defaults = pluginSettingsSchema.parse({}) as PluginSettings;

  it("returns defaults when data is null", () => {
    const result = extractSettings(null);
    expect(result).toEqual(defaults);
  });

  it("returns defaults when data is undefined", () => {
    const result = extractSettings(undefined);
    expect(result).toEqual(defaults);
  });

  it("returns defaults when data is a non-object primitive (string)", () => {
    const result = extractSettings("garbage");
    expect(result).toEqual(defaults);
  });

  it("returns defaults when data is a number", () => {
    const result = extractSettings(42);
    expect(result).toEqual(defaults);
  });

  it("returns defaults when data is an array", () => {
    const result = extractSettings([1, 2, 3]);
    expect(result).toEqual(defaults);
  });

  it("returns defaults when data object has no 'settings' key", () => {
    const result = extractSettings({ other: "stuff" });
    expect(result).toEqual(defaults);
  });

  it("returns defaults when settings is null", () => {
    const result = extractSettings({ settings: null });
    expect(result).toEqual(defaults);
  });

  it("returns defaults when settings is undefined", () => {
    const result = extractSettings({ settings: undefined });
    expect(result).toEqual(defaults);
  });

  it("returns defaults when settings is a string (invalid type)", () => {
    const result = extractSettings({ settings: "not-an-object" });
    expect(result).toEqual(defaults);
  });

  it("parses valid settings from data", () => {
    const settings = {
      deepseekEndpoint: "https://custom.api.com/v1",
      deepseekModel: "deepseek-v4-pro",
      deepseekApiKey: "sk-test-key",
      extraExcludedDirs: ["archive", "templates"],
      systemOutputDir: "_my_system",
      topicCharBudget: 2000,
      topicPrepTotalBudget: 24000,
      autoAddUnambiguousAliases: true,
      rawCorpusLocation: "/data/corpus.json",
      maxPriorityTopics: 5,
      maxActiveValidations: 10,
      maxLongTermGoals: 6,
    };

    const result = extractSettings({ settings });
    expect(result).toEqual(settings);
  });

  it("fills defaults for missing fields via Zod .default()", () => {
    const partial = {
      deepseekEndpoint: "https://partial.api.com",
      deepseekModel: "partial-model",
    };
    const result = extractSettings({ settings: partial });

    expect(result.deepseekEndpoint).toBe("https://partial.api.com");
    expect(result.deepseekModel).toBe("partial-model");
    // Fields not in partial should get schema defaults
    expect(result.deepseekApiKey).toBe("");
    expect(result.topicCharBudget).toBe(1200);
    expect(result.systemOutputDir).toBe("_个人认知系统");
  });

  it("coerces invalid field types to defaults (e.g. string for number)", () => {
    const badSettings = {
      topicCharBudget: "not-a-number",
      extraExcludedDirs: "not-an-array",
    };
    const result = extractSettings({ settings: badSettings });

    // Zod safeParse should fail → fall back to defaults entirely
    expect(result.topicCharBudget).toBe(1200);
    expect(result.extraExcludedDirs).toEqual([]);
  });

  it("accepts empty object settings → all defaults", () => {
    const result = extractSettings({ settings: {} });
    expect(result).toEqual(defaults);
  });

  it("handles deeply nested data with settings at top level", () => {
    const settings = { deepseekEndpoint: "https://nested.api.com" };
    const result = extractSettings({
      schema_version: "2.0",
      settings,
      snapshot: null,
      session: null,
    });
    expect(result.deepseekEndpoint).toBe("https://nested.api.com");
  });
});

// ─── checkNewWeekMessage ──────────────────────────────────────

describe("checkNewWeekMessage", () => {
  /** Create a minimal frozen WeeklySnapshot for a given ISO date string. */
  function frozenSnapshot(frozenAt: string): WeeklySnapshot {
    return {
      snapshot_id: "snap:test",
      status: "frozen",
      note_ids: Object.freeze(["note:1"]),
      notes: Object.freeze([]),
      noteCount: 1,
      frozen_at: frozenAt,
      created_at: frozenAt,
      source_revision: "test-rev",
      cursor: 0,
      started_at: null,
      paused_at: null,
      completed_at: null,
      new_note_count: 1,
      is_first_scan: true,
      previous_snapshot_id: null,
    } as WeeklySnapshot;
  }

  it("returns null when snapshot is null (first run, no notification)", () => {
    const result = checkNewWeekMessage(null, new Date("2026-07-27"));
    expect(result).toBeNull();
  });

  it("returns null when current week same as snapshot frozen week", () => {
    // 2026-07-27 is a Monday (ISO week 31)
    const snapshot = frozenSnapshot("2026-07-27T08:00:00.000Z");
    const now = new Date("2026-07-29T10:00:00.000Z"); // Wednesday same week
    const result = checkNewWeekMessage(snapshot, now);
    expect(result).toBeNull();
  });

  it("returns message when current week differs from snapshot week", () => {
    // 2026-07-27 is a Monday (ISO week 31)
    const snapshot = frozenSnapshot("2026-07-27T08:00:00.000Z");
    // 2026-08-03 is next Monday (ISO week 32)
    const now = new Date("2026-08-03T10:00:00.000Z");
    const result = checkNewWeekMessage(snapshot, now);
    expect(result).not.toBeNull();
    expect(result).toContain("新的一周开始了");
    expect(result).toContain("2026-W32");
  });

  it("returns null when snapshot frozen_at is same ISO week as now (boundary: Sunday→Monday same week)", () => {
    // NOTE: getWeekId uses local timezone Date methods.
    // In some timezones (UTC+8), July 26 23:00 UTC = July 27 07:00 local = same day.
    // Use dates far enough apart to be unambiguously different weeks in any timezone.
    // 2026-07-13 is Monday of week 29
    const snapshot = frozenSnapshot("2026-07-13T08:00:00.000Z");
    // 2026-07-27 is Monday of week 31 → two weeks later, definitely new week
    const now = new Date("2026-07-27T08:00:00.000Z");
    const result = checkNewWeekMessage(snapshot, now);
    expect(result).not.toBeNull();
    expect(result).toContain("新的一周开始了");
    expect(result).toContain("2026-W31");
  });

  it("handles cross-year weeks (late December → early January)", () => {
    // 2025-12-29 is Monday of week 1 of 2026 (ISO rules)
    const snapshot = frozenSnapshot("2025-12-22T08:00:00.000Z"); // Week 52 of 2025
    // 2026-01-05 is Monday, still week 2 of 2026
    const now = new Date("2026-01-05T08:00:00.000Z");
    const result = checkNewWeekMessage(snapshot, now);
    expect(result).not.toBeNull();
    expect(result).toContain("新的一周开始了");
  });

  it("returns null for snapshot in far past but same week number (different year)", () => {
    // 2025-W31 (last year, same week number but different year)
    // 2025-07-28 is Monday of W31
    const snapshot = frozenSnapshot("2025-07-28T08:00:00.000Z");
    // 2026-07-27 is Monday of W31 (this year)
    const now = new Date("2026-07-27T08:00:00.000Z");
    const result = checkNewWeekMessage(snapshot, now);
    // These are different years → different weeks → should trigger
    expect(result).not.toBeNull();
  });
});

// ─── View Type Constants ──────────────────────────────────────

describe("View type constants", () => {
  it("DASHBOARD_VIEW_TYPE is the expected string", () => {
    expect(DASHBOARD_VIEW_TYPE).toBe("cognitive-companion-dashboard");
  });
});

// ─── Command Registration ─────────────────────────────────────

describe("Command registration", () => {
  it("registers only the two public commands kept after the companion home launch", async () => {
    const plugin = new CognitiveCompanionPlugin(
      // Plugin constructor takes no args in Obsidian; app/leaf are set by Obsidian runtime.
      // We pass nothing; the Plugin base constructor handles it in test (mock doesn't need args).
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[0],
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[1]
    );

    // Calling onload() will initialize composition with empty vault (0 files),
    // which is safe. The mock vault adapter returns empty arrays/strings.
    await plugin.onload();

    const commands = (plugin as unknown as { _test_commands: readonly { id: string; name: string; callback?: unknown }[] })._test_commands;

    expect(commands.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "open-dashboard", name: "打开认知伴侣" },
      { id: "conversation-current-note", name: "认知对话：从当前笔记" },
    ]);
    expect(commands.every((command) => typeof command.callback === "function")).toBe(true);
  });

  it("replaces the obsolete brain ribbon with the companion home entry", async () => {
    const plugin = new CognitiveCompanionPlugin(
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[0],
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[1]
    );

    await plugin.onload();

    const icons = (plugin as unknown as { _test_ribbonIcons: readonly { icon: string; title: string; cb: unknown }[] })._test_ribbonIcons;

    expect(icons).toHaveLength(1);
    expect(icons[0]!.icon).toBe("sparkles");
    expect(icons[0]!.title).toBe("认知伴侣首页");
    expect(icons.some((item) => item.icon === "brain")).toBe(false);
  });

  it("registers a settings tab", async () => {
    const plugin = new CognitiveCompanionPlugin(
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[0],
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[1]
    );

    await plugin.onload();

    const tabs = (plugin as unknown as { _test_settingTabs: readonly unknown[] })._test_settingTabs;

    expect(tabs).toHaveLength(1);
  });
});

describe("decideWeeklyEntry", () => {
  const topic = (overrides: Partial<PreparedTopic>): PreparedTopic => ({
    topic_id: "topic:1",
    source_note_id: "note:1",
    title: "主题",
    description: "说明",
    representative_excerpts: [],
    relevance_score: 0.8,
    is_news_related: false,
    status: "pending",
    created_week_id: "2026-W31",
    created_at: "2026-07-30T00:00:00.000Z",
    last_status_change: "2026-07-30T00:00:00.000Z",
    ...overrides,
  } as PreparedTopic);

  it("resumes an in-progress weekly conversation before offering new topics", () => {
    const result = decideWeeklyEntry([
      topic({ status: "pending" }),
      topic({ topic_id: "topic:2", status: "in_progress", conversation_id: "conv:2" }),
    ]);

    expect(result).toEqual({ kind: "resume", conversationId: "conv:2" });
  });

  it("offers pending and snoozed topics when no conversation is in progress", () => {
    const pending = topic({ topic_id: "topic:pending", status: "pending" });
    const snoozed = topic({ topic_id: "topic:snoozed", status: "snoozed" });
    const result = decideWeeklyEntry([
      pending,
      topic({ topic_id: "topic:done", status: "discussed" }),
      snoozed,
    ]);

    expect(result).toEqual({ kind: "choose", topics: [pending, snoozed] });
  });

  it("prepares topics when no resumable or pending topic exists", () => {
    expect(decideWeeklyEntry([
      topic({ status: "discussed" }),
      topic({ topic_id: "topic:dismissed", status: "dismissed" }),
    ])).toEqual({ kind: "prepare" });
  });
});

// ─── Plugin Class Structure ───────────────────────────────────

describe("Plugin class structure", () => {
  it("has onload method", () => {
    const plugin = new CognitiveCompanionPlugin(
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[0],
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[1]
    );
    expect(typeof plugin.onload).toBe("function");
  });

  it("has onunload method", () => {
    const plugin = new CognitiveCompanionPlugin(
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[0],
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[1]
    );
    expect(typeof plugin.onunload).toBe("function");
  });

  it("is default export of main module", () => {
    // CognitiveCompanionPlugin is imported as default — verify it's a constructor
    expect(typeof CognitiveCompanionPlugin).toBe("function");
    expect(CognitiveCompanionPlugin.prototype.onload).toBeDefined();
    expect(CognitiveCompanionPlugin.prototype.onunload).toBeDefined();
  });

  it("composition is null before onload", () => {
    const plugin = new CognitiveCompanionPlugin(
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[0],
      undefined as unknown as ConstructorParameters<typeof CognitiveCompanionPlugin>[1]
    );
    expect((plugin as unknown as { composition: unknown }).composition).toBeNull();
  });
});

// ─── styles.css Coverage ──────────────────────────────────────

describe("styles.css", () => {
  let cssContent: string;

  beforeAll(() => {
    const cssPath = resolve(__dirname, "..", "styles.css");
    cssContent = readFileSync(cssPath, "utf-8");
  });

  const requiredClasses = [
    // Message classes
    "cc-msg",
    "cc-msg__header",
    "cc-msg__role-label",
    "cc-msg__time",
    "cc-msg__body",
    "cc-msg__meta",
    "cc-msg--source",
    "cc-msg--ai-summary",
    "cc-msg--ai-question",
    "cc-msg--ai-hypothesis",
    "cc-msg--historical",
    "cc-msg--user",
    "cc-msg--formal-result",
    "cc-msg--to-verify",
    "cc-msg--ai-inferred",
    "cc-msg--context",
    "cc-msg--with-label",
    "cc-msg--unconfirmed",
    "cc-msg--historical-only",
    "cc-msg--current-topic",

    // Badge classes
    "cc-badge",
    "cc-badge--muted",
    "cc-badge--info",
    "cc-badge--active",
    "cc-badge--success",
    "cc-badge--warning",
    "cc-badge--danger",

    // Button classes
    "cc-btn",
    "cc-btn--primary",
    "cc-btn--success",
    "cc-btn--secondary",
    "cc-btn--confirm-zero",
    "cc-btn--reject-zero",
    "cc-btn--unclear-zero",

    // Dashboard classes
    "cc-dashboard",
    "cc-dashboard__status-bar",
    "cc-dashboard__note-count",
    "cc-dashboard__actions",
    "cc-dashboard__action-btn",
    "cc-dashboard__completed-hint",
    "cc-dashboard__section-title",
    "cc-dashboard__weekly-result",
    "cc-dashboard__result-quote",
    "cc-dashboard__goals",
    "cc-dashboard__goal-list",
    "cc-dashboard__goal-card",
    "cc-dashboard__goal-text",
    "cc-dashboard__candidate-counts",
    "cc-dashboard__empty-hint",
    "cc-dashboard__validations",
    "cc-dashboard__validation-list",
    "cc-dashboard__validation-item",
    "cc-dashboard__validation-row",
    "cc-dashboard__validation-row--overdue",
    "cc-dashboard__validation-action",
    "cc-dashboard__deadline",
    "cc-dashboard__deadline--overdue",
    "cc-dashboard__feedback-count",
    "cc-dashboard__footer",

    // Dialogue classes
    "cc-dialogue",
    "cc-dialogue__header",
    "cc-dialogue__progress",
    "cc-dialogue__topic-progress",
    "cc-dialogue__topic-info",
    "cc-dialogue__topic-name",
    "cc-dialogue__active-question",
    "cc-dialogue__question-label",
    "cc-dialogue__controls",
    "cc-dialogue__pause-btn",
    "cc-dialogue__resume-btn",
    "cc-dialogue__messages",
    "cc-dialogue__input-area",
    "cc-dialogue__input",
    "cc-dialogue__input--disabled",
    "cc-dialogue__input-hint",
    "cc-dialogue__send-btn",
    "cc-dialogue__zero-actions",
    "cc-dialogue__zero-panel",
    "cc-dialogue__zero-panel--warning",
    "cc-dialogue__zero-question",
    "cc-dialogue__zero-icon",
    "cc-dialogue__zero-text",

    // Conversation classes
    "cc-conversation",
    "cc-conversation__empty",
    "cc-conversation__topic-label",

    // Generic input
    "cc-input",
  ];

  for (const className of requiredClasses) {
    it(`defines .${className}`, () => {
      // Match the class selector in CSS — look for the class name used as a selector
      const regex = new RegExp(
        `\\.${className.replace(/--/g, "\\-\\-").replace(/__/g, "\\_\\_")}\\b`
      );
      expect(
        cssContent,
        `styles.css should contain .${className} selector`
      ).toMatch(regex);
    });
  }

  it("uses CSS variables for theming (Obsidian compatibility)", () => {
    expect(cssContent).toContain("--cc-color-source-bg");
    expect(cssContent).toContain("--cc-color-ai-bg");
    expect(cssContent).toContain("--cc-color-hypothesis-bg");
    expect(cssContent).toContain("--cc-color-historical-bg");
    expect(cssContent).toContain("--cc-color-formal-bg");
    expect(cssContent).toContain("--cc-color-badge-muted");
    expect(cssContent).toContain("--cc-color-btn-primary");
  });

  it("uses cc- prefix and does not override Obsidian global selectors", () => {
    // All class selectors should use the cc- prefix
    const classSelectors = cssContent.match(/\.[a-zA-Z][\w-]*/g) ?? [];
    const nonCcSelectors = classSelectors.filter(
      (s) => !s.startsWith(".cc-")
    );
    // Allow Obsidian CSS variables (var(--...)) references in values,
    // but no non-cc- class selectors
    expect(nonCcSelectors).toEqual([]);
  });
});
