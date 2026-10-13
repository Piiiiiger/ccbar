export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  speed?: string;
};

type PricingRate = {
  in: number;
  out: number;
  cc5: number;
  cc1h: number;
  cr: number;
};

// Anthropic first-party list prices, USD per million tokens (as of 2026-10).
// Cache writes cost 1.25x input for the 5-minute TTL and 2x for 1 hour; cache
// reads 0.1x input, except Opus 5.5 (0.05x) and Fable/Mythos 5.1 (0.025x).
const PRICING_TABLE: Record<string, PricingRate> = {
  "claude-fable-5-1": { in: 10, out: 50, cc5: 12.5, cc1h: 20, cr: 0.25 },
  "claude-mythos-5-1": { in: 10, out: 50, cc5: 12.5, cc1h: 20, cr: 0.25 },
  "claude-fable-5": { in: 10, out: 50, cc5: 12.5, cc1h: 20, cr: 1 },
  "claude-mythos-5": { in: 10, out: 50, cc5: 12.5, cc1h: 20, cr: 1 },
  "claude-opus-5-5": { in: 4, out: 20, cc5: 5, cc1h: 8, cr: 0.2 },
  "claude-opus-5": { in: 5, out: 25, cc5: 6.25, cc1h: 10, cr: 0.5 },
  "claude-opus-4-8": { in: 5, out: 25, cc5: 6.25, cc1h: 10, cr: 0.5 },
  "claude-opus-4-7": { in: 5, out: 25, cc5: 6.25, cc1h: 10, cr: 0.5 },
  "claude-opus-4-6": { in: 5, out: 25, cc5: 6.25, cc1h: 10, cr: 0.5 },
  "claude-opus-4-5": { in: 5, out: 25, cc5: 6.25, cc1h: 10, cr: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cc5: 2.5, cc1h: 4, cr: 0.2 },
  "claude-sonnet-5": { in: 2, out: 10, cc5: 2.5, cc1h: 4, cr: 0.2 },
  "claude-sonnet-4-6": { in: 3, out: 15, cc5: 3.75, cc1h: 6, cr: 0.3 },
  "claude-sonnet-4-5": { in: 3, out: 15, cc5: 3.75, cc1h: 6, cr: 0.3 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cc5: 0.125, cc1h: 0.2, cr: 0.01 },
  "claude-haiku-4-5": { in: 1, out: 5, cc5: 1.25, cc1h: 2, cr: 0.1 },
};

// Rates for a whole request whose prompt (input + cache writes + cache reads)
// is longer than `above` tokens.
const LONG_PROMPT_PRICING: Record<string, { above: number; rate: PricingRate }> = {
  "claude-haiku-5-5": {
    above: 100_000,
    rate: { in: 0.5, out: 2.5, cc5: 0.625, cc1h: 1, cr: 0.05 },
  },
};

// Fast mode (usage.speed "fast") is billed at a multiple of the standard rates.
const FAST_MODE_MULTIPLIER: Record<string, number> = {
  "claude-opus-5-5": 2,
  "claude-opus-5": 2,
};

const DEFAULT_PRICING: PricingRate = {
  in: 3,
  out: 15,
  cc5: 3.75,
  cc1h: 6,
  cr: 0.3,
};

// The table key for a model id: exact, or the longest key the id extends
// (dated ids such as claude-haiku-4-5-20251001), after dropping a context
// suffix such as "[1m]" and normalising dots to dashes.
function resolveModelKey(model: string): string | null {
  const base = model.replace(/\[[^\]]*\]$/, "").trim();
  const candidates = [...new Set([base, base.replaceAll(".", "-")])];

  for (const candidate of candidates) {
    if (candidate in PRICING_TABLE) {
      return candidate;
    }
  }

  let best: string | null = null;
  for (const candidate of candidates) {
    for (const knownModel of Object.keys(PRICING_TABLE)) {
      if (candidate.startsWith(`${knownModel}-`) && knownModel.length > (best?.length ?? 0)) {
        best = knownModel;
      }
    }
  }

  return best;
}

function resolvePricing(model: string, usage: Usage): PricingRate {
  const key = resolveModelKey(model);
  if (!key) {
    return DEFAULT_PRICING;
  }

  let rate = PRICING_TABLE[key];
  const long = LONG_PROMPT_PRICING[key];
  const prompt =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  if (long && prompt > long.above) {
    rate = long.rate;
  }

  const fast = usage.speed === "fast" ? FAST_MODE_MULTIPLIER[key] : undefined;
  if (fast) {
    rate = {
      in: rate.in * fast,
      out: rate.out * fast,
      cc5: rate.cc5 * fast,
      cc1h: rate.cc1h * fast,
      cr: rate.cr * fast,
    };
  }

  return rate;
}

export function estimateCost(model: string, usage: Usage): {
  baseCost: number;
  cacheReadCost: number;
} {
  const pricing = resolvePricing(model, usage);
  const cacheCreation = usage.cache_creation ?? {};
  const cacheCreationTotal = usage.cache_creation_input_tokens ?? 0;
  let cacheCreation5m = cacheCreation.ephemeral_5m_input_tokens ?? 0;
  const cacheCreation1h = cacheCreation.ephemeral_1h_input_tokens ?? 0;

  if (cacheCreationTotal > 0 && cacheCreation5m + cacheCreation1h === 0) {
    cacheCreation5m = cacheCreationTotal;
  }

  const baseCost =
    ((usage.input_tokens ?? 0) * pricing.in) / 1e6 +
    ((usage.output_tokens ?? 0) * pricing.out) / 1e6 +
    (cacheCreation5m * pricing.cc5) / 1e6 +
    (cacheCreation1h * pricing.cc1h) / 1e6;

  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) * pricing.cr) / 1e6;

  return { baseCost, cacheReadCost };
}

// Cached per-message costs are only valid for the table they were priced with.
export function pricingFingerprint(): string {
  return JSON.stringify([PRICING_TABLE, LONG_PROMPT_PRICING, FAST_MODE_MULTIPLIER, DEFAULT_PRICING]);
}
