import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseActivity, readSessionActivity } from "../dist/activity.js";
import { parseGitStatus } from "../dist/git.js";

function line(entry) {
  return JSON.stringify(entry);
}

function toolUse(id, name, input = {}, extra = {}) {
  return line({
    type: "assistant",
    timestamp: "2026-03-19T10:00:00Z",
    message: { content: [{ type: "tool_use", id, name, input }] },
    ...extra,
  });
}

function toolResult(id, toolUseResult) {
  return line({
    type: "user",
    timestamp: "2026-03-19T10:01:00Z",
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
    ...(toolUseResult ? { toolUseResult } : {}),
  });
}

function notification(toolUseId, status = "completed") {
  return line({
    type: "queue-operation",
    operation: "enqueue",
    content:
      `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
      `<status>${status}</status>\n</task-notification>`,
  });
}

function prompt(text) {
  return line({ type: "user", origin: { kind: "human" }, message: { content: text } });
}

test("parseActivity keeps only tools and agents that are still running", () => {
  const activity = parseActivity([
    toolUse("t1", "Read", { file_path: "/repo/src/a.ts" }),
    toolUse("t2", "Bash", { command: "npm   test" }),
    toolUse("g1", "Agent", { subagent_type: "Explore", description: "scan" }),
    toolUse("d1", "TodoWrite", {
      todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
      ],
    }),
    toolResult("t1"),
    toolResult("g1", { status: "completed" }),
    line({ isSidechain: true, message: { content: [{ type: "tool_use", id: "s1", name: "Grep" }] } }),
    "not json with tool_use",
  ].join("\n"));

  assert.deepEqual(activity.tools, [{ id: "t2", name: "Bash", target: "npm test" }]);
  assert.deepEqual(activity.agents, []);
  assert.deepEqual(activity.todos.map((todo) => todo.status), ["completed", "in_progress"]);
});

test("background agents and workflows run until their task notification", () => {
  const launched = [
    toolUse("g1", "Agent", { subagent_type: "Explore", description: "find callers" }),
    toolResult("g1", { isAsync: true, status: "async_launched" }),
    toolUse("w1", "Workflow", { script: "..." }),
    toolResult("w1", { status: "async_launched", workflowName: "review-changes" }),
  ];

  const running = parseActivity(launched.join("\n"));
  assert.deepEqual(
    running.agents.map((agent) => [agent.type, agent.description, agent.background, agent.task]),
    [
      ["Explore", "find callers", true, undefined],
      ["Workflow", "review-changes", true, true],
    ],
  );
  assert.deepEqual(running.tools, []);

  const finished = parseActivity([...launched, notification("g1"), notification("w1", "failed")].join("\n"));
  assert.deepEqual(finished.agents, []);
});

test("a new prompt clears interrupted tools but keeps background agents", () => {
  const activity = parseActivity([
    toolUse("t1", "Bash", { command: "sleep 100" }),
    toolUse("g1", "Agent", { subagent_type: "Plan" }),
    toolUse("g2", "Agent", { subagent_type: "Explore" }),
    toolResult("g2", { isAsync: true, status: "async_launched" }),
    prompt("never mind"),
  ].join("\n"));

  assert.deepEqual(activity.tools, []);
  assert.deepEqual(activity.agents.map((agent) => agent.id), ["g2"]);
});

test("readSessionActivity reads appended lines incrementally", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccbar-activity-"));
  const transcript = path.join(dir, "session.jsonl");
  const lines = [
    toolUse("t1", "Bash", { command: "npm test" }),
    toolUse("g1", "Agent", { subagent_type: "Explore", description: "scan" }),
    toolResult("t1"),
    toolResult("g1", { isAsync: true, status: "async_launched" }),
    toolUse("t2", "Edit", { file_path: "/repo/b.ts" }),
  ];

  writeFileSync(transcript, `${lines[0]}\n${lines[1]}\n`);
  assert.deepEqual(readSessionActivity(transcript, dir), parseActivity(lines.slice(0, 2).join("\n")));

  // The last line is still being written: only complete lines count.
  appendFileSync(transcript, `${lines[2]}\n${lines[3]}\n${lines[4].slice(0, 30)}`);
  assert.deepEqual(readSessionActivity(transcript, dir), parseActivity(lines.slice(0, 4).join("\n")));

  appendFileSync(transcript, `${lines[4].slice(30)}\n`);
  const incremental = readSessionActivity(transcript, dir);
  assert.deepEqual(incremental, parseActivity(lines.join("\n")));
  assert.deepEqual(incremental.tools.map((tool) => tool.name), ["Edit"]);
});

test("parseGitStatus reads branch, dirtiness and divergence", () => {
  assert.deepEqual(
    parseGitStatus("# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 x y src/a.ts\n"),
    { branch: "main", dirty: true, ahead: 2, behind: 1 },
  );
  assert.deepEqual(
    parseGitStatus("# branch.oid 0123456789abcdef\n# branch.head (detached)\n"),
    { branch: "0123456", dirty: false, ahead: 0, behind: 0 },
  );
});
