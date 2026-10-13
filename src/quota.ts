import { execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { cacheDir, hash64, readJsonCache, writeJsonCache } from "./cache.js";

export type AuthMode = "oauth" | "api" | "unknown";

export type RenderableQuota = Record<string, unknown>;

export type QuotaCache = {
  status: "ok" | "error";
  // "claude.ai" for subscriptions; any other auth method hides the quota bars.
  authMethod: string;
  tokenFingerprint: string;
  // Time of the last attempt, successful or not.
  fetchedAt: number;
  // The last quota that was fetched successfully, at `okAt`.
  quota: RenderableQuota;
  okAt?: number;
  // Consecutive failed attempts; each one doubles the wait before the next.
  failures?: number;
};

type FetchQuota = () => Promise<RenderableQuota>;

type PollQuotaOptions = {
  token: string;
  fetchQuota: FetchQuota;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
};

export const QUOTA_CACHE_TTL_MS = 60_000;
// While a background refresh runs (or keeps failing), keep showing the last
// good quota for this long rather than blanking the bars.
export const QUOTA_STALE_LIMIT_MS = 10 * 60_000;
const QUOTA_MAX_BACKOFF_MS = 10 * 60_000;
const REFRESH_LOCK_MS = 30_000;
export const QUOTA_API_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const QUOTA_BETA_HEADER = "oauth-2025-04-20";

const execFileAsync = promisify(execFile);
const API_AUTH_METHODS = new Set(["api", "apiKey", "api-key", "accessToken"]);

type AuthStatus = {
  authMethod?: string;
};

type ResolveAuthModeDeps = {
  readAuthStatus?: () => Promise<AuthStatus | null>;
};

type ResolveRenderableQuotaDeps = ResolveAuthModeDeps & {
  readOauthToken?: () => Promise<string>;
  readCache?: () => Promise<QuotaCache | null>;
  writeCache?: (cache: QuotaCache) => Promise<void>;
  fetchQuota?: (token: string) => Promise<RenderableQuota>;
  startRefresh?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Never wait on the network: with nothing cached, refresh in the
  // background and return null (used when Claude Code supplies the limits).
  background?: boolean;
};

export function quotaCachePath(): string {
  return path.join(cacheDir(), "quota.json");
}

function refreshLockPath(): string {
  return path.join(cacheDir(), "quota.lock");
}

async function readAuthStatus(): Promise<AuthStatus | null> {
  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["auth", "status", "--json"],
      {
        timeout: 5_000,
      },
    );
    return JSON.parse(stdout) as AuthStatus;
  } catch {
    return null;
  }
}

function parseOauthToken(raw: string): string {
  const parsed = JSON.parse(raw.trim()) as {
    claudeAiOauth?: {
      accessToken?: string;
    };
  };
  return parsed.claudeAiOauth?.accessToken ?? "";
}

async function readCredentialsFileOauthToken(): Promise<string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  try {
    return parseOauthToken(await readFile(path.join(configDir, ".credentials.json"), "utf8"));
  } catch {
    return "";
  }
}

async function readOauthToken(): Promise<string> {
  return (await readCredentialsFileOauthToken()) || (await readKeychainOauthToken());
}

async function readKeychainOauthToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    );
    return parseOauthToken(stdout);
  } catch {
    return "";
  }
}

async function readQuotaCache(): Promise<QuotaCache | null> {
  const parsed = readJsonCache<Partial<QuotaCache>>(quotaCachePath());
  if (
    !parsed ||
    (parsed.status !== "ok" && parsed.status !== "error") ||
    typeof parsed.authMethod !== "string" ||
    typeof parsed.tokenFingerprint !== "string" ||
    typeof parsed.fetchedAt !== "number" ||
    typeof parsed.quota !== "object" ||
    parsed.quota == null
  ) {
    return null;
  }

  return {
    status: parsed.status,
    authMethod: parsed.authMethod,
    tokenFingerprint: parsed.tokenFingerprint,
    fetchedAt: parsed.fetchedAt,
    quota: parsed.quota,
    okAt: typeof parsed.okAt === "number" ? parsed.okAt : undefined,
    failures: typeof parsed.failures === "number" ? parsed.failures : undefined,
  };
}

async function writeQuotaCache(cache: QuotaCache): Promise<void> {
  writeJsonCache(quotaCachePath(), cache);
}

