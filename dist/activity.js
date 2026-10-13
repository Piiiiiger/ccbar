import { closeSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { readJsonCache, shortHash, writeJsonCache } from "./cache.js";
const ACTIVITY_CACHE_VERSION = 1;
const TASK_NOTIFICATION_RE = /<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/g;
export const EMPTY_ACTIVITY = { tools: [], agents: [], todos: [] };
function emptyState() {
    return { tools: [], agents: [], todos: [], taskIndex: [] };
}
function extractTarget(name, input) {
    switch (name) {
        case "Read":
        case "Write":
        case "Edit":
        case "NotebookEdit": {
            const file = input.file_path ?? input.notebook_path ?? input.path;
            return typeof file === "string" ? file.split("/").filter(Boolean).at(-1) : undefined;
        }
        case "Glob":
        case "Grep":
            return typeof input.pattern === "string" ? input.pattern : undefined;
        case "Skill":
            return typeof input.skill === "string" ? input.skill : undefined;
        case "Bash":
            return typeof input.command === "string"
                ? input.command.replace(/\s+/g, " ").trim()
                : undefined;
        case "WebFetch":
            return typeof input.url === "string" ? input.url : undefined;
        case "WebSearch":
            return typeof input.query === "string" ? input.query : undefined;
        default:
            return undefined;
    }
}
function normalizeTodoStatus(status) {
    switch (status) {
        case "pending":
        case "not_started":
            return "pending";
        case "in_progress":
        case "running":
            return "in_progress";
        case "completed":
        case "complete":
        case "done":
            return "completed";
        default:
            return null;
    }
}
function applyToolUse(state, block, time) {
    const id = block.id;
    const name = block.name;
    const input = block.input ?? {};
    if (name === "Task" || name === "Agent") {
        state.agents.push({
            id,
            type: typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose",
            description: typeof input.description === "string" ? input.description : undefined,
            startTime: Number.isNaN(time) ? undefined : time,
        });
        return;
    }
    if (name === "TodoWrite") {
        if (Array.isArray(input.todos)) {
            state.todos = [];
            state.taskIndex = [];
            for (const todo of input.todos) {
                const status = normalizeTodoStatus(todo?.status);
                if (typeof todo?.content === "string" && status) {
                    state.todos.push({ content: todo.content, status });
                }
            }
        }
        return;
    }
    if (name === "TaskCreate") {
        const content = (typeof input.subject === "string" && input.subject) ||
            (typeof input.description === "string" && input.description) ||
            "Untitled task";
        state.todos.push({ content, status: normalizeTodoStatus(input.status) ?? "pending" });
        const taskId = input.taskId;
        state.taskIndex.push([
            typeof taskId === "string" || typeof taskId === "number" ? String(taskId) : id,
            state.todos.length - 1,
        ]);
        return;
    }
    if (name === "TaskUpdate") {
        const key = String(input.taskId ?? "");
        let index = state.taskIndex.find(([taskId]) => taskId === key)?.[1];
        if (index == null && /^\d+$/.test(key)) {
            const numeric = Number.parseInt(key, 10) - 1;
            if (numeric >= 0 && numeric < state.todos.length)
                index = numeric;
        }
        const todo = index != null ? state.todos[index] : undefined;
        if (todo) {
            const status = normalizeTodoStatus(input.status);
            if (status)
                todo.status = status;
            if (typeof input.subject === "string" && input.subject)
                todo.content = input.subject;
        }
        return;
    }
    state.tools.push({ id, name, target: extractTarget(name, input) });
}
function finishAgent(state, id) {
    state.agents = state.agents.filter((agent) => agent.id !== id);
}
function applyEntry(state, entry) {
    if (entry.isSidechain === true) {
        return;
    }
    // A prompt typed by the person starts a new turn: anything the last turn
    // left without a result was interrupted. Background agents keep running.
    if (entry.type === "user" && entry.origin?.kind === "human") {
        state.tools = [];
        state.agents = state.agents.filter((agent) => agent.background);
    }
    const raw = entry.message?.content ?? entry.content;
    if (typeof raw === "string") {
        if (raw.includes("<task-notification>")) {
            for (const match of raw.matchAll(TASK_NOTIFICATION_RE)) {
                if (match[2].trim() !== "running")
                    finishAgent(state, match[1].trim());
            }
        }
        return;
    }
    if (!Array.isArray(raw)) {
        return;
    }
    const time = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    for (const block of raw) {
        if (block?.type === "tool_use" && block.id && block.name) {
            applyToolUse(state, block, time);
        }
        else if (block?.type === "tool_result" && block.tool_use_id) {
            const id = block.tool_use_id;
            const tool = state.tools.find((candidate) => candidate.id === id);
            state.tools = state.tools.filter((candidate) => candidate.id !== id);
            const result = entry.toolUseResult;
            const launchedInBackground = result?.isAsync === true || result?.status === "async_launched";
            const agent = state.agents.find((candidate) => candidate.id === id);
            if (agent && launchedInBackground) {
                agent.background = true;
            }
            else if (agent) {
                finishAgent(state, id);
            }
            else if (tool && launchedInBackground) {
                state.agents.push({
                    id,
                    type: tool.name,
                    description: typeof result?.workflowName === "string" ? result.workflowName : tool.target,
                    background: true,
                    task: true,
                    startTime: Number.isNaN(time) ? undefined : time,
                });
            }
        }
    }
}
function applyText(state, text) {
    for (const line of text.split("\n")) {
        if (!line.includes("tool_") &&
            !line.includes("<task-notification>") &&
            !line.includes('"human"')) {
            continue;
        }
        try {
            applyEntry(state, JSON.parse(line));
        }
        catch {
            continue;
        }
    }
}
function toActivity(state) {
    return { tools: state.tools, agents: state.agents, todos: state.todos };
}
export function parseActivity(content) {
    const state = emptyState();
    applyText(state, content);
    return toActivity(state);
}
function pruneOldCaches(dir, keep) {
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    try {
        for (const name of readdirSync(dir)) {
            const filePath = path.join(dir, name);
            if (name.startsWith("activity-") && filePath !== keep && statSync(filePath).mtimeMs < cutoff) {
                rmSync(filePath, { force: true });
            }
        }
    }
    catch {
        // Pruning is housekeeping; never let it break a render.
    }
}
// Reads only the part of the session transcript appended since the last
// render; the parsed state is kept per transcript in the cache directory.
export function readSessionActivity(transcriptPath, cacheDirectory) {
    if (!transcriptPath) {
        return EMPTY_ACTIVITY;
    }
    let stat;
    try {
        stat = statSync(transcriptPath);
    }
    catch {
        return EMPTY_ACTIVITY;
    }
    const cachePath = path.join(cacheDirectory, `activity-${shortHash(transcriptPath)}.json`);
    const cache = readJsonCache(cachePath);
    const resumable = cache?.version === ACTIVITY_CACHE_VERSION &&
        cache.transcript === transcriptPath &&
        cache.ino === stat.ino &&
        stat.size >= cache.size;
    if (resumable && cache.size === stat.size) {
        return toActivity(cache.state);
    }
    const state = resumable ? cache.state : emptyState();
    let offset = resumable ? cache.offset : 0;
    let fd = null;
    try {
        fd = openSync(transcriptPath, "r");
        const buffer = Buffer.allocUnsafe(stat.size - offset);
        const length = readSync(fd, buffer, 0, buffer.length, offset);
        const lastNewline = buffer.subarray(0, length).lastIndexOf(0x0a);
        if (lastNewline >= 0) {
            applyText(state, buffer.subarray(0, lastNewline + 1).toString("utf8"));
            offset += lastNewline + 1;
        }
    }
    catch {
        return resumable ? toActivity(cache.state) : EMPTY_ACTIVITY;
    }
    finally {
        if (fd != null) {
            closeSync(fd);
        }
    }
    if (!cache) {
        pruneOldCaches(cacheDirectory, cachePath);
    }
    writeJsonCache(cachePath, {
        version: ACTIVITY_CACHE_VERSION,
        transcript: transcriptPath,
        ino: stat.ino,
        size: stat.size,
        offset,
        state,
    });
    return toActivity(state);
}
