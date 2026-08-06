/**
 * Tests for src/weekly/topic-ai.ts — Task 08
 *
 * Covers: prompt building, schema validation, edge cases.
 */

import { describe, expect, it } from "vitest";
import {
  buildTopicPreparationPrompt,
  preparedTopicsSchema,
  type NoteSummary,
} from "../src/weekly/topic-ai";
import type { PreparedTopic } from "../src/weekly/preparation-service";

// ─── Helpers ──────────────────────────────────────────────────

function makeNoteSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    noteId: "note:1",
    path: "notes/test.md",
    title: "测试笔记",
    excerpt: "这是一篇关于个人成长的笔记...",
    ...overrides,
  };
}

function makeBacklogTopic(overrides: Partial<PreparedTopic> = {}): PreparedTopic {
  return {
    topic_id: "topic:backlog:1",
    source_note_id: "note:old",
    title: "旧主题",
    description: "一个来自之前的未讨论主题",
    representative_excerpts: ["旧笔记片段"],
    relevance_score: 0.5,
    status: "pending",
    created_week_id: "2026-W30",
    created_at: "2026-07-20T08:00:00.000Z",
    last_status_change: "2026-07-20T08:00:00.000Z",
    ...overrides,
  } as PreparedTopic;
}

// ═══════════════════════════════════════════════════════════════

describe("buildTopicPreparationPrompt", () => {
  // Scenario 1: buildPrompt includes new note summaries
  it("includes new note summaries in the user message", () => {
    const notes: NoteSummary[] = [
      makeNoteSummary({ noteId: "note:a", title: "笔记A" }),
      makeNoteSummary({ noteId: "note:b", title: "笔记B" }),
    ];

    const request = buildTopicPreparationPrompt({
      newNotes: notes,
      backlogTopics: [],
      newsHeadlines: [],
      maxTopics: 10,
    });

    expect(request.outputName).toBe("weekly_topic_preparation");
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]!.role).toBe("system");
    expect(request.messages[1]!.role).toBe("user");

    const userContent = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
    const newNotes = userContent.new_notes as Array<Record<string, unknown>>;
    expect(newNotes).toHaveLength(2);
    expect(newNotes[0]!.noteId).toBe("note:a");
    expect(newNotes[1]!.noteId).toBe("note:b");
  });

  // Scenario 2: buildPrompt includes backlog summaries
  it("includes backlog topic summaries in the user message", () => {
    const backlog: PreparedTopic[] = [
      makeBacklogTopic({ topic_id: "topic:old:1", title: "旧主题1" }),
      makeBacklogTopic({ topic_id: "topic:old:2", title: "旧主题2", status: "snoozed" }),
    ];

    const request = buildTopicPreparationPrompt({
      newNotes: [],
      backlogTopics: backlog,
      newsHeadlines: [],
      maxTopics: 5,
    });

    const userContent = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
    const backlogTopics = userContent.backlog_topics as Array<Record<string, unknown>>;
    expect(backlogTopics).toHaveLength(2);
    expect(backlogTopics[0]!.topic_id).toBe("topic:old:1");
    expect(backlogTopics[1]!.status).toBe("snoozed");
  });

  // Scenario 3: schema validates normal output
  it("schema validates normal AI output", () => {
    const output = {
      topics: [
        {
          topic_id: "topic:1",
          source_note_id: "note:a",
          title: "个人成长反思",
          description: "关于自我提升和学习的思考",
          representative_excerpts: ["最近我在思考..."],
          relevance_score: 0.85,
        },
        {
          topic_id: "topic:2",
          title: "跨笔记主题",
          description: "跨多篇笔记的共性问题",
          representative_excerpts: ["片段1", "片段2"],
          relevance_score: 0.7,
        },
      ],
    };

    const parsed = preparedTopicsSchema.safeParse(output);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.topics).toHaveLength(2);
      expect(parsed.data.topics[0]!.title).toBe("个人成长反思");
      // source_note_id can be null or undefined
      expect(parsed.data.topics[1]!.source_note_id).toBeUndefined();
    }
  });

  // Scenario 4: schema rejects title-less topic
  it("schema rejects topics without a title", () => {
    const output = {
      topics: [
        {
          topic_id: "topic:1",
          title: "",
          description: "描述",
          representative_excerpts: [],
          relevance_score: 0.5,
        },
      ],
    };

    const parsed = preparedTopicsSchema.safeParse(output);
    expect(parsed.success).toBe(false);
  });

  // Scenario 5: schema rejects overlong description
  it("schema rejects topics with overlong description (> 300 chars)", () => {
    const output = {
      topics: [
        {
          topic_id: "topic:1",
          title: "正常标题",
          description: "x".repeat(301),
          representative_excerpts: [],
          relevance_score: 0.5,
        },
      ],
    };

    const parsed = preparedTopicsSchema.safeParse(output);
    expect(parsed.success).toBe(false);
  });

  // Scenario 6: schema rejects out-of-bounds relevance_score
  it("schema rejects relevance_score outside 0-1 range", () => {
    const tooHigh = {
      topics: [
        {
          topic_id: "topic:1",
          title: "测试",
          description: "描述",
          representative_excerpts: [],
          relevance_score: 1.5,
        },
      ],
    };

    expect(preparedTopicsSchema.safeParse(tooHigh).success).toBe(false);

    const negative = {
      topics: [
        {
          topic_id: "topic:1",
          title: "测试",
          description: "描述",
          representative_excerpts: [],
          relevance_score: -0.1,
        },
      ],
    };

    expect(preparedTopicsSchema.safeParse(negative).success).toBe(false);
  });

  // Scenario 7: maxTopics is included in the prompt
  it("includes maxTopics limit in the system prompt", () => {
    const request = buildTopicPreparationPrompt({
      newNotes: [],
      backlogTopics: [],
      newsHeadlines: [],
      maxTopics: 7,
    });

    const systemContent = request.messages[0]!.content;
    expect(systemContent).toContain("7");
    expect(systemContent).toContain("最多返回");
  });

  // Scenario 8: empty notes → only merges backlog
  it("handles empty new notes (only backlog topics)", () => {
    const backlog: PreparedTopic[] = [
      makeBacklogTopic({ topic_id: "topic:old:1" }),
    ];

    const request = buildTopicPreparationPrompt({
      newNotes: [],
      backlogTopics: backlog,
      newsHeadlines: [],
      maxTopics: 5,
    });

    const userContent = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
    const newNotes = userContent.new_notes as Array<unknown>;
    expect(newNotes).toHaveLength(0);

    const backlogTopics = userContent.backlog_topics as Array<unknown>;
    expect(backlogTopics).toHaveLength(1);
  });

  // Bonus: schema requires topic_id
  it("schema requires each topic to have a topic_id", () => {
    const output = {
      topics: [
        {
          // missing topic_id
          title: "测试",
          description: "描述",
          representative_excerpts: [],
          relevance_score: 0.5,
        },
      ],
    };

    const parsed = preparedTopicsSchema.safeParse(output);
    expect(parsed.success).toBe(false);
  });

  // Bonus: temperature is 0 for deterministic output
  it("sets temperature to 0 for deterministic output", () => {
    const request = buildTopicPreparationPrompt({
      newNotes: [],
      backlogTopics: [],
      newsHeadlines: [],
      maxTopics: 5,
    });

    expect(request.temperature).toBe(0);
  });
});
