import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../dist/cli.js";
import { renderStatusline } from "../dist/statusline.js";

const PROJECT_STATS = {
  today_tok: 1200,
  today_cost: 2.25,
  today_ccost: 0.04,
  today_cr_tok: 0,
  today_in_tok: 1000,
  week_tok: 1200,
  week_cost: 9,
  week_ccost: 0,
  week_cr_tok: 0,
  week_in_tok: 1000,
  month_tok: 1200,
  month_cost: 30,
  month_ccost: 0,
  all_tok: 1200,
  all_cost: 40,
  all_ccost: 0,
  all_cr_tok: 0,
  all_in_tok: 1000,
};

const minute = (iso) => String(Math.floor(Date.parse(iso) / 60_000));

const TOKENS = {
  ...PROJECT_STATS,
  today_cost: 147,
  week_cost: 443,
  month_cost: 3600,
  all_cost: 4000,
  projects: {
    "-tmp-demo": PROJECT_STATS,
  },
  // Spend per minute. The limit windows below open at 09:27 (5-hour) and at
  // 16:00 on the 17th (weekly), so the minute just before each one is outside.
  recent: {
    [minute("2026-03-17T15:59:00Z")]: 7,
    [minute("2026-03-18T12:00:00Z")]: 100,
    [minute("2026-03-19T09:26:00Z")]: 5,
    [minute("2026-03-19T09:30:00Z")]: 30,
  },
};

const INPUT = {
  model: { display_name: "Opus 5.5" },
  workspace: {
    current_dir: "/tmp/demo",
    project_dir: "/tmp/demo",
  },
  context_window: {
    used_percentage: 34,
  },
  cost: {
    total_cost_usd: 1.23,
    total_duration_ms: 15 * 60_000,
    total_lines_added: 2963,
    total_lines_removed: 9,
  },
};

const NOW = new Date("2026-03-19T10:00:00Z");

// Real reset times land a fraction of a second before a whole minute.
const QUOTA = {
  five_hour: {
    utilization: 5,
    resets_at: "2026-03-19T14:26:59.712Z",
  },
  seven_day: {
    utilization: 30,
    resets_at: "2026-03-24T15:59:59.712Z",
  },
};

const GIT = { branch: "main", dirty: true, ahead: 1, behind: 0 };

function plain(output) {
  return output.split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

function render(overrides = {}) {
  return plain(renderStatusline(INPUT, {
    tokens: TOKENS,
    quota: QUOTA,
    columns: 120,
    git: GIT,
    now: NOW,
    ...overrides,
  }));
}

test("default layout: each limit followed by its spending; month and all time beside Context", () => {
  const lines = render();

  assert.deepEqual(lines, [
    "Context ━━━─────── 34%  month $3.6k · all time $4.0k   Opus 5.5 · demo ⎇ main* ↑1",
    "5-hour  ━───────── 5%   $30.0  resets in 4h 26m        Session $1.23 · 15 min",
    "Weekly  ━━━─────── 30%  $135   resets in 5d 5h         Lines +2963 −9",
  ]);
});

test("5-hour and week spending follow the usage-limit windows", () => {
  // 5-hour window from 09:27: only the $30 at 09:30. Weekly window from 16:00
  // on the 17th: $100 + $5 + $30; the $7 at 15:59 falls just outside.
  const [, fiveHour, weekly] = render();
  assert.equal(fiveHour.includes(" 5%   $30.0  resets in"), true);
  assert.equal(weekly.includes(" 30%  $135   resets in"), true);
});

test("without limit data, spending uses the last 5 hours and the calendar week", () => {
  const [, fiveHour, weekly] = render({ quota: null });
  assert.equal(fiveHour.startsWith("5-hour  ────────── n/a  $35.0"), true);
  assert.equal(weekly.startsWith("Weekly  ────────── n/a  $443"), true);
});

test("the lines counter shortens large counts", () => {
  const lines = plain(renderStatusline(
    { ...INPUT, cost: { ...INPUT.cost, total_lines_added: 12_345, total_lines_removed: 250_000 } },
    { tokens: TOKENS, quota: QUOTA, columns: 120, now: NOW },
  ));
  assert.equal(lines[2].endsWith("Lines +12.3k −250k"), true);
});

test("every number on the default bar has a word next to it", () => {
  const text = render().join("\n");

  for (const removed of ["♻", "›", "/h", "→", "tok"]) {
    assert.equal(text.includes(removed), false, `${removed} should not be shown`);
  }
});

test("quota rows say n/a when no quota is available", () => {
  const lines = render({ quota: null });

  assert.match(lines[1], /^5-hour {2}─{10} n\/a /);
  assert.match(lines[2], /^Weekly {2}─{10} n\/a /);
  assert.equal(lines.length, 3);
});

const fable = (percent) => ({
  ...QUOTA,
  limits: [
    {
      kind: "weekly_scoped",
      percent,
      resets_at: "2026-03-24T15:59:59.712Z",
      scope: { model: { display_name: "Fable" } },
    },
  ],
});

// Fable spend: $12 at 09:30 today, and $3 just before its window opened.
const FABLE_TOKENS = {
  ...TOKENS,
  recentByFamily: {
    fable: {
      [minute("2026-03-17T15:59:00Z")]: 3,
      [minute("2026-03-19T09:30:00Z")]: 12,
    },
  },
};

test("the Fable bar stays hidden until Fable has been used this week", () => {
  assert.equal(render({ quota: fable(0) }).length, 3);
  assert.equal(render({ quota: fable(0) }).join("\n").includes("Fable"), false);
});

test("the Fable bar appears once the server reports Fable usage", () => {
  const lines = render({ quota: fable(41) });
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "Fable   ━━━━────── 41%  $0.00  resets in 5d 5h");
});

