import { spawnSync } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EMPTY_ACTIVITY, readSessionActivity } from "./activity.js";
import { cacheDir, readJsonCache, shortHash } from "./cache.js";
import { DEFAULT_AUTO_COLUMNS, loadConfig } from "./config.js";
import { readGitStatus } from "./git.js";
import { doctorStatusline, repairStatusline, setupStatusline } from "./install.js";
import {
  type LiveLimits,
  liveLimitsFromStatus,
  mergeLimits,
  readSavedLiveLimits,
  rememberLiveLimits,
} from "./limits.js";
import {
  type QuotaCache,
  quotaCachePath,
  refreshQuotaCache,
  releaseRefreshLock,
  resolveQuotaSnapshot,
} from "./quota.js";
import { renderStatusline } from "./statusline.js";
import { scanTokenStatsCached } from "./transcript.js";

type CliIo = {
  readStdin: () => Promise<string>;
  writeStdout: (value: string) => void;
};

function createProcessIo(): CliIo {
  return {
    readStdin: async () => {
      const chunks: string[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(String(chunk));
      }
      return chunks.join("");
    },
    writeStdout: (value: string) => {
      process.stdout.write(value);
    },
  };
}

export function isDirectExecution(metaUrl: string, argvPath?: string): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    const metaPath = realpathSync.native(fileURLToPath(metaUrl));
    const execPath = realpathSync.native(argvPath);
    return metaPath === execPath;
  } catch {
    return false;
  }
}

function parsePositiveInteger(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
  }

  if (typeof value === "string" && value.trim()) {
    const normalized = Number.parseInt(value, 10);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
  }

  return null;
}

// Asks the controlling terminal directly: `stty size` on /dev/tty, with no
// shell in between.
function readTtyColumns(): number | null {
  let fd: number | null = null;
  try {
    fd = openSync("/dev/tty", "r");
    const result = spawnSync("stty", ["size"], {
      encoding: "utf8",
      stdio: [fd, "pipe", "ignore"],
      timeout: 250,
    });

    if (result.error || result.status !== 0) {
      return null;
    }

    return parsePositiveInteger(result.stdout.trim().split(/\s+/).at(-1));
  } catch {
    return null;
  } finally {
    if (fd != null) {
      closeSync(fd);
    }
  }
}

export function resolveColumns(
  configuredColumns: number | null | undefined,
  runtime?: {
    stdoutColumns?: number;
    envColumns?: string;
    ttyColumns?: number;
  },
): number {
  const configured = parsePositiveInteger(configuredColumns);
  if (configured != null) {
    return configured;
  }

  const stdoutColumns = parsePositiveInteger(runtime?.stdoutColumns ?? process.stdout.columns);
  if (stdoutColumns != null) {
    return stdoutColumns;
  }

  const envColumns = parsePositiveInteger(runtime?.envColumns ?? process.env.COLUMNS);
  if (envColumns != null) {
    return envColumns;
  }

  const ttyColumns = parsePositiveInteger(runtime?.ttyColumns);
  if (ttyColumns != null) {
    return ttyColumns;
  }

  return readTtyColumns() ?? DEFAULT_AUTO_COLUMNS;
}

function describeWindow(window: { utilization?: unknown; resets_at?: unknown } | undefined, asOf: number | undefined, now: number) {
  if (!window || typeof window.utilization !== "number") {
    return null;
  }
  return {
    percent: window.utilization,
    resetsAt: window.resets_at,
    readingAgeSeconds: asOf ? Math.round((now - asOf) / 1000) : null,
  };
}

// Both sources of the usage limits, for comparing with Claude Code's /usage.
function describeLimits(now: number) {
  const live: LiveLimits = readSavedLiveLimits(cacheDir());
  const api = readJsonCache<QuotaCache>(quotaCachePath());
  const apiQuota = api?.quota as Record<string, any> | undefined;
  return {
    fromClaudeCode: {
      fiveHour: describeWindow(live.five_hour, live.five_hour?.as_of, now),
      weekly: describeWindow(live.seven_day, live.seven_day?.as_of, now),
    },
    fromUsageApi: api
      ? {
          status: api.status,
          failures: api.failures ?? 0,
          fiveHour: describeWindow(apiQuota?.five_hour, api.okAt, now),
          weekly: describeWindow(apiQuota?.seven_day, api.okAt, now),
        }
      : null,
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIo = createProcessIo(),
): Promise<void> {
  const command = argv[0] ?? "render";

  if (command === "setup") {
    await setupStatusline();
    io.writeStdout("ccbar statusline configured\n");
    return;
  }

  if (command === "repair") {
    const repaired = await repairStatusline();
    if (repaired) {
      io.writeStdout("ccbar statusline repaired\n");
    }
    return;
  }

  if (command === "refresh-quota") {
    try {
      await refreshQuotaCache();
    } finally {
      releaseRefreshLock();
    }
    return;
  }

  if (command === "doctor") {
    const report = await doctorStatusline();
    io.writeStdout(`${JSON.stringify({ ...report, limits: describeLimits(Date.now()) }, null, 2)}\n`);
    return;
  }

  const rawInput = await io.readStdin();
  if (!rawInput.trim()) {
    io.writeStdout("");
    return;
  }

  const input = JSON.parse(rawInput);
  const config = await loadConfig(process.env.CCBAR_CONFIG_PATH);
  const projectsDir =
    process.env.CCBAR_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");
  const caches = cacheDir();
  const now = new Date();
  // The usage API is what /usage shows; Claude Code also passes its own
  // reading of the 5-hour and weekly limits from its latest API response,
  // which covers the gaps (a failing or stale fetch, a window that just reset).
  const live = liveLimitsFromStatus(input.rate_limits, now.getTime());
  const saved = rememberLiveLimits(live, caches, now.getTime());
  const hasLive = Boolean(live.five_hour && live.seven_day);
  const snapshot = process.env.CCBAR_QUOTA === "off"
    ? null
    : await resolveQuotaSnapshot({ background: hasLive });
  const quota = mergeLimits(snapshot?.quota ?? null, snapshot?.okAt ?? 0, live, saved, now.getTime());
  const tokens = scanTokenStatsCached(
    projectsDir,
    path.join(caches, `usage-${shortHash(projectsDir)}`),
  );
  const columns = resolveColumns(config.columns);
  const cwd = input.workspace?.current_dir ?? input.cwd ?? "";
  const activity = config.activity === false
    ? EMPTY_ACTIVITY
    : readSessionActivity(input.transcript_path, caches);
  const output = renderStatusline(input, {
    tokens,
    quota,
    columns,
    now,
    config,
    git: readGitStatus(cwd),
    activity,
  });

  for (const line of output.split("\n")) {
    io.writeStdout(`${line}\n`);
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main();
}
