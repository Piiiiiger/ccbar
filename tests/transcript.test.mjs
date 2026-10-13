import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reduceMessages, scanTokenStats, scanTokenStatsCached } from "../dist/transcript.js";

test("reduceMessages keeps the latest record for the same message id", () => {
  const entries = [
    {
      timestamp: "2026-03-19T10:00:00Z",
      message: {
        id: "m1",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      },
    },
    {
      timestamp: "2026-03-19T10:00:01Z",
      message: {
        id: "m1",
        usage: {
          input_tokens: 1,
          output_tokens: 5,
        },
      },
    },
  ];

  const result = reduceMessages(entries);

  assert.equal(result.length, 1);
  assert.equal(result[0].message.usage.output_tokens, 5);
});

test("scanTokenStats deduplicates message ids across project files", async () => {
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), "ccbar-transcript-"));
  const projectDir = path.join(tmpdir, "demo-project");
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const entry = {
    timestamp: "2026-03-14T10:00:00Z",
    type: "assistant",
    message: {
      id: "msg_same",
      model: "claude-sonnet-4-6",
      usage,
    },
  };

  await mkdir(path.join(projectDir, "subagents"), { recursive: true });
  await writeFile(path.join(projectDir, "parent.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  await writeFile(
    path.join(projectDir, "subagents", "child.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );

  const stats = await scanTokenStats(tmpdir, new Date("2026-03-14T12:00:00Z"));

  assert.equal(stats.all_tok, 1200);
  assert.equal(Number(stats.all_cost.toFixed(6)), 0.006);
  assert.equal(stats.projects["demo-project"].all_tok, 1200);
});

function usageLine(id, timestamp, outputTokens, extra = {}) {
  return JSON.stringify({
    timestamp,
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 1000,
      },
    },
    ...extra,
  });
}

test("scanTokenStatsCached matches a full scan while files grow, split mid-line, and disappear", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ccbar-cached-"));
  const cachePath = path.join(root, "cache");
  const projects = path.join(root, "projects");
  const now = new Date("2026-03-14T12:00:00Z");
  const session = path.join(projects, "-tmp-a", "s1.jsonl");
  const resumed = path.join(projects, "-tmp-a", "s2.jsonl");
  const other = path.join(projects, "-tmp-b", "s3.jsonl");

  await mkdir(path.dirname(session), { recursive: true });
  await mkdir(path.dirname(other), { recursive: true });
  await writeFile(session, `${usageLine("m1", "2026-03-14T10:00:00Z", 5)}\n`);
  await writeFile(other, `${usageLine("m9", "2026-03-01T10:00:00Z", 50)}\n`);

  const same = async (label) => {
    const expected = await scanTokenStats(projects, now);
    const actual = scanTokenStatsCached(projects, cachePath, now);
    assert.deepEqual(actual, expected, label);
    return actual;
  };

  await same("cold cache");
  await same("warm cache");

  // Streaming: the same message grows, a second one starts, the last line is
  // still being written when the statusline renders.
  const full = usageLine("m2", "2026-03-14T11:00:00Z", 40);
  await appendFile(
    session,
    `${usageLine("m1", "2026-03-14T10:00:01Z", 30)}\n${full.slice(0, 25)}`,
  );
  const partial = await same("partial last line");
  assert.equal(partial.today_tok, 100 + 30 + 10);

  await appendFile(session, `${full.slice(25)}\n`);
  const completed = await same("completed line");
  assert.equal(completed.today_tok, 2 * (100 + 10) + 30 + 40);
  const recentSpend = Object.values(completed.recent).reduce((sum, cost) => sum + cost, 0);
  assert.equal(
    Number(recentSpend.toFixed(9)),
    Number((completed.today_cost + completed.today_ccost).toFixed(9)),
  );
  // Every test message is Sonnet, so its family's minutes are all of them.
  assert.deepEqual(completed.recentByFamily, { sonnet: completed.recent });
  assert.deepEqual(Object.keys(completed.recent).map(Number), [
    Date.parse("2026-03-14T10:00:00Z") / 60_000,
    Date.parse("2026-03-14T11:00:00Z") / 60_000,
  ]);

  // A resumed session copies an earlier message: counted once per project.
  await writeFile(resumed, `${usageLine("m2", "2026-03-14T11:00:00Z", 40)}\n`);
  const deduplicated = await same("copy in a second file");
  assert.equal(deduplicated.projects["-tmp-a"].today_tok, completed.projects["-tmp-a"].today_tok);

  await rm(other);
  const removed = await same("deleted file");
  assert.equal(removed.projects["-tmp-b"], undefined);
});
