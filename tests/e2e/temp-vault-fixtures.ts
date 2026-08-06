/**
 * Synthetic fixtures for temp-vault E2E journey tests (Task 11).
 *
 * All data is 100% synthetic — no real user notes, paths, or API keys.
 * These fixtures simulate realistic cognitive model data and vault notes
 * without touching any real Obsidian Vault or DeepSeek API.
 */

import type { Claim } from "../../src/domain/types";
import type { ModelEvent } from "../../src/storage/plugin-state";
import type { ConversationAiOutput } from "../../src/conversation/engine";

// ═══════════════════════════════════════════════════════════════════
// Synthetic Claims (simulating 10 real cognitive model claims)
// ═══════════════════════════════════════════════════════════════════

export const SYNTHETIC_CLAIMS: Claim[] = [
  {
    schema_version: "1.1",
    claim_id: "claim:synth:001",
    canonical_text: "深度工作需要每天至少2小时不受打扰的时间块",
    claim_type: "current_viewpoint",
    epistemic_status: "user_confirmed",
    user_stance: "endorsed",
    objective_truth_status: "unknown",
    formed_at: "2026-06-15T10:00:00.000Z",
    time_scope: "ongoing",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:work-habits"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-06-15T10:00:00.000Z",
    updated_at: "2026-06-15T10:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:002",
    canonical_text: "晚上9点后使用电子设备会显著影响睡眠质量",
    claim_type: "observation",
    epistemic_status: "user_confirmed",
    user_stance: "endorsed",
    objective_truth_status: "unknown",
    formed_at: "2026-06-20T08:00:00.000Z",
    time_scope: "ongoing",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:sleep-log"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-06-20T08:00:00.000Z",
    updated_at: "2026-06-20T08:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:003",
    canonical_text: "学习Rust语言是提升系统编程能力的有效路径",
    claim_type: "current_viewpoint",
    epistemic_status: "ai_inferred",
    user_stance: "unconfirmed",
    objective_truth_status: "unknown",
    formed_at: "2026-07-01T14:00:00.000Z",
    time_scope: "current",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:learning-plan"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-07-01T14:00:00.000Z",
    updated_at: "2026-07-01T14:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:004",
    canonical_text: "每周运动3次以上能明显改善注意力和工作效率",
    claim_type: "observation",
    epistemic_status: "to_verify",
    user_stance: "unconfirmed",
    objective_truth_status: "unknown",
    formed_at: "2026-07-05T09:00:00.000Z",
    time_scope: "current",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:health-log"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-07-05T09:00:00.000Z",
    updated_at: "2026-07-05T09:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:005",
    canonical_text: "个人知识管理工具需要结合LLM与本地优先存储",
    claim_type: "current_viewpoint",
    epistemic_status: "user_confirmed",
    user_stance: "endorsed",
    objective_truth_status: "unknown",
    formed_at: "2026-07-10T11:00:00.000Z",
    time_scope: "ongoing",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:project-ideas"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-07-10T11:00:00.000Z",
    updated_at: "2026-07-10T11:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:006",
    canonical_text: "咖啡因在下午4点后摄入会导致入睡困难",
    claim_type: "observation",
    epistemic_status: "user_confirmed",
    user_stance: "endorsed",
    objective_truth_status: "unknown",
    formed_at: "2026-06-25T07:00:00.000Z",
    time_scope: "ongoing",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:sleep-log"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-06-25T07:00:00.000Z",
    updated_at: "2026-06-25T07:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:007",
    canonical_text: "长期记忆的巩固需要间隔重复和主动回忆",
    claim_type: "current_viewpoint",
    epistemic_status: "ai_inferred",
    user_stance: "unconfirmed",
    objective_truth_status: "unknown",
    formed_at: "2026-07-12T16:00:00.000Z",
    time_scope: "current",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:learning-plan"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-07-12T16:00:00.000Z",
    updated_at: "2026-07-12T16:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:008",
    canonical_text: "早晨写作效率最高，适合处理复杂创作任务",
    claim_type: "observation",
    epistemic_status: "user_confirmed",
    user_stance: "endorsed",
    objective_truth_status: "unknown",
    formed_at: "2026-06-18T06:00:00.000Z",
    time_scope: "ongoing",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:work-habits"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-06-18T06:00:00.000Z",
    updated_at: "2026-06-18T06:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:009",
    canonical_text: "社交媒体的碎片化信息消费会削弱持续专注能力",
    claim_type: "current_viewpoint",
    epistemic_status: "to_verify",
    user_stance: "unconfirmed",
    objective_truth_status: "unknown",
    formed_at: "2026-07-15T12:00:00.000Z",
    time_scope: "current",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:digital-habits"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-07-15T12:00:00.000Z",
    updated_at: "2026-07-15T12:00:00.000Z",
  },
  {
    schema_version: "1.1",
    claim_id: "claim:synth:010",
    canonical_text: "确立清晰的年度目标能有效指导日常决策优先级",
    claim_type: "current_viewpoint",
    epistemic_status: "user_confirmed",
    user_stance: "endorsed",
    objective_truth_status: "unknown",
    formed_at: "2026-05-10T10:00:00.000Z",
    time_scope: "ongoing",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: ["note:synth:yearly-goals"],
    source_topic_ids: [],
    source_dialogue_refs: [],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: 1,
    created_at: "2026-05-10T10:00:00.000Z",
    updated_at: "2026-05-10T10:00:00.000Z",
  },
];

