import { z } from "zod";
import type { Claim, WeeklySnapshot, GoalState, ValidationExperiment } from "../domain/types";
import type { DialogueSessionState } from "../dialogue/session";
import type { NoteCoverageState } from "../coverage/note-coverage";

// ─── ModelEvent (was in src/model/repository.ts, now defined locally) ───

export interface ModelEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly claim_id: string;
  readonly timestamp: string;
  readonly details: Record<string, unknown>;
}
import type {
  SealedDialogueTurn,
  OperationCanonicalPayload,
  ZeroResultRef,
} from "../dialogue/finalize";
import type { SpeechAliasDictionary } from "../language/aliases";
import type { WeeklyPreparationState } from "../weekly/preparation-service";
import type { Conversation } from "../conversation/model";
import type { NoteIndex } from "../vault/note-index";

// ─── Settings ────────────────────────────────────────────────

export interface PluginSettings {
  readonly deepseekEndpoint: string;
  readonly deepseekModel: string;
  readonly deepseekApiKey: string;
  readonly extraExcludedDirs: readonly string[];
  readonly systemOutputDir: string;
  readonly topicCharBudget: number;
  readonly topicPrepTotalBudget: number;
  readonly autoAddUnambiguousAliases: boolean;
  readonly rawCorpusLocation: string | null;
  readonly maxPriorityTopics: number;
  /** Wiki output directory (default: _Wiki/). Generated conclusion pages go here. */
  readonly wikiOutputDir: string;
  /** News API key for fetching headlines (default: empty = disabled). */
  readonly newsApiKey: string;
  /** Comma-separated list of news source domains (e.g. "zhihu.com,36kr.com"). */
  readonly newsApiSources: string;
}

// ─── Model Import Metadata ───────────────────────────────────

export interface ModelImportMetadata {
  readonly importedAt: string; // ISO timestamp
  readonly sourcePath: string;
  readonly claimsCount: number;
  readonly eventsCount: number;
  readonly sourceFormat: "jsonl" | "json";
}

// ─── Idempotency Pointers ────────────────────────────────────

export interface IdempotencyPointers {
  readonly lastCommitKey: string | null;
  // key = "sessionId\ttopicId\tturnIndex"
  readonly lastZeroResultKeys: Record<string, string>;
  readonly committedKeys: Record<string, true>;
}

// ─── Plugin State ────────────────────────────────────────────

export interface PluginState {
  readonly schema_version: string;
  readonly settings: PluginSettings;
  readonly snapshot: WeeklySnapshot | null;
  readonly session: DialogueSessionState | null;
  readonly goals: GoalState | null;
  readonly validations: readonly ValidationExperiment[];
  readonly modelImportMetadata: ModelImportMetadata | null;
  readonly corpusPath: string | null;
  readonly aliasDictionary: SpeechAliasDictionary;
  readonly idempotencyPointers: IdempotencyPointers;
  // Repository-persisted data (PluginCognitiveRepository)
  readonly claims: Record<string, Claim>;
  readonly modelEvents: Record<string, ModelEvent>;
  readonly sealedTurns: Record<string, SealedDialogueTurn>;
  readonly operationRefs: Record<string, OperationCanonicalPayload>;
  readonly zeroResults: Record<string, ZeroResultRef>;
  readonly turnRequests: Record<string, string>;
  /** Weekly preparation state (Task 08). Persisted as part of PluginState. */
  readonly weeklyPreparation: WeeklyPreparationState | null;
  /** Conversation-first persistence (Task 12). Keyed by conversation ID. */
  readonly conversations: Record<string, Conversation>;
  /** Note coverage tracker — which notes have been discussed in weekly topics (Phase 10). */
  readonly noteCoverage: NoteCoverageState;
  /** Lightweight vault note index for fast keyword search (Phase 11). */
  readonly noteIndex: NoteIndex | null;
}

// ─── Zod Schemas ─────────────────────────────────────────────

export const pluginSettingsSchema = z.object({
  deepseekEndpoint: z.string().default("https://api.deepseek.com/v1"),
  deepseekModel: z.string().default("deepseek-v4-pro"),
  deepseekApiKey: z.string().default(""),
  extraExcludedDirs: z.array(z.string()).default([]),
  systemOutputDir: z.string().default("_个人认知系统"),
  topicCharBudget: z.number().int().positive().default(1200),
  topicPrepTotalBudget: z.number().int().positive().default(12000),
  autoAddUnambiguousAliases: z.boolean().default(false),
  rawCorpusLocation: z.string().nullable().default(null),
  maxPriorityTopics: z.number().int().positive().default(5),
  wikiOutputDir: z.string().default("_Wiki"),
  newsApiKey: z.string().default(""),
  newsApiSources: z.string().default(""),
}).passthrough();

const modelImportMetadataSchema = z.strictObject({
  importedAt: z.string(),
  sourcePath: z.string(),
  claimsCount: z.number().int().nonnegative(),
  eventsCount: z.number().int().nonnegative(),
  sourceFormat: z.enum(["jsonl", "json"]),
});

