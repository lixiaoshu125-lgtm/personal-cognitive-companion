/**
 * Topic AI — Task 08
 *
 * AI prompt builder and Zod schema for topic preparation.
 * Takes new notes + backlog topics → asks AI to merge, deduplicate,
 * and rank candidate topics for weekly review.
 */

import { z } from "zod";
import type { AiCompletionRequest } from "../ai/provider";
import type { PreparedTopic } from "./preparation-service";
import type { NewsHeadline } from "../news/fetcher";

// ═══════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════

const aiTopicSchema = z.object({
  topic_id: z.string().min(1),
  source_note_id: z.string().nullable().optional(),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  representative_excerpts: z.array(z.string().max(200)),
  relevance_score: z.number().min(0).max(1),
  /** Explicit marker: true if this topic was derived from news headlines. */
  is_news_related: z.boolean().default(false),
});

export const preparedTopicsSchema = z.object({
  topics: z.array(aiTopicSchema),
});

export type PreparedTopicsAiOutput = z.infer<typeof preparedTopicsSchema>;

// ═══════════════════════════════════════════════════════════════
// NoteSummary
// ═══════════════════════════════════════════════════════════════

export interface NoteSummary {
  noteId: string;
  path: string;
  title: string;
  excerpt: string; // first 300 chars
}

// ═══════════════════════════════════════════════════════════════
// Prompt builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build a structured AI completion request for topic preparation.
 *
 * Input includes:
 *  - New notes added this week (with excerpts)
 *  - Backlog topics from previous weeks (pending/snoozed)
 *
 * The AI is asked to:
 *  1. Generate candidate topics from new notes
 *  2. Merge with backlog (dedup by note+title)
 *  3. Sort by relevance (most important first)
 *  4. Respect maxTopics limit
 */
export function buildTopicPreparationPrompt(params: {
  newNotes: readonly NoteSummary[];
  backlogTopics: readonly PreparedTopic[];
  newsHeadlines: readonly NewsHeadline[];
  maxTopics: number;
}): AiCompletionRequest<PreparedTopicsAiOutput> {
  const { newNotes, backlogTopics, newsHeadlines, maxTopics } = params;

  const hasNews = newsHeadlines.length > 0;

  const newsCount = Math.min(3, maxTopics);
  const noteCount = maxTopics - newsCount;

  const systemPrompt = [
    "你是一个个人认知伴侣的主题分析器。",
    "你的任务是：从本周新增笔记、历史未讨论主题、以及社会热点中，生成候选讨论主题列表。",
    "",
    "硬性要求：",
    `- 必须生成 ${newsCount} 个基于近期社会热点/新闻的主题。这些主题必须与当下社会讨论相关（科技趋势、经济动态、社会现象等）。`,
    ...(hasNews
      ? [
          "- 优先使用下方提供的新闻头条来生成新闻主题。",
          "- 新闻主题的 source_note_id 设为 null，is_news_related 设为 true，representative_excerpts 用新闻摘要原文。",
        ]
      : [
          "- 当前没有新闻头条数据，请根据你掌握的社会热点知识生成新闻主题。",
          "- 新闻主题的 source_note_id 设为 null，is_news_related 设为 true。",
        ]),
    `- 其余 ${noteCount} 个主题从用户笔记中生成，is_news_related 设为 false。`,
    "- 如果历史 backlog 中已有相似主题，合并而非重复创建。",
    "- 相同笔记+相同标题视为重复，只保留一个。",
    "- 按 relevance_score（0-1）降序排列，最重要的在最前。",
    `- 最多返回 ${maxTopics} 个候选主题。`,
    "- title 用中文，简洁（不超过 80 字）。",
    "- description 用 1-2 句话描述（不超过 300 字）。",
    "- representative_excerpts 为原文代表性片段（每个不超过 200 字）。",
    "- 只输出 JSON，不要有其他文字。",
    "",
    "必须严格按以下 JSON 格式输出：",
    '{ "topics": [',
    '  { "topic_id": "唯一ID", "source_note_id": "笔记ID或null", "title": "主题标题", "description": "1-2句描述", "representative_excerpts": ["原文片段"], "relevance_score": 0.8, "is_news_related": false }',
    "] }",
  ].join("\n");

  const userContent: Record<string, unknown> = {
    new_notes: newNotes.map((n) => ({
      noteId: n.noteId,
      path: n.path,
      title: n.title,
      excerpt: n.excerpt,
    })),
    backlog_topics: backlogTopics.map((t) => ({
      topic_id: t.topic_id,
      title: t.title,
      description: t.description,
      source_note_id: t.source_note_id,
      status: t.status,
      created_week_id: t.created_week_id,
    })),
    ...(hasNews ? {
      news_headlines: newsHeadlines.map((h) => ({
        title: h.title,
        summary: h.summary,
        source: h.source,
      })),
    } : {}),
    max_topics: maxTopics,
  };

  return {
    outputName: "weekly_topic_preparation",
    outputSchema: preparedTopicsSchema,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userContent) },
    ],
  };
}
