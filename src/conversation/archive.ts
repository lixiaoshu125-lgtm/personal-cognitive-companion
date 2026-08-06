/**
 * Conversation Archive — Task 05 / Phase 7
 *
 * Produces a structured archive record from a completed Conversation.
 *
 * Rules:
 *  - Archive must contain REAL content — no empty arrays as placeholders.
 *  - turns, wiki_conclusion, and context_summary references must reflect actual data.
 *  - Archives are immutable snapshots; the Conversation itself remains the source of truth.
 */

import type { Conversation, ConversationSeed, ConversationTurn } from "./model";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** A single archived turn, preserving role, text, and timestamp. */
export interface ArchivedTurn {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly timestamp: string;
}

/**
 * A complete archive of a finished Conversation.
 *
 * All fields must reflect real content — no placeholder empty arrays.
 */
export interface ConversationArchive {
  readonly conversation_id: string;
  readonly seed: ConversationSeed;
  readonly status: "completed";
  readonly end_reason: "confirmed_results" | "no_formal_result";
  /** All turns in the conversation. Must be non-empty for a real conversation. */
  readonly turns: readonly ArchivedTurn[];
  /** Wiki conclusion text — null when endWithoutConclusion was used. */
  readonly wiki_conclusion: string | null;
  readonly context_summary: {
    /** Note paths referenced during the conversation (from [[wikilink]]). */
    readonly vault_notes_referenced: readonly string[];
  };
  readonly created_at: string;
  readonly completed_at: string;
}

// ═══════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build a ConversationArchive from a completed Conversation.
 *
 * Extracts referenced note paths from conversation turns.
 * For a no_formal_result conversation, wiki_conclusion will be null
 * but turns and context_summary will still contain real content.
 *
 * @param conversation  Must be in "completed" status.
 * @param wikiConclution  The confirmed conclusion text (null for no_formal_result).
 * @returns A complete archive with real content.
 */
export function buildConversationArchive(
  conversation: Conversation,
  wikiConclution: string | null,
): ConversationArchive {
  if (conversation.status !== "completed") {
    throw new Error(
      `Cannot archive: conversation ${conversation.id} is ${conversation.status}, expected completed`,
    );
  }

  if (!conversation.end_reason) {
    throw new Error(
      `Cannot archive: conversation ${conversation.id} is completed but missing end_reason`,
    );
  }

  // ── Map turns ───────────────────────────────────────────
  const turns: ArchivedTurn[] = conversation.turns.map((t: ConversationTurn) => ({
    role: t.role,
    text: t.text,
    timestamp: t.timestamp,
  }));

  // ── Extract referenced note paths ──────────────────────
  const vaultNotesReferenced = extractNoteReferences(conversation);

  return {
    conversation_id: conversation.id,
    seed: conversation.seed,
    status: "completed",
    end_reason: conversation.end_reason,
    turns,
    wiki_conclusion: wikiConclution,
    context_summary: {
      vault_notes_referenced: vaultNotesReferenced,
    },
    created_at: conversation.created_at,
    completed_at: conversation.updated_at,
  };
}

// ═══════════════════════════════════════════════════════════════
// Reference Extractors
// ═══════════════════════════════════════════════════════════════

/**
 * Extract note paths referenced in conversation turns.
 * Looks for .md file references and [[wikilink]] patterns in turn text.
 */
function extractNoteReferences(conversation: Conversation): string[] {
  const noteRefs = new Set<string>();

  for (const turn of conversation.turns) {
    // Match [[wikilink]] patterns (bare or with alias: [[name]] or [[name|alias]])
    const wikiLinks = turn.text.match(/\[\[([^\]]+)\]\]/g);
    if (wikiLinks) {
      for (const link of wikiLinks) {
        const inner = link.slice(2, -2).split("|")[0]!;
        noteRefs.add(inner);
      }
    }

    // Match .md file references
    const mdRefs = turn.text.match(/[\w\p{Script=Han}\-]+\.md/gu);
    if (mdRefs) {
      for (const m of mdRefs) {
        noteRefs.add(m);
      }
    }
  }

  return [...noteRefs].sort();
}
