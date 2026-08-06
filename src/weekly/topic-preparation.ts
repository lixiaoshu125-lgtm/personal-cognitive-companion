import { z } from "zod";
import type { AiProvider } from "../ai/provider";
import type { Claim } from "../domain/types";

export interface TopicPreparationNote {
  readonly id: string;
  readonly path: string;
  readonly body: string;
}

export interface TopicPreparationSnapshot {
  readonly snapshot_id: string;
  readonly note_ids: readonly string[];
  readonly notes: readonly TopicPreparationNote[];
}

export interface PreparedTopic {
  readonly note_id: string;
  readonly primary_theme: string;
  readonly secondary_links: readonly string[];
  readonly representative_excerpts: readonly string[];
}

export interface PreparedTopics {
  readonly snapshot_id: string;
  readonly topics: readonly PreparedTopic[];
}

export interface TopicPreparationOptions {
  readonly characterBudget?: number;
  readonly signal?: AbortSignal;
  readonly allowedModelThemeIds?: readonly string[];
}

export class TopicPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicPreparationError";
  }
}

const assignmentSchema = z.object({
  note_id: z.string().trim().min(1),
  primary_theme: z.string().trim().min(1),
  secondary_links: z.array(z.string().trim().min(1))
}).passthrough();

const outputSchema = z.object({ topics: z.array(assignmentSchema) }).passthrough();

function validateSnapshot(snapshot: TopicPreparationSnapshot): Map<string, TopicPreparationNote> {
  const expected = new Set(snapshot.note_ids);
  const notes = new Map<string, TopicPreparationNote>();
  for (const note of snapshot.notes) {
    if (!expected.has(note.id) || notes.has(note.id)) throw new TopicPreparationError("Invalid snapshot notes");
    notes.set(note.id, note);
  }
  if (notes.size !== expected.size || expected.size !== snapshot.note_ids.length) {
    throw new TopicPreparationError("Invalid snapshot notes");
  }
  return notes;
}

function selectExcerpts(body: string, budget: number): readonly string[] {
  const paragraphs = body.split(/(?:\r?\n){2,}/u).map((part) => part.trim()).filter(Boolean);
  const selected: string[] = [];
  let remaining = budget;
  for (const paragraph of paragraphs) {
    const codePoints = Array.from(paragraph);
    if (codePoints.length <= remaining) {
      selected.push(paragraph);
      remaining -= codePoints.length;
      continue;
    }
    if (selected.length === 0 && remaining > 0) selected.push(codePoints.slice(0, remaining).join(""));
    break;
  }
  return Object.freeze(selected);
}

export async function prepareTopics(
  snapshot: TopicPreparationSnapshot,
  model: readonly Claim[],
  provider: AiProvider,
  options: TopicPreparationOptions = {}
): Promise<PreparedTopics> {
  const notes = validateSnapshot(snapshot);
  const characterBudget = options.characterBudget ?? 1_200;
  if (!Number.isInteger(characterBudget) || characterBudget <= 0) {
    throw new TopicPreparationError("Character budget must be a positive integer");
  }

  let output: z.infer<typeof outputSchema>;
  try {
    output = await provider.complete({
      outputName: "weekly_topic_assignments",
      outputSchema,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "你是一个个人认知伴侣的主题分析器。",
            "为每条笔记分配一个主要主题（primary_theme），可选添加关联主题（secondary_links）。",
            "",
            "必须严格按以下 JSON 格式输出：",
            '{ "topics": [',
            '  { "note_id": "笔记ID", "primary_theme": "主题名", "secondary_links": ["关联主题1"] }',
            "] }",
            "",
            "规则：",
            "- 每条笔记恰好出现一次",
            "- primary_theme 用中文，简洁（不超过15字）",
            "- secondary_links 列出相关的其他主题名（可以为空数组）",
            "- 只输出 JSON，不要有其他文字",
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify({
          snapshot_id: snapshot.snapshot_id,
          notes: snapshot.notes.map(({ id, path, body }) => ({ id, path, body })),
          model: model.map(({ claim_id, canonical_text, claim_type, epistemic_status }) => ({
            claim_id, canonical_text, claim_type, epistemic_status
          }))
        }) }
      ]
    }, options.signal);
  } catch {
    throw new TopicPreparationError("Unable to prepare topics with the AI provider");
  }

  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) {
    throw new TopicPreparationError(
      `Invalid topic output structure: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }
  const assignments = new Map<string, z.infer<typeof assignmentSchema>>();
  for (const assignment of parsed.data.topics) {
    if (!notes.has(assignment.note_id) || assignments.has(assignment.note_id)) {
      throw new TopicPreparationError("Topic output must assign every note exactly once");
    }
    assignments.set(assignment.note_id, assignment);
  }
  if (assignments.size !== notes.size) throw new TopicPreparationError("Topic output must assign every note exactly once");

  for (const assignment of assignments.values()) {
    const seen = new Set<string>();
    for (const secondary of assignment.secondary_links) {
      if (secondary === assignment.primary_theme || seen.has(secondary)) {
        throw new TopicPreparationError("Secondary theme links must be unique and cannot reference their primary theme");
      }
      // Accept any non-self-referencing, non-duplicate secondary link.
      // We no longer require secondary themes to exist in primaryThemes or
      // allowedModelThemes — the AI may propose connections to themes that
      // are not assigned as any note's primary theme but are still meaningful.
      seen.add(secondary);
    }
  }

  return Object.freeze({
    snapshot_id: snapshot.snapshot_id,
    topics: Object.freeze(snapshot.note_ids.map((noteId) => {
      const assignment = assignments.get(noteId)!;
      return Object.freeze({
        ...assignment,
        secondary_links: Object.freeze([...assignment.secondary_links]),
        representative_excerpts: selectExcerpts(notes.get(noteId)!.body, characterBudget)
      });
    }))
  });
}
