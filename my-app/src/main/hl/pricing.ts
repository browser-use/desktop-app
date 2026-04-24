/**
 * Codex price table — USD per 1M tokens, per model.
 *
 * Used by the Codex adapter to estimate session cost from token counts. The
 * Claude Code adapter does NOT use this file — the Claude CLI emits
 * `total_cost_usd` directly, which is authoritative.
 *
 * These numbers are ESTIMATES and may drift from OpenAI's dashboard (cached
 * pricing tiers, batch discounts, enterprise rates). When prices change,
 * update this file — no schema or code changes needed.
 *
 * Sources checked at author time: OpenAI pricing page (openai.com/pricing)
 * and the Codex CLI docs. Verify before trusting in billing contexts.
 */

// Per-1M-token rates in USD.
interface ModelPricing {
  /** Standard input tokens. */
  inputPer1M: number;
  /** Reused-prompt-cache tokens (usually 10% of input). */
  cachedInputPer1M: number;
  /** Completion tokens. */
  outputPer1M: number;
}

const PRICES: Record<string, ModelPricing> = {
  'gpt-5':        { inputPer1M: 1.25,  cachedInputPer1M: 0.125, outputPer1M: 10.00 },
  'gpt-5-codex':  { inputPer1M: 1.25,  cachedInputPer1M: 0.125, outputPer1M: 10.00 },
  'gpt-5-mini':   { inputPer1M: 0.25,  cachedInputPer1M: 0.025, outputPer1M: 2.00  },
  'gpt-5-nano':   { inputPer1M: 0.05,  cachedInputPer1M: 0.005, outputPer1M: 0.40  },
  'gpt-4o':       { inputPer1M: 2.50,  cachedInputPer1M: 1.25,  outputPer1M: 10.00 },
  'gpt-4o-mini':  { inputPer1M: 0.15,  cachedInputPer1M: 0.075, outputPer1M: 0.60  },
  'o1':           { inputPer1M: 15.00, cachedInputPer1M: 7.50,  outputPer1M: 60.00 },
  'o3':           { inputPer1M: 2.00,  cachedInputPer1M: 0.50,  outputPer1M: 8.00  },
  'o3-mini':      { inputPer1M: 1.10,  cachedInputPer1M: 0.55,  outputPer1M: 4.40  },
  'o4-mini':      { inputPer1M: 1.10,  cachedInputPer1M: 0.275, outputPer1M: 4.40  },
};

// Used when the model name isn't matched. Tuned to gpt-5 as the Codex default.
const FALLBACK: ModelPricing = PRICES['gpt-5'];

function lookupModel(model: string | undefined): ModelPricing {
  if (!model) return FALLBACK;
  // Exact match first; then prefix match so e.g. 'gpt-5-2026-01-01' still
  // falls under 'gpt-5' if OpenAI ever dates their model ids.
  if (PRICES[model]) return PRICES[model];
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key];
  }
  return FALLBACK;
}

/**
 * Compute dollar cost for a turn's token counts.
 * Returns USD to 6-decimal precision; rounding left to the UI.
 */
export function estimateCostUsd(
  model: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number {
  const p = lookupModel(model);
  // Non-cached input = total input - cached. OpenAI's usage.input_tokens is
  // total-including-cached, so subtracting gives the "fresh" portion that
  // gets charged at the full input rate.
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (freshInput           * p.inputPer1M) / 1_000_000 +
    (usage.cachedInputTokens * p.cachedInputPer1M) / 1_000_000 +
    (usage.outputTokens   * p.outputPer1M) / 1_000_000;
  return cost;
}
