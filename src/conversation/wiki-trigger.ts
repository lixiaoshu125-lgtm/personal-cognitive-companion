/**
 * Wiki Trigger — Phase 6
 *
 * Decides whether a conversation should generate a Wiki page.
 * Pure decision function — no side effects, no I/O.
 *
 * Used by the conversation engine during the finalize flow
 * (Phase 7 wiring) to decide if conclusions warrant persistent storage.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface WikiTriggerContext {
  /** Number of turns in the conversation (user + assistant). */
  readonly conversationLength: number;
  /** Whether the AI concluded with an actionable/principled conclusion
   *  (vs a factual lookup or definition). */
  readonly hasActionableConclusion: boolean;
  /** Number of distinct notes referenced during the conversation. */
  readonly relatedNoteCount: number;
}

export interface WikiTriggerResult {
  readonly shouldGenerate: boolean;
  readonly reason: string;
}

// ═══════════════════════════════════════════════════════════════
// Decision Logic
// ═══════════════════════════════════════════════════════════════

/**
 * Decide whether to generate a Wiki page from conversation results.
 *
 * Rules (in priority order):
 *  1. No actionable conclusion → skip (pure facts/definitions don't need a Wiki)
 *  2. < 4 turns → skip (too short for meaningful synthesis)
 *  3. < 3 related notes → skip (not enough cross-referencing value)
 *  4. Otherwise → generate (meets the depth + breadth threshold)
 *
 * These thresholds are deliberately conservative — false negatives
 * (missing a Wiki) are less harmful than false positives (cluttering
 * the Wiki directory with shallow pages).
 */
export function shouldGenerateWiki(ctx: WikiTriggerContext): WikiTriggerResult {
  // Rule 1: Must have an actionable conclusion
  if (!ctx.hasActionableConclusion) {
    return {
      shouldGenerate: false,
      reason: "纯事实查询或定义解释，无需沉淀为 Wiki",
    };
  }

  // Rule 2: Minimum conversation depth
  if (ctx.conversationLength < 4) {
    return {
      shouldGenerate: false,
      reason: `对话轮次不足（${ctx.conversationLength} < 4），尚未形成足够深度的讨论`,
    };
  }

  // Rule 3: Minimum cross-referencing breadth
  if (ctx.relatedNoteCount < 3) {
    return {
      shouldGenerate: false,
      reason: `涉及笔记不足（${ctx.relatedNoteCount} < 3），Wiki 的双向链接价值有限`,
    };
  }

  // Rule 4: All thresholds met → generate
  return {
    shouldGenerate: true,
    reason: `对话深度足够（${ctx.conversationLength} 轮，涉及 ${ctx.relatedNoteCount} 篇笔记），结论值得沉淀`,
  };
}

/**
 * Extract the count of distinct note IDs referenced in conversation turns.
 *
 * Scans assistant turns for note references (paths containing .md or note: prefixes)
 * and returns the distinct count.
 */
export function countReferencedNotes(
  assistantTexts: readonly string[],
): number {
  const noteRefs = new Set<string>();

  for (const text of assistantTexts) {
    // Match [[wikilink]] patterns
    const wikiLinks = text.match(/\[\[([^\]]+)\]\]/g);
    if (wikiLinks) {
      for (const link of wikiLinks) {
        // Strip [[ and ]], take the display part (before |)
        const inner = link.slice(2, -2).split("|")[0]!;
        noteRefs.add(inner);
      }
    }

    // Match note:ID patterns
    const noteIds = text.match(/note:[a-zA-Z0-9_-]+/g);
    if (noteIds) {
      for (const id of noteIds) {
        noteRefs.add(id);
      }
    }
  }

  return noteRefs.size;
}

/**
 * Quick heuristic: does the conclusion text look "actionable"
 * rather than a pure lookup?
 *
 * Actionable signals:
 *  - Contains principle/method/insight keywords
 *  - Multi-sentence structure (more than just a factoid)
 *
 * Non-actionable (skip) signals:
 *  - Short single-sentence
 *  - Pure definition/what-is patterns
 */
export function classifyConclusionType(conclusion: string): {
  isActionable: boolean;
  type: "insight" | "method" | "principle" | "factual";
} {
  const text = conclusion.trim();
  const sentences = text.split(/[。！？\n.!?]+/).filter((s) => s.trim().length > 0);

  // Very short → probably factual
  if (sentences.length <= 1 && text.length < 80) {
    return { isActionable: false, type: "factual" };
  }

  const actionableKeywords = [
    /原则/, /方法/, /模式/, /规律/, /经验/, /教训/, /策略/, /技巧/,
    /发现/, /洞察/, /总结/, /建议/, /方案/, /步骤/, /关键/,
    /pattern/, /principle/, /method/, /insight/, /strategy/,
    /可以尝试/, /应该/, /建议/, /推荐/, /最好/,
  ];

  const factualKeywords = [
    /是什么/, /定义/, /意思是/, /全称/,
    /什么时候/, /在哪里/, /多少钱/,
  ];

  let actionableScore = 0;
  let factualScore = 0;

  for (const pattern of actionableKeywords) {
    if (pattern.test(text)) actionableScore++;
  }
  for (const pattern of factualKeywords) {
    if (pattern.test(text)) factualScore++;
  }

  // Multi-sentence + no factual markers → likely actionable
  if (sentences.length >= 3 && factualScore === 0) {
    actionableScore += 2;
  }

  if (actionableScore > factualScore) {
    if (actionableScore >= 3) return { isActionable: true, type: "insight" };
    return { isActionable: true, type: "method" };
  }

  return { isActionable: false, type: "factual" };
}