const idempotencyPointersSchema = z.strictObject({
  lastCommitKey: z.string().nullable(),
  lastZeroResultKeys: z.record(z.string(), z.string()),
  committedKeys: z.record(z.string(), z.literal(true as const)),
});

export const pluginStateSchema = z.object({
  schema_version: z.literal("2.0"),
  settings: pluginSettingsSchema,
  snapshot: z.any().nullable().catch(null),
  session: z.any().nullable().catch(null),
  goals: z.any().nullable().catch(null),
  validations: z.array(z.any()).catch([]),
  modelImportMetadata: modelImportMetadataSchema.nullable().catch(null),
  corpusPath: z.string().nullable().catch(null),
  aliasDictionary: z.record(z.string(), z.array(z.string())).catch({}),
  idempotencyPointers: idempotencyPointersSchema.catch({
    lastCommitKey: null,
    lastZeroResultKeys: {},
    committedKeys: {},
  }),
  // Old model data — kept in schema for backward compat but defaults to empty
  claims: z.record(z.string(), z.any()).catch({}),
  modelEvents: z.record(z.string(), z.any()).catch({}),
  sealedTurns: z.record(z.string(), z.any()).catch({}),
  operationRefs: z.record(z.string(), z.any()).catch({}),
  zeroResults: z.record(z.string(), z.any()).catch({}),
  turnRequests: z.record(z.string(), z.string()).catch({}),
  weeklyPreparation: z.any().optional().nullable().catch(null),
  conversations: z.record(z.string(), z.any()).catch({}),
  noteCoverage: z.preprocess(
    (val) => val ?? { coveredNoteIds: [], lastUpdated: new Date().toISOString() },
    z.any(),
  ),
  noteIndex: z.any().nullable().catch(null),
}).passthrough();

// ─── Factory ─────────────────────────────────────────────────

export function createDefaultPluginState(): PluginState {
  const settings = pluginSettingsSchema.parse({});
  const state: PluginState = {
    schema_version: "2.0",
    settings: settings as PluginSettings,
    snapshot: null,
    session: null,
    goals: null,
    validations: [],
    modelImportMetadata: null,
    corpusPath: null,
    aliasDictionary: {},
    idempotencyPointers: {
      lastCommitKey: null,
      lastZeroResultKeys: {},
      committedKeys: {},
    },
    claims: {},
    modelEvents: {},
    sealedTurns: {},
    operationRefs: {},
    zeroResults: {},
    turnRequests: {},
    weeklyPreparation: null,
    conversations: {},
    noteCoverage: { coveredNoteIds: [], lastUpdated: new Date().toISOString() },
    noteIndex: { version: 1 as const, entries: [], builtAt: new Date().toISOString(), totalNotes: 0 },
  };
  return freezePluginState(state);
}

// ─── Load ────────────────────────────────────────────────────

export function loadPluginState(data: unknown): PluginState {
  if (data === null || data === undefined) {
    return createDefaultPluginState();
  }

  // Check schema_version before Zod validation for a descriptive error
  if (typeof data === "object" && data !== null) {
    const raw = data as Record<string, unknown>;
    if (
      typeof raw.schema_version === "string" &&
      raw.schema_version !== "2.0"
    ) {
      throw new Error(
        `Plugin state schema version mismatch: expected "2.0", got "${raw.schema_version}"`
      );
    }
  }

  const parsed = pluginStateSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Plugin state validation failed: ${parsed.error.message}`
    );
  }

  return freezePluginState(parsed.data as PluginState);
}

// ─── Serialize ───────────────────────────────────────────────

export function serializePluginState(state: PluginState): object {
  try {
    // structuredClone strips readonly wrappers and produces a plain mutable object.
    // JSON round-trip ensures no undefined values remain.
    const out = JSON.parse(JSON.stringify(structuredClone(state))) as Record<string, unknown>;

    // Sanitize: remove old model data fields to prevent data.json bloat.
    const OLD_MODEL_FIELDS = [
      "claims", "modelEvents", "sealedTurns", "operationRefs",
      "zeroResults", "turnRequests", "modelImportMetadata",
    ];
    for (const field of OLD_MODEL_FIELDS) {
      delete out[field];
    }
    // Reset old nullable fields
    out.goals = null;
    out.validations = [];
    out.corpusPath = null;

    return out;
  } catch (err) {
    // Fallback: if sanitization fails, return raw state to avoid data loss
    console.error("[PCC] serializePluginState sanitization failed:", err);
    return JSON.parse(JSON.stringify(state));
  }
}

// ─── Freeze ──────────────────────────────────────────────────

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? ReadonlyArray<DeepReadonly<Item>>
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function freezePluginState(state: PluginState): PluginState {
  return deepFreeze(structuredClone(state)) as unknown as PluginState;
}