test("the Fable bar appears once this machine has spent on Fable in its window", () => {
  // The server still rounds light use to 0%; the $12 since the window opened counts.
  const lines = plain(renderStatusline(INPUT, {
    tokens: FABLE_TOKENS,
    quota: fable(0),
    columns: 120,
    now: NOW,
  }));
  assert.equal(lines[3], "Fable   ────────── 0%   $12.0  resets in 5d 5h");
});

test("a window past its reset shows no stale percentage, and spending counts from the reset", () => {
  const quota = {
    ...QUOTA,
    // The 5-hour window reset at 09:00, before NOW (10:00).
    five_hour: { utilization: 95, resets_at: "2026-03-19T09:00:00Z" },
  };
  const lines = render({ quota });

  // Since the 09:00 reset: the $5 at 09:26 and the $30 at 09:30.
  assert.equal(lines[1].startsWith("5-hour  ────────── n/a  $35.0  reset, updating   "), true);
  assert.equal(lines[1].includes("95%"), false);
});

test("a reading more than 3 minutes old says how old it is", () => {
  const quota = {
    ...QUOTA,
    five_hour: { ...QUOTA.five_hour, as_of: NOW.getTime() - 7 * 60_000 },
    seven_day: { ...QUOTA.seven_day, as_of: NOW.getTime() - 60_000 },
  };
  const lines = render({ quota });

  assert.equal(lines[1].includes("resets in 4h 26m · as of 7 min ago"), true);
  assert.equal(lines[2].includes("ago"), false);
});

test("the effort level follows the model name", () => {
  const withEffort = { ...INPUT, effort: { level: "medium" }, thinking: { enabled: true } };
  const render2 = (input, columns) => plain(renderStatusline(input, {
    tokens: TOKENS, quota: QUOTA, columns, git: GIT, now: NOW,
  }));

  assert.equal(render2(withEffort, 120)[0].endsWith("Opus 5.5 · medium effort · demo ⎇ main* ↑1"), true);
  // Compact: the level alone, still next to the model.
  assert.equal(render2(withEffort, 90)[0].endsWith("Opus 5.5 · medium · demo ⎇ main* ↑1"), true);
  assert.equal(
    render2({ ...withEffort, effort: { level: "xhigh" }, thinking: { enabled: false } }, 120)[0]
      .endsWith("Opus 5.5 · xhigh effort · thinking off · demo ⎇ main* ↑1"),
    true,
  );
  // Models without effort: nothing is added.
  assert.equal(render2(INPUT, 120)[0].endsWith("Opus 5.5 · demo ⎇ main* ↑1"), true);
});

