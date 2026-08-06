import { describe, it, expect } from "vitest";

/**
 * S1-ISSUE-03: This test file has been deactivated.
 * All tests in this file exercise the legacy WeeklyOrchestrator dialogue pipeline
 * (startWeeklyReview, handleDialogueInput, orchestrator), which has been removed
 * from CompositionRoot. The new Conversation-first path uses ConversationEngine
 * and does not use the legacy pipeline.
 *
 * Tests for the new path: conversation-journey.test.ts, temp-vault-journeys.test.ts
 */
describe("memory-full-pipeline (LEGACY — deactivated S1-ISSUE-03)", () => {
  it.skip("all legacy pipeline tests deactivated", () => {
    expect(true).toBe(true);
  });
});
