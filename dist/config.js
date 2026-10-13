import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export const DEFAULT_LAYOUT = [
    ["ctx", "id"],
    ["5h", "session"],
    ["7d", "lines"],
    ["scoped"],
];
// Defaults written by earlier versions; a config that still holds one of
// these gets the current default instead.
export const LEGACY_LAYOUTS = [
    [
        ["5h", "today", "history"],
        ["7d", "session", "total"],
    ],
    [
        ["5h", "today"],
        ["7d", "session"],
    ],
    [
        ["ctx", "session", "id"],
        ["5h", "today", "month"],
        ["7d", "week", "total"],
    ],
    [
        ["ctx", "id"],
        ["5h", "today"],
        ["7d", "session"],
    ],
    [
        ["ctx", "id"],
        ["5h", "session"],
        ["7d", "today"],
    ],
    [
        ["ctx", "id"],
        ["5h", "session"],
        ["7d", "lines"],
        ["spend"],
    ],
];
export const DEFAULT_AUTO_COLUMNS = 110;
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".claude", "plugins", "ccbar", "config.json");
function parseRows(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    const rows = value.map((row) => Array.isArray(row)
        ? row.filter((item) => typeof item === "string" && item.length > 0)
        : []);
    return rows.length > 0 && rows.every((row) => row.length > 0) ? rows : null;
}
function parsePositiveInteger(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}
export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    try {
        const content = await readFile(configPath, "utf8");
        const parsed = JSON.parse(content);
        return {
            rows: parseRows(parsed.rows),
            compactRows: parseRows(parsed.compactRows),
            columns: parsePositiveInteger(parsed.columns),
            compactBreakpoint: parsePositiveInteger(parsed.compactBreakpoint),
            activity: typeof parsed.activity === "boolean" ? parsed.activity : null,
        };
    }
    catch {
        return {
            rows: null,
            compactRows: null,
            columns: null,
            compactBreakpoint: null,
            activity: null,
        };
    }
}
