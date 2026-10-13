import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export function cacheDir() {
    if (process.env.CCBAR_CACHE_DIR) {
        return process.env.CCBAR_CACHE_DIR;
    }
    const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
    return path.join(base, "ccbar");
}
// 64-bit non-cryptographic hash (cyrb53-style mixing, both 32-bit halves
// kept), as 16 hex digits. Loading node:crypto would cost ~7 ms per render.
export function hash64(value) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
export function shortHash(value) {
    return hash64(value).slice(0, 12);
}
export function readJsonCache(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, "utf8"));
    }
    catch {
        return null;
    }
}
// Several Claude Code sessions can render at once, so write to a private temp
// file and rename it into place: readers never see a half-written cache.
export function writeJsonCache(filePath, value) {
    try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(value));
        renameSync(tmpPath, filePath);
    }
    catch {
        // A cache that cannot be written only costs speed on the next render.
    }
}
