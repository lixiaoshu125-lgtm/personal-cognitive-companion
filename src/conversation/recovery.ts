/**
 * Recovery Coordinator — Task 09
 *
 * Validates and recovers Conversations at startup.
 *
 * Key rules:
 *  - Every active/paused/awaiting conversation is checked for integrity.
 *  - Orphan states are downgraded safely (e.g., orphan awaiting → active).
 *  - Duplicate turns are deduplicated.
 *  - Corrupted conversations are reported but not modified.
 *  - All repairs are logged and returned in the report.
 */

import type { Conversation, ConversationStatus } from "./model";
import { isValidTransition } from "./model";
import type { ConversationStore } from "./store";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface RecoveryCoordinator {
  /**
   * Recover all incomplete conversations at startup.
   * Checks every active/paused/awaiting conversation for integrity and recoverability.
   */
  recoverAll(): Promise<RecoveryReport>;

  /**
   * Recover a single conversation.
   * Validates: turns consistency, no orphan states, safe to continue.
   */
  recoverOne(conversationId: string): Promise<RecoveryResult>;
}

export interface RecoveryReport {
  readonly total: number;
  readonly recovered: number;        // Successfully recovered
  readonly corrupted: string[];      // Corrupted conversation IDs
  readonly repairs: RepairEntry[];   // Auto-repair log
}

export interface RecoveryResult {
  readonly conversation: Conversation;
  readonly status: "healthy" | "repaired" | "corrupted";
  readonly issues: string[];
}

export interface RepairEntry {
  readonly conversationId: string;
  readonly issue: string;
  readonly action: string;
}

// ═══════════════════════════════════════════════════════════════════
// Validator
// ═══════════════════════════════════════════════════════════════════

/**
 * Integrity issues found during recovery scan.
 */
interface IntegrityIssues {
  missingId: boolean;
  missingStatus: boolean;
  missingSeed: boolean;
  missingTurns: boolean;
  completedMissingEndReason: boolean;
  nonCompletedHasEndReason: boolean;
  invalidStatusValue: boolean;
  duplicateTurns: boolean;
  orphanAwaiting: boolean;
}

function checkIntegrity(conv: Conversation): { issues: IntegrityIssues; messages: string[] } {
  const issues: IntegrityIssues = {
    missingId: false,
    missingStatus: false,
    missingSeed: false,
    missingTurns: false,
    completedMissingEndReason: false,
    nonCompletedHasEndReason: false,
    invalidStatusValue: false,
    duplicateTurns: false,
    orphanAwaiting: false,
  };
  const messages: string[] = [];

  // Check required fields
  if (!conv.id || typeof conv.id !== "string") {
    issues.missingId = true;
    messages.push("Missing or invalid conversation ID");
  }
  if (!conv.status) {
    issues.missingStatus = true;
    messages.push("Missing status field");
  }
  if (!conv.seed) {
    issues.missingSeed = true;
    messages.push("Missing seed field");
  }
  if (!Array.isArray(conv.turns)) {
    issues.missingTurns = true;
    messages.push("Missing or invalid turns array");
  }

  // Check status consistency
  const validStatuses: ConversationStatus[] = ["active", "paused", "awaiting_summary_confirmation", "completed"];
  if (conv.status && !validStatuses.includes(conv.status as ConversationStatus)) {
    issues.invalidStatusValue = true;
    messages.push(`Invalid status value: ${conv.status}`);
  }

  if (conv.status === "completed" && !(conv as any).end_reason) {
    issues.completedMissingEndReason = true;
    messages.push("Completed conversation missing end_reason");
  }

  if (conv.status !== "completed" && (conv as any).end_reason) {
    issues.nonCompletedHasEndReason = true;
    messages.push("Non-completed conversation has end_reason");
  }

  // Check for duplicate turns (by content + timestamp)
  if (Array.isArray(conv.turns) && conv.turns.length > 1) {
    const seen = new Set<string>();
    for (const turn of conv.turns) {
      const key = `${turn.role}|${turn.text}|${turn.timestamp}`;
      if (seen.has(key)) {
        issues.duplicateTurns = true;
        messages.push("Duplicate turns detected");
        break;
      }
      seen.add(key);
    }
  }

  // Check for orphan awaiting: awaiting_summary_confirmation but no summary turns
  if (conv.status === "awaiting_summary_confirmation" && Array.isArray(conv.turns)) {
    const hasSummary = conv.turns.some(
      (t) => t.role === "assistant" && t.text.startsWith("[SUMMARY]"),
    );
    if (!hasSummary) {
      issues.orphanAwaiting = true;
      messages.push("Conversation in awaiting_summary_confirmation but no summary candidate found");
    }
  }

  return { issues, messages };
}