// ═══════════════════════════════════════════════════════════════════
// Synthetic Evolution Events (simulating 5 cognitive evolution events)
// ═══════════════════════════════════════════════════════════════════

export const SYNTHETIC_EVENTS: ModelEvent[] = [
  {
    event_id: "event:synth:001",
    event_type: "claim_created",
    claim_id: "claim:synth:001",
    timestamp: "2026-06-15T10:00:00.000Z",
    details: { description: "首次提出深度工作时间块的观点" },
  },
  {
    event_id: "event:synth:002",
    event_type: "claim_confirmed",
    claim_id: "claim:synth:001",
    timestamp: "2026-06-16T10:00:00.000Z",
    details: { description: "经过一周实践后确认深度工作时间块有效" },
  },
  {
    event_id: "event:synth:003",
    event_type: "claim_revised",
    claim_id: "claim:synth:008",
    timestamp: "2026-07-01T06:00:00.000Z",
    details: { description: "将早晨写作时间从1小时调整为2小时" },
  },
  {
    event_id: "event:synth:004",
    event_type: "evidence_linked",
    claim_id: "claim:synth:002",
    timestamp: "2026-06-25T08:00:00.000Z",
    details: { description: "链接了三周的睡眠日志作为证据" },
  },
  {
    event_id: "event:synth:005",
    event_type: "question_opened",
    claim_id: "claim:synth:004",
    timestamp: "2026-07-05T09:00:00.000Z",
    details: { description: "提出验证问题：运动频率与注意力的量化关系" },
  },
];

// ═══════════════════════════════════════════════════════════════════
// Synthetic Vault Notes
// ═══════════════════════════════════════════════════════════════════

export interface SyntheticNote {
  path: string;
  content: string;
}

/** Notes for Journey 4: current_note context. */
export const NOTE_DIARY_20260729: SyntheticNote = {
  path: "日记/2026-07-29.md",
  content: `---
date: 2026-07-29
---

# 今日记录

今天花了很多时间思考个人知识管理系统的架构设计。
主要关注点在于如何让LLM真正理解用户的长期上下文，
而不是每次都从零开始。

下午尝试了新的写作流程，感觉效率有提升。
晚上计划整理本周的阅读笔记。

## 待办
- [ ] 完成知识管理系统原型
- [ ] 阅读《深度工作》第三章
- [ ] 整理本周时间记录
`,
};

/** Notes for Journey 5: weekly preparation. */
export const WEEKLY_PREP_NOTES: SyntheticNote[] = [
  {
    path: "日记/2026-07-27.md",
    content: `---
date: 2026-07-27
---

# 周一记录

本周开始新的学习计划。决定深入学习分布式系统设计。
阅读了相关论文，对CAP理论有了更实际的理解。

工作中遇到一个关于数据库分片的有趣问题，
需要进一步研究一致性哈希的实现。
`,
  },
  {
    path: "日记/2026-07-28.md",
    content: `---
date: 2026-07-28
---

# 周二记录

继续分布式系统的学习。今天重点看了Raft共识算法。
实现了基本的日志复制，但对领导者选举还有一些疑问。

下午健身跑了5公里，感觉状态不错。
晚上和朋友讨论了创业的想法，有些启发。
`,
  },
  {
    path: "日记/2026-07-29.md",
    content: `---
date: 2026-07-29
---

# 周三记录

开始搭建个人知识管理系统的MVP原型。
选用了TypeScript + Obsidian插件的技术栈。
核心思路是让AI成为认知伴侣而非简单的问答机器。

对Conversation-first架构有了更清晰的认识。
`,
  },
  {
    path: "日记/2026-07-20.md",
    content: `---
date: 2026-07-20
---

# 上周记录

读了一本关于认知科学的好书。
对人类的记忆形成机制有了新的理解。
`,
  },
  {
    path: "日记/2026-07-15.md",
    content: `---
date: 2026-07-15
---

# 更早的记录

开始关注个人效率工具。
比较了几款笔记软件的功能差异。
`,
  },
];

