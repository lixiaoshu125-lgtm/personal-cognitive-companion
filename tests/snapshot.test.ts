import { describe, expect, it } from "vitest";
import type { NoteRef } from "../src/vault/scanner";
import {
  advanceSnapshotCursor,
  createSnapshot,
  pauseSnapshot,
  refreshSnapshot,
  resumeSnapshot,
  startSnapshot
} from "../src/weekly/snapshot";

const note = (id: string, contentHash: string): NoteRef => ({
  id: `sha256:${id.padEnd(64, "0")}`,
  path: `notes/${id}.md`,
  content_hash: `sha256:${contentHash.padEnd(64, "0")}`
});

describe("weekly snapshots", () => {
  it("freezes a deterministic note batch without retaining mutable note input", () => {
    const notes = [note("a", "1"), note("b", "2")];
    const snapshot = createSnapshot(notes, null, new Date("2026-07-26T08:00:00.000Z"));
    notes.push(note("c", "3"));

    expect(snapshot.note_ids).toEqual([notes[0]!.id, notes[1]!.id]);
    expect(snapshot.status).toBe("frozen");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.note_ids)).toBe(true);
  });

  it("keeps notes added after freeze for the next batch until explicit refresh", () => {
    const firstNote = note("a", "1");
    const addedLater = note("b", "2");
    const frozen = createSnapshot([firstNote], null, new Date("2026-07-26T08:00:00.000Z"));

    const unchanged = createSnapshot([firstNote, addedLater], frozen, new Date("2026-07-26T09:00:00.000Z"));
    const refreshed = refreshSnapshot([firstNote, addedLater], frozen, new Date("2026-07-26T09:00:00.000Z"));

    expect(unchanged).toBe(frozen);
    expect(unchanged.note_ids).toEqual([firstNote.id]);
    expect(refreshed.note_ids).toEqual([firstNote.id, addedLater.id]);
    expect(refreshed.snapshot_id).not.toBe(frozen.snapshot_id);
  });

  it("pauses and resumes at the same persisted cursor", () => {
    const initial = createSnapshot([note("a", "1"), note("b", "2")], null, new Date("2026-07-26T08:00:00.000Z"));
    const active = startSnapshot(initial);
    const progressed = advanceSnapshotCursor(active, 1);
    const paused = pauseSnapshot(progressed);
    const resumed = resumeSnapshot(paused);

    expect(paused.cursor).toBe(1);
    expect(paused.status).toBe("paused");
    expect(resumed.cursor).toBe(1);
    expect(resumed.status).toBe("active");
  });

  it("rejects cursor movement beyond the frozen batch", () => {
    const snapshot = startSnapshot(createSnapshot([note("a", "1")], null, new Date("2026-07-26T08:00:00.000Z")));
    expect(() => advanceSnapshotCursor(snapshot, 2)).toThrow("snapshot cursor");
  });

  it("only starts a frozen snapshot", () => {
    const frozen = createSnapshot([note("a", "1")], null, new Date("2026-07-26T08:00:00.000Z"));
    const active = startSnapshot(frozen);
    expect(active.status).toBe("active");
    expect(() => startSnapshot(active)).toThrow("frozen");
    expect(() => startSnapshot(pauseSnapshot(active))).toThrow("frozen");
    expect(() => startSnapshot({ ...active, status: "completed" })).toThrow("frozen");
  });

  it("only pauses active snapshots and only resumes paused snapshots", () => {
    const frozen = createSnapshot([note("a", "1")], null, new Date("2026-07-26T08:00:00.000Z"));
    const active = startSnapshot(frozen);
    const paused = pauseSnapshot(active);

    expect(() => pauseSnapshot(frozen)).toThrow("active");
    expect(() => pauseSnapshot(paused)).toThrow("active");
    expect(() => pauseSnapshot({ ...active, status: "completed" })).toThrow("active");
    expect(() => resumeSnapshot(frozen)).toThrow("paused");
    expect(() => resumeSnapshot(active)).toThrow("paused");
    expect(() => resumeSnapshot({ ...active, status: "completed" })).toThrow("paused");
    expect(resumeSnapshot(paused).status).toBe("active");
  });

  it("advances only active snapshots and never moves their cursor backward", () => {
    const frozen = createSnapshot([note("a", "1"), note("b", "2")], null, new Date("2026-07-26T08:00:00.000Z"));
    const active = advanceSnapshotCursor(startSnapshot(frozen), 1);
    const paused = pauseSnapshot(active);

    expect(() => advanceSnapshotCursor(frozen, 1)).toThrow("active");
    expect(() => advanceSnapshotCursor(paused, 2)).toThrow("active");
    expect(() => advanceSnapshotCursor({ ...active, status: "completed" }, 2)).toThrow("active");
    expect(() => advanceSnapshotCursor(active, 0)).toThrow("backward");
    expect(advanceSnapshotCursor(active, 2).cursor).toBe(2);
  });
});