function isHealthy(issues: IntegrityIssues): boolean {
  return !Object.values(issues).some(Boolean);
}

function isRepairable(issues: IntegrityIssues): boolean {
  // Only specific issues are auto-repairable
  const fatalIssues = [
    issues.missingId,
    issues.missingStatus,
    issues.missingSeed,
    issues.invalidStatusValue,
    issues.completedMissingEndReason,
  ];
  return !fatalIssues.some(Boolean);
}

// ═══════════════════════════════════════════════════════════════════
// Recovery Coordinator Implementation
// ═══════════════════════════════════════════════════════════════════

export class DefaultRecoveryCoordinator implements RecoveryCoordinator {
  constructor(private readonly store: ConversationStore) {}

  async recoverAll(): Promise<RecoveryReport> {
    const all = this.store.list();
    const repairs: RepairEntry[] = [];
    const corrupted: string[] = [];
    let recovered = 0;

    for (const conv of all) {
      try {
        const result = await this.recoverOne(conv.id);
        switch (result.status) {
          case "healthy":
            recovered++;
            break;
          case "repaired":
            recovered++;
            for (const issue of result.issues) {
              repairs.push({
                conversationId: conv.id,
                issue,
                action: "auto-repaired",
              });
            }
            break;
          case "corrupted":
            corrupted.push(conv.id);
            break;
        }
      } catch {
        corrupted.push(conv.id);
      }
    }

    return {
      total: all.length,
      recovered,
      corrupted,
      repairs,
    };
  }

  async recoverOne(conversationId: string): Promise<RecoveryResult> {
    const conv = this.store.load(conversationId);
    if (!conv) {
      return {
        conversation: null as unknown as Conversation,
        status: "corrupted",
        issues: [`Conversation not found: ${conversationId}`],
      };
    }

    const { issues, messages } = checkIntegrity(conv);

    // Healthy: no issues
    if (isHealthy(issues)) {
      return {
        conversation: conv,
        status: "healthy",
        issues: [],
      };
    }

    // Corrupted: fatal issues that can't be auto-repaired
    if (!isRepairable(issues)) {
      return {
        conversation: conv,
        status: "corrupted",
        issues: messages,
      };
    }

    // Repairable: apply fixes
    let repaired = conv;
    const repairActions: string[] = [];

    // Fix: duplicate turns → deduplicate
    if (issues.duplicateTurns && Array.isArray(conv.turns)) {
      const seen = new Set<string>();
      const deduped = conv.turns.filter((t) => {
        const key = `${t.role}|${t.text}|${t.timestamp}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (deduped.length < conv.turns.length) {
        repaired = { ...repaired, turns: deduped } as Conversation;
        repairActions.push("Deduplicated turns");
      }
    }

    // Fix: orphan awaiting → downgrade to active
    if (issues.orphanAwaiting) {
      repaired = { ...repaired, status: "active" as const } as Conversation;
      repairActions.push("Downgraded orphan awaiting_summary_confirmation to active");
    }

    // Fix: non-completed has end_reason → remove end_reason
    if (issues.nonCompletedHasEndReason) {
      const { end_reason, ...rest } = repaired as any;
      repaired = rest as Conversation;
      repairActions.push("Removed stray end_reason from non-completed conversation");
    }

    // Save repaired conversation
    try {
      this.store.save(repaired);
    } catch {
      return {
        conversation: conv,
        status: "corrupted",
        issues: [...messages, "Failed to save repaired conversation"],
      };
    }

    return {
      conversation: repaired,
      status: "repaired",
      issues: repairActions,
    };
  }
}
