/**
 * Error Classifier — Task 09
 *
 * Maps any error thrown in the Conversation pipeline to a structured
 * ConversationErrorCategory with recovery recommendations.
 *
 * Key rules:
 *  - Error messages must NEVER contain API keys, body text, or absolute paths.
 *  - The classifier sanitizes the message before returning.
 *  - Categories determine recovery strategy.
 */

import { AiProviderError } from "../ai/provider";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

/**
 * All error categories that can occur in the Conversation pipeline.
 */
export type ConversationErrorCategory =
  | "ai_authentication"     // API Key invalid
  | "ai_model_unavailable"  // Model doesn't exist or is deprecated
  | "ai_network"            // Network timeout/interrupt
  | "ai_response"           // Provider response envelope/content is malformed
  | "ai_invalid_output"     // AI returned unstructured or schema-violating output
  | "persistence_write"     // store.save failed
  | "persistence_read"      // store.load failed
  | "archive_write"         // Archive write failed
  | "writeback_rejected"    // Revision conflict or tampered idempotency key
  | "unknown";

export interface ClassifiedError {
  readonly category: ConversationErrorCategory;
  readonly message: string;         // Safe message (no private data)
  readonly recoverable: boolean;    // Can the user retry?
  readonly retry_strategy: "immediate" | "user_triggered" | "none";
}

// ═══════════════════════════════════════════════════════════════════
// Sanitization
// ═══════════════════════════════════════════════════════════════════

/**
 * Patterns that indicate private data that must be stripped from error messages.
 */
const PRIVATE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys: sk-..., Bearer tokens
  { pattern: /sk-[a-zA-Z0-9_-]{10,}/g, replacement: "[API_KEY]" },
  { pattern: /Bearer\s+[a-zA-Z0-9._\-+=]+/gi, replacement: "Bearer [TOKEN]" },
  // Absolute Windows paths: D:\..., C:\...
  { pattern: /[A-Za-z]:\\[^\s,;]+/g, replacement: "[PATH]" },
  // Absolute Unix paths: /home/..., /Users/...
  { pattern: /(?:\/home\/|\/Users\/|\/var\/|\/etc\/|\/tmp\/)[^\s,;]+/g, replacement: "[PATH]" },
  // Very long strings (likely body text) — truncate
  // This is handled separately in truncation
];

/**
 * Maximum safe error message length.
 */
const MAX_ERROR_LENGTH = 300;

/**
 * Sanitize an error message: strip API keys, tokens, absolute paths, truncate long body text.
 */
export function sanitizeErrorMessage(raw: string): string {
  let sanitized = raw;

  // Strip private patterns
  for (const { pattern, replacement } of PRIVATE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  // Truncate very long messages (likely contain body text)
  if (sanitized.length > MAX_ERROR_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_LENGTH - 3) + "...";
  }

  return sanitized;
}

// ═══════════════════════════════════════════════════════════════════
// Classifier
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify any error into a ConversationErrorCategory.
 * Returns a safe ClassifiedError with recovery guidance.
 */
export function classifyConversationError(error: unknown): ClassifiedError {
  // 1. AiProviderError — the primary AI error type
  if (error instanceof AiProviderError) {
    switch (error.code) {
      case "aborted":
        return {
          category: "ai_network",
          message: sanitizeErrorMessage(error.message),
          recoverable: true,
          retry_strategy: "immediate",
        };
      case "transport":
        return {
          category: "ai_network",
          message: sanitizeErrorMessage(error.message),
          recoverable: true,
          retry_strategy: "immediate",
        };
      case "http": {
        const msg = sanitizeErrorMessage(error.message);
        // Check for auth-related HTTP errors
        if (msg.toLowerCase().includes("401") || msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("403")) {
          return {
            category: "ai_authentication",
            message: msg,
            recoverable: true,
            retry_strategy: "user_triggered",
          };
        }
        // Check for model-not-found HTTP errors
        if (msg.toLowerCase().includes("404") || msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("model")) {
          return {
            category: "ai_model_unavailable",
            message: msg,
            recoverable: true,
            retry_strategy: "user_triggered",
          };
        }
        return {
          category: "ai_network",
          message: msg,
          recoverable: true,
          retry_strategy: "immediate",
        };
      }
      case "response":
        return {
          category: "ai_response",
          message: sanitizeErrorMessage(error.message),
          recoverable: true,
          retry_strategy: "user_triggered",
        };
      case "invalid_output":
        return {
          category: "ai_invalid_output",
          message: sanitizeErrorMessage(error.message),
          recoverable: true,
          retry_strategy: "immediate",
        };
    }
  }

  // 2. Named error classes (from test suite and production code)
  if (error instanceof Error) {
    const name = error.constructor.name;
    const msg = sanitizeErrorMessage(error.message);

    switch (name) {
      case "AuthenticationError":
        return {
          category: "ai_authentication",
          message: msg,
          recoverable: true,
          retry_strategy: "user_triggered",
        };
      case "ModelNotFoundError":
        return {
          category: "ai_model_unavailable",
          message: msg,
          recoverable: true,
          retry_strategy: "user_triggered",
        };
      case "NetworkError":
        return {
          category: "ai_network",
          message: msg,
          recoverable: true,
          retry_strategy: "immediate",
        };
      case "RevisionConflictError":
      case "ConversationSaveConflictError":
        return {
          category: "writeback_rejected",
          message: msg,
          recoverable: true,
          retry_strategy: "user_triggered",
        };
      case "IdempotencyKeyTamperedError":
        return {
          category: "writeback_rejected",
          message: msg,
          recoverable: false,
          retry_strategy: "none",
        };
    }

    // Check for known persistence error patterns by message content
    const lower = error.message.toLowerCase();
    if (lower.includes("save") || lower.includes("write") || lower.includes("persist")) {
      return {
        category: "persistence_write",
        message: msg,
        recoverable: true,
        retry_strategy: "immediate",
      };
    }
    if (lower.includes("load") || lower.includes("read") || lower.includes("not found")) {
      return {
        category: "persistence_read",
        message: msg,
        recoverable: true,
        retry_strategy: "immediate",
      };
    }
    if (lower.includes("archive") || lower.includes("归档")) {
      return {
        category: "archive_write",
        message: msg,
        recoverable: true,
        retry_strategy: "user_triggered",
      };
    }

    // Generic error — classify by message
    if (lower.includes("network") || lower.includes("timeout") || lower.includes("econn") || lower.includes("enet")) {
      return {
        category: "ai_network",
        message: msg,
        recoverable: true,
        retry_strategy: "immediate",
      };
    }
    if (lower.includes("auth") || lower.includes("key") || lower.includes("401") || lower.includes("403")) {
      return {
        category: "ai_authentication",
        message: msg,
        recoverable: true,
        retry_strategy: "user_triggered",
      };
    }
    if (lower.includes("model") || lower.includes("404")) {
      return {
        category: "ai_model_unavailable",
        message: msg,
        recoverable: true,
        retry_strategy: "user_triggered",
      };
    }
    if (lower.includes("invalid") || lower.includes("schema") || lower.includes("parse")) {
      return {
        category: "ai_invalid_output",
        message: msg,
        recoverable: true,
        retry_strategy: "immediate",
      };
    }

    return {
      category: "unknown",
      message: msg,
      recoverable: false,
      retry_strategy: "none",
    };
  }

  // 3. Non-Error throwables
  return {
    category: "unknown",
    message: sanitizeErrorMessage(String(error)),
    recoverable: false,
    retry_strategy: "none",
  };
}
