// performanceLogger.js - Structured performance logging with request correlation IDs
import { randomBytes } from "crypto";

/**
 * Generate a short request ID
 * @returns {string} - 8-character hex request ID
 */
export function generateRequestId() {
  return randomBytes(4).toString("hex");
}

/**
 * Log performance metric with request ID
 * @param {string} requestId - Request correlation ID
 * @param {string} phase - Phase name (e.g., "start", "firestore_reads", "rag", "openai_call", "end")
 * @param {number} ms - Elapsed milliseconds
 * @param {object} extra - Additional metadata (optional)
 */
export function logPerformance(requestId, phase, ms, extra = {}) {
  const extraStr = Object.keys(extra).length > 0 
    ? " " + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")
    : "";
  console.log(`[RID:${requestId}] phase=${phase} ms=${ms}${extraStr}`);
}

/**
 * Log token usage if available
 * @param {string} requestId - Request correlation ID
 * @param {object} usage - OpenAI usage object with prompt_tokens, completion_tokens, total_tokens
 */
export function logTokenUsage(requestId, usage) {
  if (usage && typeof usage === "object") {
    logPerformance(requestId, "token_usage", 0, {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    });
  }
}

/**
 * Log prompt size
 * @param {string} requestId - Request correlation ID
 * @param {number} charCount - Character count of prompt
 * @param {number} messageCount - Number of messages in conversation
 */
export function logPromptSize(requestId, charCount, messageCount) {
  logPerformance(requestId, "prompt_size", 0, {
    chars: charCount,
    messages: messageCount,
  });
}

/**
 * Estimate token count from text (rough approximation: ~4 chars per token for mixed Hebrew/English)
 * @param {string} text - Text to estimate tokens for
 * @returns {number} - Estimated token count
 */
export function estimateTokens(text) {
  if (!text || typeof text !== "string") return 0;
  // Rough approximation: ~4 characters per token for Hebrew/English mixed text
  // This is conservative and may overestimate slightly
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for messages array
 * @param {Array} messages - Array of message objects with role and content
 * @returns {number} - Estimated total token count
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, msg) => {
    const content = msg.content || "";
    // Add overhead for role and message structure (~10 tokens per message)
    return total + estimateTokens(content) + 10;
  }, 0);
}

