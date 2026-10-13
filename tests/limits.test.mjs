import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { liveLimitsFromStatus, mergeLimits, rememberLiveLimits } from "../dist/limits.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const IN_3H = Date.parse("2026-10-13T15:20:00Z");
const IN_5D = Date.parse("2026-10-18T17:00:00Z");
const AN_HOUR_AGO = NOW - 3_600_000;

test("liveLimitsFromStatus reads Claude Code's rate_limits and skips expired windows", () => {
  const live = liveLimitsFromStatus(
    {
      five_hour: { used_percentage: 17.3, resets_at: IN_3H / 1000 },
      seven_day: { used_percentage: 31.4, resets_at: AN_HOUR_AGO / 1000 },
    },
    NOW,
  );

  assert.deepEqual(live, {
    five_hour: { utilization: 17.3, resets_at: "2026-10-13T15:20:00.000Z", as_of: NOW },
  });
  assert.deepEqual(liveLimitsFromStatus(undefined, NOW), {});
  assert.deepEqual(liveLimitsFromStatus({ five_hour: { used_percentage: "17" } }, NOW), {});
});

test("rememberLiveLimits saves new readings, at most once a minute when unchanged", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccbar-limits-"));
  const file = path.join(dir, "live-limits.json");
  const reading = (utilization, asOf) => ({
    five_hour: { utilization, resets_at: "2026-10-13T15:20:00.000Z", as_of: asOf },
  });

  assert.deepEqual(rememberLiveLimits(reading(17, NOW), dir, NOW), {});
  assert.equal(JSON.parse(readFileSync(file, "utf8")).five_hour.as_of, NOW);

  const written = statSync(file).mtimeMs;
  assert.deepEqual(rememberLiveLimits(reading(17, NOW + 30_000), dir, NOW + 30_000), reading(17, NOW));
  assert.equal(statSync(file).mtimeMs, written);

  rememberLiveLimits(reading(18, NOW + 40_000), dir, NOW + 40_000);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).five_hour.utilization, 18);

  // No live reading this render: the saved one is returned untouched.
  assert.equal(rememberLiveLimits({}, dir, NOW + 50_000).five_hour.utilization, 18);
});

test("mergeLimits shows a recent usage-API reading, as /usage does, and falls back to the live one", () => {
  const api = {
    five_hour: { utilization: 19, resets_at: "2026-10-13T15:20:00.474Z" },
    seven_day: { utilization: 32, resets_at: "2026-10-18T17:00:00.474Z" },
    limits: [{ kind: "weekly_scoped", percent: 0 }],
  };
  const live = {
    seven_day: { utilization: 31, resets_at: new Date(IN_5D).toISOString(), as_of: NOW },
  };

  // Fetched 50 s ago: the API's 32 wins over the live 31 (same meter, rounded differently).
  const recent = mergeLimits(api, NOW - 50_000, live, {}, NOW);
  assert.equal(recent.seven_day.utilization, 32);
  assert.equal(recent.seven_day.as_of, NOW - 50_000);
  assert.deepEqual(recent.limits, api.limits);

  // Fetched 5 minutes ago (say the fetch keeps failing): the fresher live reading wins.
  const stale = mergeLimits(api, NOW - 5 * 60_000, live, {}, NOW);
  assert.equal(stale.seven_day.utilization, 31);
  assert.equal(stale.five_hour.utilization, 19);
});

test("mergeLimits drops a window past its reset when a current reading exists", () => {
  const api = { five_hour: { utilization: 95, resets_at: new Date(AN_HOUR_AGO).toISOString() } };
  const saved = { five_hour: { utilization: 4, resets_at: new Date(NOW + 4 * 3_600_000).toISOString(), as_of: NOW - 600_000 } };

  assert.equal(mergeLimits(api, NOW - 30_000, {}, saved, NOW).five_hour.utilization, 4);

  // Nothing current: keep the expired one so the statusline knows it reset.
  const expired = mergeLimits(api, NOW - 30_000, {}, {}, NOW);
  assert.equal(expired.five_hour.utilization, 95);
  assert.equal(mergeLimits(null, 0, {}, {}, NOW), null);
});
