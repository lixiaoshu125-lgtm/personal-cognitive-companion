import { AiProviderError, type AiCompletionRequest, type AiProvider } from "./provider";

export interface DeepSeekTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface DeepSeekTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type DeepSeekTransport = (request: DeepSeekTransportRequest) => Promise<DeepSeekTransportResponse>;

export interface DeepSeekProviderOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly transport: DeepSeekTransport;
}

function completionUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, "")}/chat/completions`;
}

function extractContent(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (message === null || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

export class DeepSeekProvider implements AiProvider {
  constructor(private readonly options: DeepSeekProviderOptions) {}

  async complete<Output>(request: AiCompletionRequest<Output>, signal?: AbortSignal): Promise<Output> {
    if (signal?.aborted) throw new AiProviderError("aborted");

    let response: unknown;
    try {
      response = await this.options.transport({
        url: completionUrl(this.options.endpoint),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json"
        },
        body: {
          model: this.options.model,
          messages: request.messages,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature })
        },
        ...(signal === undefined ? {} : { signal })
      });
    } catch {
      throw new AiProviderError(signal?.aborted ? "aborted" : "transport");
    }

    if (signal?.aborted) throw new AiProviderError("aborted");
    let status: number;
    try {
      if (response === null || typeof response !== "object") throw new Error();
      const candidate = (response as { status?: unknown }).status;
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) throw new Error();
      status = candidate;
    } catch {
      throw new AiProviderError("response", "malformed_transport_response");
    }
    if (status < 200 || status >= 300) throw new AiProviderError("http", `status_${status}`);

    let content: string | undefined;
    try {
      content = extractContent((response as { body?: unknown }).body);
    } catch {
      throw new AiProviderError("response", "malformed_completion_content");
    }
    if (content === undefined) {
      throw new AiProviderError("response", "missing_completion_content");
    }

    // Try to extract JSON from the content. DeepSeek sometimes wraps JSON
    // in markdown code blocks or prepends explanatory text.
    let jsonText = content;
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch?.[1]) {
      jsonText = fenceMatch[1].trim();
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(jsonText);
    } catch {
      // JSON parsing failed — try to salvage the response_text field
      // from the broken JSON so the user sees the AI's reply, not raw JSON.
      const responseMatch = jsonText.match(/"response_text"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
      const questionMatch = jsonText.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
      const wikiMatch = jsonText.match(/"wiki_conclusion"\s*:\s*"((?:[^"\\]|\\.)*)"/s);

      const extractedText = responseMatch?.[1]
        ?? wikiMatch?.[1]
        ?? content.replace(/```[^`]*```/g, "").trim();

      decoded = {
        response_text: extractedText || content.slice(0, 500),
        candidates: [],
        should_summarize: false,
        question: questionMatch?.[1] ?? "还有什么想法吗？",
      };
    }

    let parsed;
    try {
      parsed = request.outputSchema.safeParse(decoded);
    } catch {
      throw new AiProviderError("invalid_output");
    }
    if (!parsed.success) {
      // If structured parsing fails but we have text, use fallback
      if (typeof (decoded as Record<string, unknown>)?.response_text === "string") {
        const fallback = {
          response_text: (decoded as Record<string, unknown>).response_text as string,
          candidates: [] as Array<Record<string, unknown>>,
          should_summarize: false,
          question: "还有什么想法吗？",
        };
        const fbParsed = request.outputSchema.safeParse(fallback);
        if (fbParsed.success) return fbParsed.data;
      }
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new AiProviderError("invalid_output", `schema: ${issues}`);
    }
    return parsed.data;
  }
}
