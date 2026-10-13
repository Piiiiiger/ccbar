import assert from "node:assert/strict";
import test from "node:test";

import { estimateCost } from "../dist/pricing.js";

test("estimateCost normalizes versioned models and prices 1h cache creation", () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 200,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 500,
    },
  };

  const result = estimateCost("claude-opus-4-5-20251101", usage);

  assert.equal(Number(result.baseCost.toFixed(6)), 0.0125);
  assert.equal(Number(result.cacheReadCost.toFixed(6)), 0.0001);
});

test("estimateCost prices claude-fable-5 at its own tier", () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 200,
  };

  const result = estimateCost("claude-fable-5", usage);

  assert.equal(Number(result.baseCost.toFixed(6)), 0.02125);
  assert.equal(Number(result.cacheReadCost.toFixed(6)), 0.0002);
});

test("estimateCost prices claude-opus-4-8 at current opus rates", () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 200,
  };

  const result = estimateCost("claude-opus-4-8", usage);

  assert.equal(Number(result.baseCost.toFixed(6)), 0.010625);
  assert.equal(Number(result.cacheReadCost.toFixed(6)), 0.0001);
});

const USAGE = {
  input_tokens: 1000,
  output_tokens: 100,
  cache_creation_input_tokens: 500,
  cache_read_input_tokens: 200,
};

function cost(model, usage = USAGE) {
  const { baseCost, cacheReadCost } = estimateCost(model, usage);
  return [Number(baseCost.toFixed(8)), Number(cacheReadCost.toFixed(8))];
}

test("estimateCost prices claude-opus-5-5 at $4/$20 with $0.20 cache reads", () => {
  // 1000 x $4 + 100 x $20 + 500 x $5 (5-minute write); 200 x $0.20
  assert.deepEqual(cost("claude-opus-5-5"), [0.0085, 0.00004]);
});

test("estimateCost uses each model's own cache-read rate", () => {
  assert.deepEqual(cost("claude-fable-5-1"), [0.02125, 0.00005]);
  assert.deepEqual(cost("claude-sonnet-5"), [0.00425, 0.00004]);
  assert.deepEqual(cost("claude-sonnet-5-5"), [0.00425, 0.00004]);
});

test("estimateCost resolves context suffixes and dated ids to the longest match", () => {
  assert.deepEqual(cost("claude-opus-5-5[1m]"), cost("claude-opus-5-5"));
  assert.deepEqual(cost("claude-opus-5-5-20261001"), cost("claude-opus-5-5"));
  assert.deepEqual(cost("claude-haiku-4-5-20251001"), cost("claude-haiku-4-5"));
});

test("estimateCost applies Haiku 5.5's long-prompt rate above 100K prompt tokens", () => {
  const short = { input_tokens: 50_000, output_tokens: 1000 };
  const long = { input_tokens: 90_000, cache_read_input_tokens: 60_000, output_tokens: 1000 };
  // 50K x $0.10 + 1K x $0.50
  assert.deepEqual(cost("claude-haiku-5-5", short), [0.0055, 0]);
  // 90K x $0.50 + 1K x $2.50; 60K x $0.05
  assert.deepEqual(cost("claude-haiku-5-5", long), [0.0475, 0.003]);
});

test("estimateCost doubles Opus 5.5 rates in fast mode", () => {
  assert.deepEqual(cost("claude-opus-5-5", { ...USAGE, speed: "fast" }), [0.017, 0.00008]);
  assert.deepEqual(cost("claude-opus-5-5", { ...USAGE, speed: "standard" }), [0.0085, 0.00004]);
});