test("narrow terminals get the compact layout, then lose the right column", () => {
  assert.equal(render()[0].length > 76, true);

  const compact = render({ columns: 76 });
  assert.deepEqual(compact, [
    "Context ━━──── 34%  month $3.6k · all $4.0k   Opus 5.5 · demo ⎇ main* ↑1",
    "5-hour  ━───── 5%   $30.0  resets 4h 26m      Session $1.23 · 15 min",
    "Weekly  ━───── 30%  $135   resets 5d 5h       Lines +2963 −9",
  ]);
  assert.equal(compact.every((line) => line.length <= 76), true);

  // Below that only the limits remain, and the totals wrap under Context.
  assert.deepEqual(render({ columns: 40 }), [
    "Context ━━──── 34%",
    "        month $3.6k · all $4.0k",
    "5-hour  ━───── 5%   $30.0  resets 4h 26m",
    "Weekly  ━───── 30%  $135   resets 5d 5h",
  ]);
});

test("layouts saved by earlier versions fall back to the new default", () => {
  const legacy = render({
    config: { rows: [["5h", "today", "history"], ["7d", "session", "total"]] },
  });
  assert.deepEqual(legacy, render());
});

test("custom rows can bring back week, month and total", () => {
  const lines = render({
    config: { rows: [["5h", "week"], ["7d", "total"]] },
  });

  assert.equal(lines.length, 2);
  assert.equal(lines[0].includes("Week $443 · this project $9.00"), true);
  assert.equal(lines[1].includes("Total $4.0k · this project $40.0"), true);
});

test("the activity line shows only what is running", () => {
  const lines = render({
    activity: {
      tools: [{ id: "t1", name: "Bash", target: "npm test" }],
      agents: [
        {
          id: "a1",
          type: "Explore",
          description: "find callers",
          startTime: NOW.getTime() - 2 * 60_000,
        },
        {
          id: "w1",
          type: "Workflow",
          description: "review-changes",
          background: true,
          task: true,
          startTime: NOW.getTime() - 3 * 3_600_000,
        },
      ],
      todos: [
        { content: "Wire git", status: "completed" },
        { content: "Render activity", status: "in_progress" },
      ],
    },
  });

  assert.equal(lines.length, 4);
  assert.equal(
    lines[3],
    "◐ Bash  npm test    ◐ Explore agent  find callers · 2 min    ▸ Render activity (1 of 2 done)",
  );
});

test("the activity line disappears when idle or disabled", () => {
  assert.equal(render({ activity: { tools: [], agents: [], todos: [] } }).length, 3);
  assert.equal(
    render({
      config: { activity: false },
      activity: { tools: [{ id: "t1", name: "Bash" }], agents: [], todos: [] },
    }).length,
    3,
  );
});

test("main reads Claude stdin JSON and writes rendered statusline", async () => {
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), "ccbar-cli-"));
  const projectDir = path.join(tmpdir, "projects", "-tmp-demo");
  const entry = {
    timestamp: "2026-03-19T10:00:00Z",
    type: "assistant",
    message: {
      id: "msg1",
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
  const writes = [];
  const previous = {
    CCBAR_PROJECTS_DIR: process.env.CCBAR_PROJECTS_DIR,
    CCBAR_CACHE_DIR: process.env.CCBAR_CACHE_DIR,
    CCBAR_QUOTA: process.env.CCBAR_QUOTA,
  };

  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "session.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  process.env.CCBAR_PROJECTS_DIR = path.join(tmpdir, "projects");
  process.env.CCBAR_CACHE_DIR = path.join(tmpdir, "cache");
  process.env.CCBAR_QUOTA = "off";

  try {
    await main(
      [],
      {
        readStdin: async () => JSON.stringify(INPUT),
        writeStdout: (value) => {
          writes.push(value);
        },
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  assert.equal(writes.length, 3);
  assert.equal(writes[0].includes("Context"), true);
  assert.equal(writes[1].includes("5-hour"), true);
  assert.equal(writes[2].includes("Weekly"), true);
  assert.equal(writes.every((value) => value.endsWith("\n")), true);
});
