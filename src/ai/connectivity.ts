/**
 * Model Connectivity Test — Task 10
 *
 * Provides a `testModelConnectivity()` function that sends a minimal
 * probe to the DeepSeek API and returns a safe result.
 *
 * Key rules:
 *  - No API response body is ever exposed to the caller.
 *  - All error messages pass through sanitizeErrorMessage.
 *  - Probe is minimal: single system message "ping", max_tokens=1.
 */

import { sanitizeErrorMessage } from "../conversation/error-classifier";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface ConnectivityResult {
  readonly ok: boolean;
  readonly model: string;
  readonly error?: string; // safe, sanitized
}

// ═══════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════

/**
 * Send a minimal probe to the DeepSeek API to verify connectivity.
 *
 * @param endpoint  Base URL (e.g. "https://api.deepseek.com/v1")
 * @param apiKey    DeepSeek API key
 * @param model     Model name to test (e.g. "deepseek-v4-pro")
 * @param signal    Optional AbortSignal for cancellation
 * @returns         ConnectivityResult with ok:true on success
 */
export async function testModelConnectivity(
  endpoint: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<ConnectivityResult> {
  if (!apiKey || apiKey.trim().length === 0) {
    return {
      ok: false,
      model,
      error: sanitizeErrorMessage("API Key is empty"),
    };
  }

  const baseUrl = endpoint.replace(/\/+$/u, "");
  const url = `${baseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: "ping" }],
        max_tokens: 1,
      }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (response.ok) {
      return { ok: true, model };
    }

    // On failure: extract a safe error code — never expose response body
    let errorCode = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      if (
        typeof errorBody === "object" &&
        errorBody !== null &&
        typeof (errorBody as Record<string, unknown>).error === "object"
      ) {
        const err = (errorBody as Record<string, { message?: string }>).error;
        if (typeof err?.message === "string") {
          errorCode = err.message;
        }
      }
    } catch {
      // Body is not JSON or unreadable — use HTTP status only
    }

    return {
      ok: false,
      model,
      error: sanitizeErrorMessage(errorCode),
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      model,
      error: sanitizeErrorMessage(rawMessage),
    };
  }
}