async function fetchQuotaFromApi(token: string): Promise<RenderableQuota> {
  const response = await fetch(QUOTA_API_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": QUOTA_BETA_HEADER,
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const error = new Error(`quota request failed with status ${response.status}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  return await response.json() as RenderableQuota;
}

export function tokenFingerprint(token: string): string {
  if (!token) {
    return "";
  }

  return hash64(token);
}

export async function resolveAuthMode(
  deps: ResolveAuthModeDeps = {},
): Promise<AuthMode> {
  const status = await (deps.readAuthStatus ?? readAuthStatus)();
  const authMethod = status?.authMethod;

  if (authMethod === "claude.ai") {
    return "oauth";
  }

  if (authMethod && API_AUTH_METHODS.has(authMethod)) {
    return "api";
  }

  return "unknown";
}

export function selectRenderableQuota(
  authMode: AuthMode,
  fingerprint: string,
  cache: QuotaCache | null,
  nowTs: number = Date.now(),
): RenderableQuota | null {
  if (authMode !== "oauth" || !cache) {
    return null;
  }

  if (cache.status !== "ok") {
    return null;
  }

  if (cache.authMethod !== "claude.ai") {
    return null;
  }

  if (cache.tokenFingerprint !== fingerprint) {
    return null;
  }

  if (nowTs - cache.fetchedAt > QUOTA_CACHE_TTL_MS) {
    return null;
  }

  return cache.quota;
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 429
  );
}

export async function pollQuotaWithRetry({
  token,
  fetchQuota,
  sleep = async () => {},
  now = () => Date.now(),
  maxAttempts = 5,
}: PollQuotaOptions): Promise<QuotaCache> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const quota = await fetchQuota();
      return {
        status: "ok",
        authMethod: "claude.ai",
        tokenFingerprint: tokenFingerprint(token),
        fetchedAt: now(),
        quota,
      };
    } catch (error) {
      if (!isRateLimitError(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      await sleep(1000 + attempt * 1000);
    }
  }

  throw new Error("quota polling exhausted all attempts");
}

// Fetches the quota in the foreground and records the outcome in the cache.
// Failures keep the last good quota, so a refresh never blanks the bars.
export async function refreshQuotaCache(
  deps: ResolveRenderableQuotaDeps = {},
  maxAttempts = 2,
): Promise<RenderableQuota | null> {
  const now = deps.now ?? (() => Date.now());
  const token = await (deps.readOauthToken ?? readOauthToken)();
  if (!token) {
    return null;
  }

  const fingerprint = tokenFingerprint(token);
  const writeCache = deps.writeCache ?? writeQuotaCache;
  const authMode = await resolveAuthMode({ readAuthStatus: deps.readAuthStatus });
  if (authMode !== "oauth") {
    await writeCache({
      status: "ok",
      authMethod: authMode,
      tokenFingerprint: fingerprint,
      fetchedAt: now(),
      quota: {},
    });
    return null;
  }

  const previous = await (deps.readCache ?? readQuotaCache)();
  const kept =
    previous?.tokenFingerprint === fingerprint && previous.authMethod === "claude.ai"
      ? previous
      : null;

  try {
    const entry = await pollQuotaWithRetry({
      token,
      fetchQuota: async () => await (deps.fetchQuota ?? fetchQuotaFromApi)(token),
      sleep: deps.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))),
      now,
      maxAttempts,
    });
    await writeCache({ ...entry, okAt: entry.fetchedAt });
    return entry.quota;
  } catch {
    await writeCache({
      status: "error",
      authMethod: "claude.ai",
      tokenFingerprint: fingerprint,
      fetchedAt: now(),
      quota: kept?.quota ?? {},
      okAt: kept?.okAt,
      failures: (previous?.tokenFingerprint === fingerprint ? previous.failures ?? 0 : 0) + 1,
    });
    return null;
  }
}

export function releaseRefreshLock(): void {
  rmSync(refreshLockPath(), { force: true });
}

// Starts `cli.js refresh-quota` as a detached process and returns at once.
// The lock file keeps concurrent renders from starting more than one refresh.
function startBackgroundRefresh(): void {
  const lockPath = refreshLockPath();
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < REFRESH_LOCK_MS) {
        return;
      }
      rmSync(lockPath, { force: true });
    } catch {
      // No lock yet.
    }
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch {
    return;
  }

  try {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    spawn(process.execPath, [cliPath, "refresh-quota"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    releaseRefreshLock();
  }
}

export function quotaRetryDelay(cache: QuotaCache): number {
  if (cache.status !== "error") {
    return QUOTA_CACHE_TTL_MS;
  }

  const failures = Math.max(1, cache.failures ?? 1);
  return Math.min(QUOTA_MAX_BACKOFF_MS, QUOTA_CACHE_TTL_MS * 2 ** (failures - 1));
}

export type QuotaSnapshot = {
  quota: RenderableQuota;
  // When this quota was fetched (ms since the epoch).
  okAt: number;
};

// Renders never wait on the network once a quota is cached: a stale entry is
// shown as-is while a detached process refreshes it for the next render.
export async function resolveQuotaSnapshot(
  deps: ResolveRenderableQuotaDeps = {},
): Promise<QuotaSnapshot | null> {
  const now = deps.now ?? (() => Date.now());
  const token = await (deps.readOauthToken ?? readOauthToken)();
  if (!token) {
    return null;
  }

  const cache = await (deps.readCache ?? readQuotaCache)();
  if (!cache || cache.tokenFingerprint !== tokenFingerprint(token)) {
    if (deps.background) {
      (deps.startRefresh ?? startBackgroundRefresh)();
      return null;
    }
    // First render for this login: one foreground attempt, no retries.
    const startedAt = now();
    const quota = await refreshQuotaCache({ ...deps, readOauthToken: async () => token }, 1);
    return quota ? { quota, okAt: startedAt } : null;
  }

  if (now() - cache.fetchedAt >= quotaRetryDelay(cache)) {
    (deps.startRefresh ?? startBackgroundRefresh)();
  }

  if (cache.authMethod !== "claude.ai" || cache.okAt == null) {
    return null;
  }

  return now() - cache.okAt <= QUOTA_STALE_LIMIT_MS && Object.keys(cache.quota).length > 0
    ? { quota: cache.quota, okAt: cache.okAt }
    : null;
}

export async function resolveRenderableQuota(
  deps: ResolveRenderableQuotaDeps = {},
): Promise<RenderableQuota | null> {
  return (await resolveQuotaSnapshot(deps))?.quota ?? null;
}
