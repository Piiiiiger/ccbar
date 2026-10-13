import path from "node:path";
import { readJsonCache, writeJsonCache } from "./cache.js";
const WINDOW_KEYS = ["five_hour", "seven_day"];
const LIVE_LIMITS_FILE = "live-limits.json";
// Rewrite the saved copy at least this often, so other sessions can tell how
// recent it is even while the numbers stay the same.
const LIVE_LIMITS_REFRESH_MS = 60_000;
// The usage endpoint is what /usage and claude.ai show; its whole percent can
// be a point above the two-decimal fraction in Claude Code's response headers
// (31.6% reads 32 there, 0.31 in the headers). A reading of it this recent is
// used as is, so the bar matches /usage; older ones compete on freshness.
const API_PREFERRED_MS = 2 * 60_000;
export function liveLimitsFromStatus(rateLimits, now) {
    const live = {};
    for (const key of WINDOW_KEYS) {
        const window = rateLimits?.[key];
        if (typeof window?.used_percentage === "number" &&
            typeof window?.resets_at === "number" &&
            window.resets_at * 1000 > now) {
            live[key] = {
                utilization: window.used_percentage,
                resets_at: new Date(window.resets_at * 1000).toISOString(),
                as_of: now,
            };
        }
    }
    return live;
}
function sameReading(left, right) {
    return left?.utilization === right?.utilization && left?.resets_at === right?.resets_at;
}
// Keeps the latest live reading on disk for sessions that have not had an API
// response yet, and returns what was saved before this render.
export function rememberLiveLimits(live, cacheDirectory, now) {
    const filePath = path.join(cacheDirectory, LIVE_LIMITS_FILE);
    const saved = readJsonCache(filePath) ?? {};
    const keys = WINDOW_KEYS.filter((key) => live[key]);
    if (keys.length === 0) {
        return saved;
    }
    const changed = keys.some((key) => !sameReading(live[key], saved[key]) ||
        now - (saved[key]?.as_of ?? 0) >= LIVE_LIMITS_REFRESH_MS);
    if (changed) {
        writeJsonCache(filePath, { ...saved, ...live });
    }
    return saved;
}
export function readSavedLiveLimits(cacheDirectory) {
    return readJsonCache(path.join(cacheDirectory, LIVE_LIMITS_FILE)) ?? {};
}
function apiWindow(quota, key, asOf) {
    const window = quota?.[key];
    return typeof window?.utilization === "number" && typeof window?.resets_at === "string"
        ? { utilization: window.utilization, resets_at: window.resets_at, as_of: asOf }
        : null;
}
// Picks, per window: the usage API's reading if it is recent and its window
// has not reset; otherwise the freshest current reading among Claude Code's
// live value, a live value saved by another session, and the usage API. If
// every reading has expired, the latest one is kept so the statusline still
// knows when the window reset. Everything else in the API reply (the
// model-scoped weekly rows) is passed through.
export function mergeLimits(api, apiAsOf, live, saved, now) {
    const merged = { ...(api ?? {}) };
    if (Array.isArray(api?.limits)) {
        // The model-scoped rows only come from the API: keep their age.
        merged.limits_as_of = apiAsOf;
    }
    for (const key of WINDOW_KEYS) {
        const fromApi = apiWindow(api, key, apiAsOf);
        const readings = [live[key], saved[key], fromApi].filter((window) => Boolean(window) && typeof window?.as_of === "number" && !Number.isNaN(Date.parse(window.resets_at)));
        const current = readings.filter((window) => Date.parse(window.resets_at) > now);
        const pick = fromApi && current.includes(fromApi) && now - fromApi.as_of <= API_PREFERRED_MS
            ? fromApi
            : (current.length > 0 ? current : readings).sort((a, b) => b.as_of - a.as_of)[0];
        if (pick) {
            merged[key] = pick;
        }
        else {
            delete merged[key];
        }
    }
    return Object.keys(merged).length > 0 ? merged : null;
}
