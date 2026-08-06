import { describe, expect, it } from "vitest";
import type { AiProvider } from "../src/ai/provider";
import { prepareTopics, TopicPreparationError, type TopicPreparationSnapshot } from "../src/weekly/topic-preparation";

const snapshot: TopicPreparationSnapshot = {
  snapshot_id: "snapshot-fixture",
  note_ids: ["note-short", "note-long"],
  notes: [
    { id: "note-short", path: "notes/short.md", body: "First short paragraph.\n\nSecond short paragraph." },
    { id: "note-long", path: "notes/long.md", body: "L".repeat(100) }
  ]
};

describe("prepareTopics", () => {
  it("requires exactly one primary theme per frozen note and permits secondary links", async () => {
    const provider: AiProvider = { complete: async (request) => request.outputSchema.parse({ topics: [
      { note_id: "note-short", primary_theme: "Reflection", secondary_links: ["Planning"] },
      { note_id: "note-long", primary_theme: "Planning", secondary_links: [] }
    ] }) };

    const result = await prepareTopics(snapshot, [], provider, { characterBudget: 80 });

    expect(result.topics.map(({ note_id, primary_theme, secondary_links }) => ({ note_id, primary_theme, secondary_links }))).toEqual([
      { note_id: "note-short", primary_theme: "Reflection", secondary_links: ["Planning"] },
      { note_id: "note-long", primary_theme: "Planning", secondary_links: [] }
    ]);
  });

  it("uses the character budget for multiple short excerpts or one truncated long excerpt", async () => {
    const provider: AiProvider = { complete: async (request) => request.outputSchema.parse({ topics: [
      { note_id: "note-short", primary_theme: "Short", secondary_links: [] },
      { note_id: "note-long", primary_theme: "Long", secondary_links: [] }
    ] }) };

    const result = await prepareTopics(snapshot, [], provider, { characterBudget: 50 });

    expect(result.topics[0]!.representative_excerpts).toEqual(["First short paragraph.", "Second short paragraph."]);
    expect(result.topics[1]!.representative_excerpts).toEqual(["L".repeat(50)]);
    expect(result.topics.every((topic) => topic.representative_excerpts.join("").length <= 50)).toBe(true);
  });

  it.each([
    [{ topics: [{ note_id: "note-short", primary_theme: "Only", secondary_links: [] }] }, "missing"],
    [{ topics: [
      { note_id: "note-short", primary_theme: "One", secondary_links: [] },
      { note_id: "note-short", primary_theme: "Two", secondary_links: [] },
      { note_id: "note-long", primary_theme: "Long", secondary_links: [] }
    ] }, "duplicate"],
    [{ topics: [
      { note_id: "note-short", primary_theme: "One", secondary_links: [] },
      { note_id: "note-long", primary_theme: "Long", secondary_links: [] },
      { note_id: "unknown", primary_theme: "Unknown", secondary_links: [] }
    ] }, "unknown"]
  ])("rejects %s topic assignments", async (output) => {
    const provider: AiProvider = { complete: async () => output as never };
    await expect(prepareTopics(snapshot, [], provider, { characterBudget: 50 })).rejects.toBeInstanceOf(TopicPreparationError);
  });

  it("rejects snapshot/body mismatches before calling the provider", async () => {
    let called = false;
    const provider: AiProvider = { complete: async () => { called = true; return {} as never; } };
    await expect(prepareTopics({ ...snapshot, notes: snapshot.notes.slice(0, 1) }, [], provider)).rejects.toThrow("snapshot notes");
    expect(called).toBe(false);
  });

  it("does not expose note text when a provider includes it in an error", async () => {
    const privateText = snapshot.notes[0]!.body;
    const provider: AiProvider = {
      complete: async () => { throw new Error(`provider leaked ${privateText}`); }
    };

    const error = await prepareTopics(snapshot, [], provider).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TopicPreparationError);
    expect(String(error)).not.toContain(privateText);
    expect(String(error)).not.toContain("provider leaked");
  });

  it.each([
    ["self", ["Reflection"]],
    ["duplicate", ["Planning", "Planning"]],
  ])("rejects %s secondary theme links", async (_kind, secondaryLinks) => {
    const provider: AiProvider = { complete: async () => ({ topics: [
      { note_id: "note-short", primary_theme: "Reflection", secondary_links: secondaryLinks },
      { note_id: "note-long", primary_theme: "Planning", secondary_links: [] }
    ] }) as never };
    await expect(prepareTopics(snapshot, [], provider)).rejects.toBeInstanceOf(TopicPreparationError);
  });

  it("accepts secondary links to another batch primary or an explicitly allowed model theme id", async () => {
    const provider: AiProvider = { complete: async () => ({ topics: [
      { note_id: "note-short", primary_theme: "Reflection", secondary_links: ["Planning", "model:goal-1"] },
      { note_id: "note-long", primary_theme: "Planning", secondary_links: [] }
    ] }) as never };
    const result = await prepareTopics(snapshot, [], provider, { allowedModelThemeIds: ["model:goal-1"] });
    expect(result.topics[0]!.secondary_links).toEqual(["Planning", "model:goal-1"]);
  });

  it("accepts unknown secondary theme links (no longer requires cross-referencing)", async () => {
    const provider: AiProvider = { complete: async () => ({ topics: [
      { note_id: "note-short", primary_theme: "Reflection", secondary_links: ["Unknown theme"] },
      { note_id: "note-long", primary_theme: "Planning", secondary_links: [] }
    ] }) as never };
    const result = await prepareTopics(snapshot, [], provider);
    expect(result.topics[0]!.secondary_links).toEqual(["Unknown theme"]);
  });

  it("counts Unicode code points and never splits an emoji surrogate pair", async () => {
    const emojiSnapshot: TopicPreparationSnapshot = {
      snapshot_id: "emoji", note_ids: ["emoji-note"],
      notes: [{ id: "emoji-note", path: "emoji.md", body: "甲😀乙😀丙" }]
    };
    const provider: AiProvider = { complete: async () => ({ topics: [
      { note_id: "emoji-note", primary_theme: "Emoji", secondary_links: [] }
    ] }) as never };
    const result = await prepareTopics(emojiSnapshot, [], provider, { characterBudget: 4 });
    const excerpt = result.topics[0]!.representative_excerpts[0]!;
    expect(excerpt).toBe("甲😀乙😀");
    expect(Array.from(excerpt)).toHaveLength(4);
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});
