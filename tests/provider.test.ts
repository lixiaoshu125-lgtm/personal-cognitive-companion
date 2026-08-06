import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DeepSeekProvider, type DeepSeekTransport } from "../src/ai/deepseek";
import { AiProviderError } from "../src/ai/provider";

const outputSchema = z.strictObject({ answer: z.string() });

describe("DeepSeekProvider", () => {
  it("returns schema-validated structured output through an injected transport", async () => {
    const transport: DeepSeekTransport = async (request) => {
      expect(request.url).toBe("https://synthetic.invalid/chat/completions");
      expect(request.headers.authorization).toBe("Bearer fixture-key");
      expect(request.body.model).toBe("fixture-model");
      return { status: 200, body: { choices: [{ message: { content: '{"answer":"ok"}' } }] } };
    };
    const provider = new DeepSeekProvider({
      endpoint: "https://synthetic.invalid",
      apiKey: "fixture-key",
      model: "fixture-model",
      transport
    });

    await expect(provider.complete({
      messages: [{ role: "user", content: "synthetic prompt" }],
      outputSchema,
      outputName: "fixture_output"
    })).resolves.toEqual({ answer: "ok" });
  });

  it("forwards AbortSignal and rejects an already aborted request without transport access", async () => {
    let calls = 0;
    const transport: DeepSeekTransport = async () => {
      calls += 1;
      return { status: 200, body: {} };
    };
    const provider = new DeepSeekProvider({ endpoint: "https://synthetic.invalid", apiKey: "key", model: "model", transport });
    const controller = new AbortController();
    controller.abort();

    const error = await provider.complete({ messages: [], outputSchema, outputName: "fixture" }, controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe("aborted");
    expect(calls).toBe(0);
  });

  it("sanitizes transport, HTTP, JSON, and schema errors without prompt, body, or API-key leakage", async () => {
    const secrets = ["SYNTHETIC_PROMPT_917", "SYNTHETIC_BODY_481", "SYNTHETIC_KEY_263"];
    const transports: DeepSeekTransport[] = [
      async () => { throw new Error(`transport ${secrets.join(" ")}`); },
      async () => ({ status: 500, body: { error: secrets.join(" ") } }),
      async () => ({ status: 200, body: { choices: [{ message: { content: secrets[1]! } }] } }),
      async () => ({ status: 200, body: { choices: [{ message: { content: '{"wrong":true}' } }] } })
    ];

    for (const transport of transports) {
      const provider = new DeepSeekProvider({ endpoint: "https://synthetic.invalid", apiKey: secrets[2]!, model: "model", transport });
      const error = await provider.complete({
        messages: [{ role: "user", content: secrets[0]! }], outputSchema, outputName: "private_fixture"
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiProviderError);
      for (const secret of secrets) expect(String(error)).not.toContain(secret);
    }
  });

  it("sanitizes exceptions thrown by an output schema as invalid output", async () => {
    const privateResponse = "SYNTHETIC_SCHEMA_RESPONSE_771";
    const provider = new DeepSeekProvider({
      endpoint: "https://synthetic.invalid", apiKey: "key", model: "model",
      transport: async () => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ privateResponse }) } }] } })
    });
    const throwingSchema = { safeParse: () => { throw new Error(`schema leaked ${privateResponse}`); } } as unknown as typeof outputSchema;

    const error = await provider.complete({ messages: [], outputSchema: throwingSchema, outputName: "throwing" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe("invalid_output");
    expect(String(error)).not.toContain(privateResponse);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    ["null response", async () => null],
    ["undefined response", async () => undefined],
    ["primitive response", async () => "private primitive"],
    ["throwing status", async () => Object.defineProperty({}, "status", { get: () => { throw new Error("PRIVATE_STATUS_12"); } })],
    ["throwing body", async () => Object.defineProperties({}, {
      status: { value: 200 }, body: { get: () => { throw new Error("PRIVATE_BODY_34"); } }
    })],
    ["throwing nested content", async () => ({ status: 200, body: Object.defineProperty({}, "choices", {
      get: () => { throw new Error("PRIVATE_CHOICES_56"); }
    }) })]
  ])("sanitizes an untrusted %s", async (_label, transportFixture) => {
    const provider = new DeepSeekProvider({
      endpoint: "https://synthetic.invalid", apiKey: "PRIVATE_KEY_78", model: "model",
      transport: transportFixture as unknown as DeepSeekTransport
    });
    const error = await provider.complete({ messages: [], outputSchema, outputName: "untrusted" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe("response");
    expect(String(error)).not.toMatch(/PRIVATE|primitive/u);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("distinguishes a malformed transport envelope from missing completion content", async () => {
    const malformedProvider = new DeepSeekProvider({
      endpoint: "https://synthetic.invalid",
      apiKey: "key",
      model: "model",
      transport: async () => ({ body: {} } as never),
    });
    const missingContentProvider = new DeepSeekProvider({
      endpoint: "https://synthetic.invalid",
      apiKey: "key",
      model: "model",
      transport: async () => ({ status: 200, body: { choices: [] } }),
    });

    const malformed = await malformedProvider.complete({
      messages: [], outputSchema, outputName: "malformed",
    }).catch((caught: unknown) => caught);
    const missing = await missingContentProvider.complete({
      messages: [], outputSchema, outputName: "missing",
    }).catch((caught: unknown) => caught);

    expect(malformed).toMatchObject({
      code: "response",
      message: expect.stringContaining("malformed_transport_response"),
    });
    expect(missing).toMatchObject({
      code: "response",
      message: expect.stringContaining("missing_completion_content"),
    });
  });
});
