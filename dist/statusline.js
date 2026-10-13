import { DEFAULT_AUTO_COLUMNS, DEFAULT_LAYOUT, LEGACY_LAYOUTS, } from "./config.js";
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const RESET = "\u001b[0m";
const COLUMN_GAP = "   ";
const BAR_LABEL_WIDTH = 8;
// Muted labels, brighter values; hues stay apart for red-green colour blindness.
const COLORS = {
    label: [128, 136, 152],
    dim: [100, 106, 120],
    track: [58, 62, 72],
    value: [214, 219, 228],
    cost: [232, 196, 104],
    model: [120, 196, 214],
    project: [226, 152, 98],
    branch: [168, 146, 222],
    warn: [232, 168, 64],
    tool: [150, 182, 214],
    agent: [190, 150, 220],
    added: [120, 184, 232],
    removed: [232, 128, 104],
};
// Usage scale: blue (plenty left) → amber → vermillion (nearly used up).
const USAGE_STOPS = [
    [0, [86, 156, 214]],
    [0.6, [224, 190, 90]],
    [1, [230, 104, 74]],
];
function sgr([r, g, b], bold = false) {
    return `\u001b[${bold ? "1;" : ""}38;2;${r};${g};${b}m`;
}
function paint(name, value, bold = false) {
    return `${sgr(COLORS[name], bold)}${value}${RESET}`;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function usageRgb(fraction) {
    const t = clamp(fraction, 0, 1);
    for (let index = 1; index < USAGE_STOPS.length; index += 1) {
        const [end, to] = USAGE_STOPS[index];
        const [start, from] = USAGE_STOPS[index - 1];
        if (t <= end) {
            const f = (t - start) / (end - start);
            return [0, 1, 2].map((channel) => Math.round(from[channel] + (to[channel] - from[channel]) * f));
        }
    }
    return USAGE_STOPS[USAGE_STOPS.length - 1][1];
}
function usageBar(pct, width) {
    const clamped = clamp(pct, 0, 100);
    let filled = Math.floor((clamped * width) / 100);
    if (clamped > 0 && filled === 0) {
        filled = 1;
    }
    let bar = "";
    for (let index = 0; index < filled; index += 1) {
        bar += `${sgr(usageRgb((index + 0.5) / width))}━`;
    }
    return `${bar}${sgr(COLORS.track)}${"─".repeat(width - filled)}${RESET}`;
}
function usagePercent(pct, pad = true) {
    const text = `${Math.trunc(pct)}%`;
    return `${sgr(usageRgb(pct / 100), true)}${pad ? text.padEnd(4) : text}${RESET}`;
}
function visibleLength(value) {
    return value.replaceAll(ANSI_RE, "").length;
}
function padVisible(value, width) {
    return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}
function formatCost(value) {
    if (value >= 1_000_000)
        return `$${(value / 1e6).toFixed(1)}M`;
    if (value >= 1_000)
        return `$${(value / 1e3).toFixed(1)}k`;
    if (value >= 100)
        return `$${value.toFixed(0)}`;
    if (value >= 10)
        return `$${value.toFixed(1)}`;
    return `$${value.toFixed(2)}`;
}
// "38 min", "4h 26m", "5d 6h": the unit is always spelled out next to the number.
function formatSpan(milliseconds) {
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1)
        return "<1 min";
    if (minutes < 60)
        return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function shorten(value, max) {
    const singleLine = value.replace(/\s+/g, " ").trim();
    return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}
function getModelName(input) {
    if (typeof input.model === "string") {
        return input.model;
    }
    return input.model?.display_name ?? "Claude";
}
function getProjectStats(tokens, projectDir) {
    const normalized = projectDir.replaceAll("/", "-").replaceAll("_", "-");
    for (const [name, stats] of Object.entries(tokens.projects)) {
        if (name.replaceAll("_", "-") === normalized) {
            return stats;
        }
    }
    return null;
}
function formatCount(value) {
    if (value >= 100_000)
        return `${Math.round(value / 1000)}k`;
    if (value >= 10_000)
        return `${(value / 1000).toFixed(1)}k`;
    return `${Math.trunc(value)}`;
}
function periodCost(stats, period) {
    return stats[`${period}_cost`] + stats[`${period}_ccost`];
}
function barLabel(text) {
    return paint("label", text.padEnd(BAR_LABEL_WIDTH));
}
function resetsIn(value, now, compact) {
    if (typeof value !== "string" || !value) {
        return "";
    }
    const resetAt = Date.parse(value);
    if (Number.isNaN(resetAt)) {
        return "";
    }
    const remaining = resetAt - now.getTime();
    const when = remaining <= 0 ? "now" : formatSpan(remaining);
    return ` ${paint("dim", compact ? "resets" : "resets in")} ${paint("value", when)}`;
}
// Every bar row has the same columns, so the figures line up down the rows:
// "5-hour  ━━──────── 20%  $40.8  resets in 3h 6m"
const SPEND_WIDTH = 6;
function barHead(label, pct, compact, pad = true) {
    const width = compact ? 6 : 10;
    return pct == null
        ? `${barLabel(label)}${usageBar(0, width)} ${paint("dim", pad ? "n/a".padEnd(4) : "n/a")}`
        : `${barLabel(label)}${usageBar(pct, width)} ${usagePercent(pct, pad)}`;
}
function spendColumn(cost) {
    return paint("cost", formatCost(cost).padEnd(SPEND_WIDTH));
}
// The context bar's row has no window of its own, so it carries the
// spending that has none either: this month and all time.
function renderContext({ input, state, compact, maxColumns }) {
    const pct = input.context_window?.used_percentage;
    const known = typeof pct === "number" ? pct : null;
    const head = barHead("Context", known, compact);
    const totals = `${paint("label", "month")} ${paint("cost", formatCost(periodCost(state.tokens, "month")))}` +
        paint("dim", " · ") +
        `${paint("label", compact ? "all" : "all time")} ${paint("cost", formatCost(periodCost(state.tokens, "all")))}`;
    // Too narrow for one line: the totals go on a second, indented one.
    return visibleLength(head) + 1 + visibleLength(totals) <= maxColumns
        ? `${head} ${totals}`
        : `${barHead("Context", known, compact, false)}\n${" ".repeat(BAR_LABEL_WIDTH)}${totals}`;
}
// A reading older than this says how old it is.
const STALE_NOTE_MS = 3 * 60_000;
// A reading old enough to say so: a note follows its reset time.
function staleNote(asOf, now, compact) {
    const age = typeof asOf === "number" ? now.getTime() - asOf : 0;
    if (age < STALE_NOTE_MS) {
        return "";
    }
    return paint("dim", compact ? ` · ${formatSpan(age)} old` : ` · as of ${formatSpan(age)} ago`);
}
// The 5-hour and weekly rows: the limit, then what was spent in its window.
function renderQuota(context, key, label) {
    const { state, now, compact } = context;
    const nowMs = now.getTime();
    const window = state.quota?.[key];
    const lengthMs = key === "five_hour" ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
    const start = windowStart(state.quota, key, lengthMs, nowMs);
    // Without limit data: the last 5 hours, and the calendar week.
    const spend = start != null
        ? spendSince(state.tokens.recent, start)
        : key === "five_hour"
            ? spendSince(state.tokens.recent, nowMs - FIVE_HOURS_MS)
            : periodCost(state.tokens, "week");
    if (typeof window?.utilization !== "number") {
        return `${barHead(label, null, compact)} ${spendColumn(spend)}`.trimEnd();
    }
    // Past its reset, the reading describes a window that is over.
    const resetsAt = Date.parse(window.resets_at ?? "");
    if (!Number.isNaN(resetsAt) && resetsAt <= nowMs) {
        return `${barHead(label, null, compact)} ${spendColumn(spend)} ${paint("dim", "reset, updating")}`;
    }
    return (`${barHead(label, window.utilization, compact)} ${spendColumn(spend)}` +
        resetsIn(window.resets_at, now, compact) +
        staleNote(window.as_of, now, compact));
}
// Weekly limits that count one model only (Fable): a row each, shown once
// that model has been used in the window - the server reports usage, or this
// machine's transcripts have spend on it since the window opened.
function renderScoped({ state, now, compact }) {
    const limits = state.quota?.limits;
    if (!Array.isArray(limits)) {
        return "";
    }
    const nowMs = now.getTime();
    const rows = [];
    for (const limit of limits) {
        const name = limit?.scope?.model?.display_name;
        if (limit?.kind !== "weekly_scoped" || typeof name !== "string" || !name) {
            continue;
        }
        const resetsAt = Date.parse(limit.resets_at ?? "");
        const start = Number.isNaN(resetsAt)
            ? null
            : resetsAt <= nowMs
                ? resetsAt
                : resetsAt - SEVEN_DAYS_MS;
        const spend = start != null ? spendSince(state.tokens.recentByFamily?.[name.toLowerCase()], start) : 0;
        const percent = typeof limit.percent === "number" ? limit.percent : null;
        if (!((percent ?? 0) > 0 || spend > 0)) {
            continue;
        }
        if (!Number.isNaN(resetsAt) && resetsAt <= nowMs) {
            rows.push(`${barHead(name, null, compact)} ${spendColumn(spend)} ${paint("dim", "reset, updating")}`);
            continue;
        }
        rows.push(`${barHead(name, percent, compact)} ${spendColumn(spend)}` +
            resetsIn(limit.resets_at, now, compact) +
            staleNote(state.quota?.limits_as_of, now, compact));
    }
    return rows.join("\n");
}
// The session's effort level, which Claude Code sends as low, medium, high,
// xhigh or max; "thinking off" when the session runs without thinking.
function renderEffort({ input, compact }) {
    const level = input.effort?.level;
    let text = typeof level === "string" && /^[a-z]{1,8}$/.test(level)
        ? `${paint("dim", " · ")}${paint("model", level)}${compact ? "" : paint("dim", " effort")}`
        : "";
    if (input.thinking?.enabled === false) {
        text += `${paint("dim", " · ")}${paint("value", "thinking off")}`;
    }
    return text;
}
function renderIdentity(context) {
    const { input, state } = context;
    // The directory Claude was started in: the same project "this project" spend uses.
    const projectDir = input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd ?? "";
    const project = projectDir.split("/").filter(Boolean).at(-1) ?? "";
    let cell = paint("model", getModelName(input), true) + renderEffort(context);
    if (project) {
        cell += `${paint("dim", " · ")}${paint("project", project)}`;
    }
    const git = state.git;
    if (git) {
        cell += ` ${paint("branch", `⎇ ${git.branch}`)}`;
        if (git.dirty)
            cell += paint("warn", "*");
        if (git.ahead > 0)
            cell += paint("dim", ` ↑${git.ahead}`);
        if (git.behind > 0)
            cell += paint("dim", ` ↓${git.behind}`);
    }
    return cell;
}
function renderSession({ input }) {
    const duration = input.cost?.total_duration_ms ?? 0;
    let cell = `${paint("label", "Session")} ` +
        `${paint("cost", formatCost(input.cost?.total_cost_usd ?? 0), true)}`;
    if (duration > 0) {
        cell += `${paint("dim", " · ")}${paint("value", formatSpan(duration))}`;
    }
    return cell;
}
function renderSpend({ state, projectStats, compact }, label, period) {
    let cell = `${paint("label", label)} ${paint("cost", formatCost(periodCost(state.tokens, period)), true)}`;
    if (projectStats && !compact) {
        cell +=
            `${paint("dim", " · this project ")}` +
                `${paint("cost", formatCost(periodCost(projectStats, period)))}`;
    }
    return cell;
}
function renderLines({ input }) {
    const added = input.cost?.total_lines_added ?? 0;
    const removed = input.cost?.total_lines_removed ?? 0;
    return (`${paint("label", "Lines")} ${paint("added", `+${formatCount(added)}`, true)} ` +
        paint("removed", `−${formatCount(removed)}`, true));
}
const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
// When the current usage-limit window opened, from its reset time. Once that
// reset has passed, the next window opened no earlier than the reset itself.
function windowStart(quota, key, lengthMs, now) {
    const resetsAt = Date.parse(quota?.[key]?.resets_at ?? "");
    if (Number.isNaN(resetsAt)) {
        return null;
    }
    return resetsAt <= now ? resetsAt : resetsAt - lengthMs;
}
function spendSince(recent, startMs) {
    // Limit windows open a fraction of a second before a whole minute
    // (resets_at "…:59.712"): rounding puts the boundary between two of the
    // per-minute buckets, where they split exactly.
    const firstMinute = Math.round(startMs / 60_000);
    let total = 0;
    for (const [minute, cost] of Object.entries(recent ?? {})) {
        if (Number(minute) >= firstMinute)
            total += cost;
    }
    return total;
}
// One row of spending from the shortest period to the longest. "5h" and
// "week" follow the usage-limit windows next to them; without limit data
// they fall back to the last 5 hours and the calendar week.
function renderSpendStrip({ state, now, compact, maxColumns }) {
    const { tokens, quota } = state;
    const fiveHourStart = windowStart(quota, "five_hour", FIVE_HOURS_MS, now.getTime()) ?? now.getTime() - FIVE_HOURS_MS;
    const weekStart = windowStart(quota, "seven_day", SEVEN_DAYS_MS, now.getTime());
    const periods = [
        ["5h", spendSince(tokens.recent, fiveHourStart)],
        ["week", weekStart != null ? spendSince(tokens.recent, weekStart) : periodCost(tokens, "week")],
        ["month", periodCost(tokens, "month")],
        [compact ? "all" : "all time", periodCost(tokens, "all")],
    ];
    const parts = periods.map(([label, cost]) => `${paint("label", label)} ${paint("cost", formatCost(cost), true)}`);
    const separator = paint("dim", " · ");
    const line = barLabel("Spent") + parts.join(separator);
    if (visibleLength(line) <= maxColumns) {
        return line;
    }
    // Too narrow for one line: month and all-time go on a second, indented one.
    return (`${barLabel("Spent")}${parts.slice(0, 2).join(separator)}\n` +
        `${" ".repeat(BAR_LABEL_WIDTH)}${parts.slice(2).join(separator)}`);
}
function renderItem(item, context) {
    switch (item) {
        case "ctx":
            return renderContext(context);
        case "5h":
            return renderQuota(context, "five_hour", "5-hour");
        case "7d":
            return renderQuota(context, "seven_day", "Weekly");
        case "id":
        case "model":
            return renderIdentity(context);
        case "session":
            return renderSession(context);
        case "lines":
            return renderLines(context);
        case "scoped":
            return renderScoped(context);
        case "spend":
            return renderSpendStrip(context);
        case "today":
            return renderSpend(context, "Today", "today");
        case "week":
            return renderSpend(context, "Week", "week");
        case "month":
            return renderSpend(context, "Month", "month");
        case "total":
            return renderSpend(context, "Total", "all");
        case "history":
            return `${renderSpend(context, "Week", "week")}${COLUMN_GAP}${renderSpend(context, "Month", "month")}`;
        default:
            return paint("dim", item);
    }
}
function rowsEqual(left, right) {
    return (left.length === right.length &&
        left.every((row, rowIndex) => row.length === (right[rowIndex]?.length ?? -1) &&
            row.every((item, columnIndex) => item === right[rowIndex]?.[columnIndex])));
}
function configuredRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return null;
    }
    // Layouts that earlier versions wrote as their defaults mean "use the default".
    return LEGACY_LAYOUTS.some((legacy) => rowsEqual(rows, legacy)) ? null : rows;
}
function layoutGrid(cells, columnCount) {
    const rows = cells.map((row) => row.slice(0, columnCount));
    // The last cell of a row with fewer cells runs on across the remaining
    // columns (the spending strip), so it does not widen the column it starts in.
    const widths = Array.from({ length: columnCount }, (_, column) => Math.max(0, ...rows.map((row) => {
        const spans = row.length < columnCount && column === row.length - 1;
        return row[column] && !spans ? visibleLength(row[column]) : 0;
    })));
    const lines = rows.map((row) => row
        .map((cell, column) => (column === row.length - 1 ? cell : padVisible(cell, widths[column])))
        .join(COLUMN_GAP)
        .trimEnd());
    const physical = lines.flatMap((line) => line.split("\n"));
    return { lines, width: Math.max(0, ...physical.map((line) => visibleLength(line))) };
}
function renderGrid(input, state, maxColumns) {
    const now = state.now ?? new Date();
    const projectDir = input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd ?? "";
    const projectStats = getProjectStats(state.tokens, projectDir);
    const config = state.config;
    const wideRows = configuredRows(config?.rows) ?? DEFAULT_LAYOUT;
    const compactRows = configuredRows(config?.compactRows) ?? wideRows;
    const forceCompact = config?.compactBreakpoint != null && maxColumns <= config.compactBreakpoint;
    // A row whose cells all render empty (no Fable use yet) takes no line.
    const render = (rows, compact) => rows
        .map((row) => row.map((item) => renderItem(item, { input, state, projectStats, now, compact, maxColumns })))
        .filter((row) => row.some((cell) => visibleLength(cell) > 0));
    // Full layout if it fits, then the compact one, then drop trailing columns.
    // Cells themselves are never cut.
    if (!forceCompact) {
        const wide = render(wideRows, false);
        const columns = Math.max(1, ...wide.map((row) => row.length));
        const grid = layoutGrid(wide, columns);
        if (grid.width <= maxColumns) {
            return grid.lines.join("\n");
        }
    }
    const compact = render(compactRows, true);
    for (let columns = Math.max(1, ...compact.map((row) => row.length)); columns >= 1; columns -= 1) {
        const grid = layoutGrid(compact, columns);
        if (grid.width <= maxColumns || columns === 1) {
            return grid.lines.join("\n");
        }
    }
    return "";
}
function truncateVisible(value, width) {
    if (visibleLength(value) <= width) {
        return value;
    }
    let out = "";
    let visible = 0;
    for (const part of value.split(/(\u001b\[[0-9;]*m)/)) {
        if (part.startsWith("\u001b[")) {
            out += part;
            continue;
        }
        for (const char of part) {
            if (visible >= width - 1) {
                return `${out}${RESET}${paint("dim", "…")}`;
            }
            out += char;
            visible += 1;
        }
    }
    return out;
}
const BACKGROUND_TASK_MAX_MS = 2 * 3_600_000;
// One line of what is happening right now: running tools, running subagents
// or background tasks, and the todo in progress. Empty when nothing is.
export function renderActivity(activity, now, maxColumns) {
    if (!activity) {
        return "";
    }
    const groups = [];
    const nowMs = now.getTime();
    for (const tool of activity.tools.slice(-2)) {
        const name = tool.name.startsWith("mcp__") ? (tool.name.split("__").at(-1) ?? tool.name) : tool.name;
        groups.push(`${paint("warn", "◐")} ${paint("tool", name)}` +
            (tool.target ? `  ${paint("dim", shorten(tool.target, 40))}` : ""));
    }
    const agents = activity.agents
        .filter((agent) => !agent.background ||
        agent.startTime == null ||
        nowMs - agent.startTime <= BACKGROUND_TASK_MAX_MS)
        .slice(-2);
    for (const agent of agents) {
        let group = `${paint("warn", "◐")} ${paint("agent", agent.task ? agent.type : `${agent.type} agent`)}`;
        if (agent.description) {
            group += `  ${paint("dim", shorten(agent.description, 36))}`;
        }
        if (agent.startTime != null) {
            group += `${paint("dim", " · ")}${paint("value", formatSpan(nowMs - agent.startTime))}`;
        }
        groups.push(group);
    }
    const current = activity.todos.find((todo) => todo.status === "in_progress");
    if (current) {
        const done = activity.todos.filter((todo) => todo.status === "completed").length;
        groups.push(`${paint("warn", "▸")} ${paint("value", shorten(current.content, 48))} ` +
            paint("dim", `(${done} of ${activity.todos.length} done)`));
    }
    return groups.length > 0 ? truncateVisible(groups.join("    "), maxColumns) : "";
}
export function renderStatusline(input, state) {
    const maxColumns = Math.max(1, state.columns ?? state.config?.columns ?? DEFAULT_AUTO_COLUMNS);
    const grid = renderGrid(input, state, maxColumns);
    if (state.config?.activity === false) {
        return grid;
    }
    const activity = renderActivity(state.activity, state.now ?? new Date(), maxColumns);
    return activity ? `${grid}\n${activity}` : grid;
}
