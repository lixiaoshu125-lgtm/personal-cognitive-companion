/**
 * Conversation Candidates — Task 06
 *
 * Unified candidate type that extends AiCandidate with goal and validation proposals.
 * This is the bridge between the Conversation engine and the goals/validations domains.
 *
 * Key rules:
 *  - AI can propose goals and validations, but only with ai_inferred/to_verify status.
 *  - user_confirmed is exclusively produced by the engine after explicit user confirmation.
 *  - This file is a pure type definition — no runtime logic.
 */

import type { AiCandidate } from "./engine";

/**
 * An AI-proposed goal within a Conversation.
 */
export interface GoalProposal {
  readonly proposal_id: string;
  readonly text: string;
  readonly horizon_months: number;
  readonly rationale: string;
}

/**
 * An AI-proposed validation experiment within a Conversation.
 */
export interface ValidationProposal {
  readonly proposal_id: string;
  readonly hypothesis: string;
  readonly action: string;
  readonly kind: "lightweight" | "formal_plan";
}

/**
 * A candidate that can appear in a Conversation turn.
 *
 * Three variants:
 *  - claim: A regular cognitive claim (existing AiCandidate from engine.ts)
 *  - goal_proposal: An AI-proposed goal (from goals-integration.ts)
 *  - validation_proposal: An AI-proposed validation experiment (from validations-integration.ts)
 */
export type ConversationCandidate =
  | { type: "claim"; candidate: AiCandidate }
  | { type: "goal_proposal"; proposal: GoalProposal }
  | { type: "validation_proposal"; proposal: ValidationProposal };
