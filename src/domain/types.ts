import type { z } from "zod";
import type {
  claimSchema,
  dialogueSessionSchema,
  evidenceLinkSchema,
  goalStateSchema,
  validationExperimentSchema,
  weeklySnapshotSchema
} from "./schema";

export type Claim = z.infer<typeof claimSchema>;
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
export type WeeklySnapshot = Readonly<z.infer<typeof weeklySnapshotSchema>>;
export type DialogueSession = z.infer<typeof dialogueSessionSchema>;
export type GoalState = z.infer<typeof goalStateSchema>;
export type ValidationExperiment = z.infer<typeof validationExperimentSchema>;
