import type { z } from "zod";

export type AiMessageRole = "system" | "user" | "assistant";

export interface AiMessage {
  readonly role: AiMessageRole;
  readonly content: string;
}

export interface AiCompletionRequest<Output> {
  readonly messages: readonly AiMessage[];
  readonly outputSchema: z.ZodType<Output>;
  readonly outputName: string;
  readonly temperature?: number;
}

export interface AiProvider {
  complete<Output>(request: AiCompletionRequest<Output>, signal?: AbortSignal): Promise<Output>;
}

export type AiProviderErrorCode = "aborted" | "transport" | "http" | "response" | "invalid_output";

export class AiProviderError extends Error {
  constructor(readonly code: AiProviderErrorCode, details?: string) {
    const base = {
      aborted: "AI request was aborted",
      transport: "AI provider could not be reached",
      http: "AI provider rejected the request",
      response: "AI provider returned an unreadable response",
      invalid_output: "AI provider returned invalid structured output"
    }[code];
    super(details ? `${base}: ${details}` : base);
    this.name = "AiProviderError";
  }
}
