import type { WeeklySnapshot } from "../domain/types";
import { weeklySnapshotSchema } from "../domain/schema";
import type { NoteRef } from "../vault/scanner";
import { sha256 } from "../vault/scanner";

function orderedNotes(notes: readonly NoteRef[]): readonly NoteRef[] {
  return [...notes].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function snapshotRevision(notes: readonly NoteRef[]): string {
  return sha256(orderedNotes(notes).map((note) => `${note.id}\0${note.content_hash}`).join("\n"));
}

function buildSnapshot(notes: readonly NoteRef[], now: Date): WeeklySnapshot {
  const createdAt = now.toISOString();
  const ordered = orderedNotes(notes);
  const sourceRevision = snapshotRevision(ordered);
  return weeklySnapshotSchema.parse({
    snapshot_id: sha256(`snapshot\0${sourceRevision}\0${createdAt}`),
    created_at: createdAt,
    frozen_at: createdAt,
    source_revision: sourceRevision,
    note_ids: ordered.map((note) => note.id),
    cursor: 0,
    status: "frozen"
  });
}

export function createSnapshot(
  notes: readonly NoteRef[],
  previousState: WeeklySnapshot | null,
  now: Date
): WeeklySnapshot {
  return previousState ?? buildSnapshot(notes, now);
}

export function refreshSnapshot(
  notes: readonly NoteRef[],
  _previousState: WeeklySnapshot | null,
  now: Date
): WeeklySnapshot {
  return buildSnapshot(notes, now);
}

function withSnapshotState(
  snapshot: WeeklySnapshot,
  updates: Pick<WeeklySnapshot, "cursor" | "status">
): WeeklySnapshot {
  return weeklySnapshotSchema.parse({ ...snapshot, ...updates });
}

export function advanceSnapshotCursor(snapshot: WeeklySnapshot, cursor: number): WeeklySnapshot {
  if (snapshot.status !== "active") {
    throw new Error("A snapshot cursor can only advance while active");
  }
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > snapshot.note_ids.length) {
    throw new RangeError("Invalid snapshot cursor");
  }
  if (cursor < snapshot.cursor) {
    throw new RangeError("A snapshot cursor cannot move backward");
  }
  return withSnapshotState(snapshot, { cursor, status: snapshot.status });
}

export function startSnapshot(snapshot: WeeklySnapshot): WeeklySnapshot {
  if (snapshot.status !== "frozen") {
    throw new Error("Only a frozen snapshot can start");
  }
  return withSnapshotState(snapshot, { cursor: snapshot.cursor, status: "active" });
}

export function pauseSnapshot(snapshot: WeeklySnapshot): WeeklySnapshot {
  if (snapshot.status !== "active") {
    throw new Error("Only an active snapshot can pause");
  }
  return withSnapshotState(snapshot, { cursor: snapshot.cursor, status: "paused" });
}

export function resumeSnapshot(snapshot: WeeklySnapshot): WeeklySnapshot {
  if (snapshot.status !== "paused") {
    throw new Error("Only a paused snapshot can resume");
  }
  return withSnapshotState(snapshot, { cursor: snapshot.cursor, status: "active" });
}

export function completeSnapshot(snapshot: WeeklySnapshot): WeeklySnapshot {
  if (snapshot.status === "completed") {
    return snapshot; // idempotent
  }
  if (snapshot.status === "frozen") {
    throw new Error("A frozen snapshot cannot be completed directly; start it first");
  }
  if (snapshot.status === "paused") {
    throw new Error("A paused snapshot must be resumed before completing");
  }
  if (snapshot.status !== "active") {
    throw new Error("Only an active snapshot can be completed");
  }
  return withSnapshotState(snapshot, { cursor: snapshot.cursor, status: "completed" });
}