/** Notes for Journey 8: exclusion rules. */
export const EXCLUSION_TEST_NOTES: SyntheticNote[] = [
  {
    path: "日记/normal.md",
    content: `# 普通笔记

这是一篇普通的日记，包含一些日常思考。

最近在关注工作效率的提升方法。
`,
  },
  {
    path: "日记/private.md",
    content: `---
cc-exclude: true
---

# 私密笔记

这是一篇标记为私密的笔记，包含个人敏感信息。

不应该出现在AI请求中。
`,
  },
  {
    path: "_模板/daily-template.md",
    content: `---
type: template
---

# 日记模板

日期: {{date}}

## 今日记录

## 待办
`,
  },
  {
    path: "_模板/weekly-template.md",
    content: `---
type: template
---

# 周记模板

## 本周总结

## 下周计划
`,
  },
];

// ═══════════════════════════════════════════════════════════════════
// Pre-constructed AI Responses (for FakeAiProvider)
// ═══════════════════════════════════════════════════════════════════

/** Normal AI response with cognitive references (Journey 3). */
export function normalReplyWithReferences(): ConversationAiOutput {
  return {
    response_text:
      "根据你的认知模型，你最近主要在关注工作效率的提升。你之前确认过深度工作需要每天至少2小时不受打扰的时间块（claim:synth:001），同时也观察到晚上使用电子设备会影响睡眠质量（claim:synth:002）。",
    candidates: [
      {
        epistemic_status: "ai_inferred",
        canonical_text: "你当前的核心关注点是提升深度工作能力和改善睡眠质量",
        evidence_refs: ["claim:synth:001", "claim:synth:002"],
        confidence: 0.85,
      },
    ],
    should_summarize: false,
    should_generate_wiki: false,
    question: "你目前在深度工作方面遇到了什么具体的障碍？",
  };
}

/** AI response that triggers summary confirmation (Journey 3). */
export function summarizeReplyWithReferences(): ConversationAiOutput {
  return {
    response_text:
      "基于我们的讨论，我对你的认知模式有了更清晰的了解。",
    candidates: [
      {
        epistemic_status: "to_verify",
        canonical_text:
          "你需要建立一个系统化的深度工作日程，将每天上午的2小时固定为不可打扰的创作时间",
        evidence_refs: ["claim:synth:001", "claim:synth:008"],
        confidence: 0.9,
      },
    ],
    should_summarize: true,
    should_generate_wiki: false,
    summary:
      "你的核心需求是建立系统化的深度工作习惯：固定上午2小时为创作时间，减少社交媒体干扰，同时保证充足的睡眠来维持高效状态。",
    question: "这个总结是否准确地反映了你的情况？",
  };
}

/** Simple AI response without summary (used for general turns). */
export function simpleReply(): ConversationAiOutput {
  return {
    response_text: "这是一个有趣的观点。能详细说说你的想法吗？",
    candidates: [],
    should_summarize: false,
    should_generate_wiki: false,
    question: "你在这方面有什么具体的经验或观察？",
  };
}

/** AI response with note content reference (Journey 4). */
export function noteAwareReply(): ConversationAiOutput {
  return {
    response_text:
      "从你的日记来看，你今天主要关注个人知识管理系统的架构设计。这个方向和你的长期目标是一致的。",
    candidates: [
      {
        epistemic_status: "ai_inferred",
        canonical_text:
          "你正在将知识管理系统从想法推进到原型阶段",
        evidence_refs: [],
        confidence: 0.8,
      },
    ],
    should_summarize: false,
    should_generate_wiki: false,
    question: "在架构设计方面，你目前最大的挑战是什么？",
  };
}

/** Weekly topics AI output (Journey 5). */
export function weeklyTopicsOutput() {
  return {
    topics: [
      {
        topic_id: "topic:ai:001",
        source_note_id: "note:synth:weekly-001",
        title: "分布式系统学习计划",
        description: "本周开始学习分布式系统，涉及CAP理论、一致性哈希和Raft算法",
        representative_excerpts: ["决定深入学习分布式系统设计", "实现了基本的日志复制"],
        relevance_score: 0.9,
      },
      {
        topic_id: "topic:ai:002",
        source_note_id: "note:synth:weekly-002",
        title: "知识管理系统MVP开发",
        description: "开始搭建个人知识管理系统的原型，使用TypeScript和Obsidian插件",
        representative_excerpts: ["开始搭建个人知识管理系统的MVP原型", "核心思路是让AI成为认知伴侣"],
        relevance_score: 0.85,
      },
      {
        topic_id: "topic:ai:003",
        source_note_id: "note:synth:weekly-003",
        title: "健身与工作效率的关系",
        description: "持续跑步锻炼，观察运动对工作状态的影响",
        representative_excerpts: ["下午健身跑了5公里", "感觉状态不错"],
        relevance_score: 0.7,
      },
      {
        topic_id: "topic:ai:004",
        source_note_id: null,
        title: "创业想法的可行性评估",
        description: "与朋友讨论了创业方向，需要进一步评估可行性",
        representative_excerpts: ["和朋友讨论了创业的想法", "有些启发"],
        relevance_score: 0.6,
      },
    ],
  };
}
