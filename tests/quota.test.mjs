import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  pollQuotaWithRetry,
  quotaRetryDelay,
  refreshQuotaCache,
  resolveAuthMode,
  resolveQuotaSnapshot,
  resolveRenderableQuota,
  selectRenderableQuota,
  tokenFingerprint,
} from "../dist/quota.js";

// Keep every test away from the real quota cache.
process.env.CCBAR_CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), "ccbar-quota-test-"));

const NOW = 1_800_000_000_000;

function cacheEntry(overrides = {}) {
  return {
    status: "ok",
    authMethod: "claude.ai",
    tokenFingerprint: tokenFingerprint("token-123"),
    fetchedAt: NOW,
    okAt: NOW,
    quota: { five_hour: { utilization: 42 } },
    ...overrides,
  };
}

const noAuthStatus = async () => {
  throw new Error("auth status must not be read on the fast path");
};

test("selectRenderableQuota rejects oauth quota when auth mode is api", () => {
  const result = selectRenderableQuota("api", "abc", {
    status: "ok",
    authMethod: "claude.ai",
    tokenFingerprint: "abc",
    fetchedAt: Date.now(),
    quota: {
      five_hour: {
        utilization: 10,
      },
    },
  });

  assert.equal(result, null);
});

test("pollQuotaWithRetry retries 429 responses and wraps quota cache", async () => {
  const attempts = [
    { type: "error", status: 429 },
    { type: "error", status: 429 },
    {
      type: "ok",
      body: {
        five_hour: {
          utilization: 42,
        },
      },
    },
  ];
  const sleepCalls = [];

  const result = await pollQuotaWithRetry({
    token: "token-123",
    fetchQuota: async () => {
      const attempt = attempts.shift();
      if (!attempt) {
        throw new Error("unexpected extra attempt");
      }

      if (attempt.type === "error") {
        const error = new Error("rate limited");
        error.status = attempt.status;
        throw error;
      }

      return attempt.body;
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    now: () => 1234567890,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authMethod, "claude.ai");
  assert.equal(result.fetchedAt, 1234567890);
  assert.equal(result.quota.five_hour.utilization, 42);
  assert.equal(typeof result.tokenFingerprint, "string");
  assert.equal(result.tokenFingerprint.length, 16);
  assert.equal(sleepCalls.length, 2);
});

test("resolveAuthMode recognizes claude.ai subscriptions as oauth", async () => {
  const result = await resolveAuthMode({
    readAuthStatus: async () => ({
      authMethod: "claude.ai",
      subscriptionType: "max",
    }),
  });

  assert.equal(result, "oauth");
});

test("resolveRenderableQuota hides cached oauth quota in api mode", async () => {
  let writtenCache = null;
  const quota = await resolveRenderableQuota({
    readAuthStatus: async () => ({
      authMethod: "api",
    }),
    readOauthToken: async () => "token-123",
    writeCache: async (cache) => {
      writtenCache = cache;
    },
    readCache: async () => ({
      status: "ok",
      authMethod: "claude.ai",
      tokenFingerprint: "abc",
      fetchedAt: Date.now(),
      quota: {
        five_hour: {
          utilization: 42,
        },
      },
    }),
  });

  assert.equal(quota, null);
  assert.equal(writtenCache.authMethod, "api");
});

test("resolveRenderableQuota fetches and caches live quota in oauth mode when cache is missing", async () => {
  let writtenCache = null;

  const quota = await resolveRenderableQuota({
    readAuthStatus: async () => ({
      authMethod: "claude.ai",
    }),
    readOauthToken: async () => "token-123",
    readCache: async () => null,
    writeCache: async (cache) => {
      writtenCache = cache;
    },
    fetchQuota: async (token) => {
      assert.equal(token, "token-123");
      return {
        five_hour: {
          utilization: 42,
        },
      };
    },
    now: () => 1234567890,
  });

  assert.equal(quota.five_hour.utilization, 42);
  assert.equal(writtenCache.status, "ok");
  assert.equal(writtenCache.authMethod, "claude.ai");
  assert.equal(writtenCache.fetchedAt, 1234567890);
  assert.equal(writtenCache.quota.five_hour.utilization, 42);
});

test("resolveRenderableQuota serves a fresh cache without running claude auth status", async () => {
  let refreshes = 0;
  const quota = await resolveRenderableQuota({
    readAuthStatus: noAuthStatus,
    readOauthToken: async () => "token-123",
    readCache: async () => cacheEntry({ fetchedAt: NOW - 10_000 }),
    startRefresh: () => {
      refreshes += 1;
    },
    now: () => NOW,
  });

  assert.equal(quota.five_hour.utilization, 42);
  assert.equal(refreshes, 0);
});

test("resolveRenderableQuota shows a stale quota and refreshes it in the background", async () => {
  let refreshes = 0;
  const quota = await resolveRenderableQuota({
    readAuthStatus: noAuthStatus,
    readOauthToken: async () => "token-123",
    readCache: async () => cacheEntry({ fetchedAt: NOW - 120_000, okAt: NOW - 120_000 }),
    startRefresh: () => {
      refreshes += 1;
    },
    now: () => NOW,
  });

  assert.equal(quota.five_hour.utilization, 42);
  assert.equal(refreshes, 1);
});

test("resolveRenderableQuota hides a quota older than the stale limit", async () => {
  const quota = await resolveRenderableQuota({
    readAuthStatus: noAuthStatus,
    readOauthToken: async () => "token-123",
    readCache: async () => cacheEntry({ fetchedAt: NOW - 20_000, okAt: NOW - 11 * 60_000 }),
    startRefresh: () => {},
    now: () => NOW,
  });

  assert.equal(quota, null);
});

test("failed refreshes keep the last good quota and back off", async () => {
  const written = [];
  let cache = cacheEntry({ fetchedAt: NOW - 120_000, okAt: NOW - 120_000 });
  const deps = {
    readAuthStatus: async () => ({ authMethod: "claude.ai" }),
    readOauthToken: async () => "token-123",
    readCache: async () => cache,
    writeCache: async (entry) => {
      written.push(entry);
      cache = entry;
    },
    fetchQuota: async () => {
      const error = new Error("rate limited");
      error.status = 429;
      throw error;
    },
    sleep: async () => {},
    now: () => NOW,
  };

  assert.equal(await refreshQuotaCache(deps), null);
  assert.equal(await refreshQuotaCache(deps), null);

  assert.equal(written.length, 2);
  assert.equal(written[1].status, "error");
  assert.equal(written[1].failures, 2);
  assert.equal(written[1].quota.five_hour.utilization, 42);
  assert.equal(written[1].okAt, NOW - 120_000);
  assert.equal(quotaRetryDelay(cacheEntry()), 60_000);
  assert.equal(quotaRetryDelay(written[0]), 60_000);
  assert.equal(quotaRetryDelay(written[1]), 120_000);
  assert.equal(quotaRetryDelay({ ...written[1], failures: 9 }), 600_000);
});

test("background mode never waits on the network when nothing is cached", async () => {
  let refreshes = 0;
  const snapshot = await resolveQuotaSnapshot({
    readAuthStatus: noAuthStatus,
    readOauthToken: async () => "token-123",
    readCache: async () => null,
    fetchQuota: async () => {
      throw new Error("must not fetch in the foreground");
    },
    startRefresh: () => {
      refreshes += 1;
    },
    background: true,
    now: () => NOW,
  });

  assert.equal(snapshot, null);
  assert.equal(refreshes, 1);
});

test("the snapshot carries when its quota was fetched", async () => {
  const snapshot = await resolveQuotaSnapshot({
    readAuthStatus: noAuthStatus,
    readOauthToken: async () => "token-123",
    readCache: async () => cacheEntry({ fetchedAt: NOW - 20_000, okAt: NOW - 20_000 }),
    startRefresh: () => {},
    now: () => NOW,
  });

  assert.equal(snapshot.okAt, NOW - 20_000);
  assert.equal(snapshot.quota.five_hour.utilization, 42);
});
