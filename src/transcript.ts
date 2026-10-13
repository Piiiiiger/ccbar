import { closeSync, openSync, readdirSync, readSync, rmSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

import { readJsonCache, shortHash, writeJsonCache } from "./cache.js";
import { estimateCost, pricingFingerprint } from "./pricing.js";

export type TranscriptUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type TranscriptMessage = {
  id?: string;
  model?: string;
  usage?: TranscriptUsage;
};

export type TranscriptEntry = {
  timestamp?: string;
  type?: string;
  message?: TranscriptMessage;
};

type StatsBucket = {
  today_tok: number;
  today_cost: number;
  today_ccost: number;
  today_cr_tok: number;
  today_in_tok: number;
  week_tok: number;
  week_cost: number;
  week_ccost: number;
  week_cr_tok: number;
  week_in_tok: number;
  month_tok: number;
  month_cost: number;
  month_ccost: number;
  all_tok: number;
  all_cost: number;
  all_ccost: number;
  all_cr_tok: number;
  all_in_tok: number;
};

export type TokenStats = StatsBucket & {
  projects: Record<string, StatsBucket>;
  // Spend (base + cache-read cost) per minute over the last RECENT_MS, keyed
  // by minutes since the epoch: for windows that do not start at midnight,
  // such as the 5-hour and weekly usage limits.
  recent: Record<string, number>;
  // The same, per model family ("opus", "fable", ...), for limits that only
  // count one model, such as the Fable weekly limit.
  recentByFamily: Record<string, Record<string, number>>;
};

const ZERO_BUCKET: StatsBucket = {
  today_tok: 0,
  today_cost: 0,
  today_ccost: 0,
  today_cr_tok: 0,
  today_in_tok: 0,
  week_tok: 0,
  week_cost: 0,
  week_ccost: 0,
  week_cr_tok: 0,
  week_in_tok: 0,
  month_tok: 0,
  month_cost: 0,
  month_ccost: 0,
  all_tok: 0,
  all_cost: 0,
  all_ccost: 0,
  all_cr_tok: 0,
  all_in_tok: 0,
};

export function reduceMessages(entries: TranscriptEntry[]): TranscriptEntry[] {
  const messagesById = new Map<string, TranscriptEntry>();

  for (const entry of entries) {
    const messageId = entry.message?.id;
    const usage = entry.message?.usage;
    const timestamp = entry.timestamp ?? "";

    if (!messageId || !usage || !timestamp || entry.type === "progress") {
      continue;
    }

    const previous = messagesById.get(messageId);
    const currentOutputTokens = usage.output_tokens ?? 0;
    const previousOutputTokens = previous?.message?.usage?.output_tokens ?? 0;
    const shouldReplace =
      !previous ||
      timestamp > (previous.timestamp ?? "") ||
      (timestamp === previous.timestamp && currentOutputTokens >= previousOutputTokens);

    if (shouldReplace) {
      messagesById.set(messageId, entry);
    }
  }

  return [...messagesById.values()];
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date: Date): Date {
  const dayStart = startOfLocalDay(date);
  const day = dayStart.getDay();
  const distanceFromMonday = (day + 6) % 7;
  dayStart.setDate(dayStart.getDate() - distanceFromMonday);
  return dayStart;
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

// One deduplicated assistant message, priced once when its line is first read:
// [message id, timestamp ms, output tokens, total tokens, base cost,
//  cache-read cost, cache-read tokens, input tokens, model family]
type MessageRecord = [string, number, number, number, number, number, number, number, string];

type FileEntry = {
  size: number;
  mtimeMs: number;
  ino: number;
  offset: number;
  records: MessageRecord[];
};

// Per local day: [total tokens, base cost, cache-read cost, cache-read tokens, input tokens]
type DayTotals = [number, number, number, number, number];

type ProjectSummary = {
  signature: string;
  days: Record<string, DayTotals>;
  // Spend per model family, then per minute, for messages since RECENT_MS
  // before the summary was made.
  minutes: Record<string, Record<string, number>>;
};

// index.json: small, read on every render. A project whose files are
// unchanged is summed from its daily totals without opening its own cache.
type UsageIndex = {
  version: number;
  pricing: string;
  root: string;
  timeZone: string;
  projects: Record<string, ProjectSummary>;
};

// project-<hash>.json: every message of one project, read only when one of
// the project's transcript files changed.
type ProjectCache = {
  version: number;
  pricing: string;
  project: string;
  files: Record<string, FileEntry>;
};

const PROJECT_CACHE_VERSION = 3;
const INDEX_VERSION = 4;
const RECENT_MS = 8 * 24 * 3_600_000;
const MINUTE_MS = 60_000;

// "claude-fable-5-1" -> "fable"; "" when the id is not a Claude model.
export function modelFamily(model: string): string {
  return /^claude-([a-z]+)/.exec(model)?.[1] ?? "";
}

function toRecord(entry: TranscriptEntry): MessageRecord | null {
  const messageId = entry.message?.id;
  const usage = entry.message?.usage;
  if (!messageId || !usage || !entry.timestamp || entry.type === "progress") {
    return null;
  }

  const timestamp = Date.parse(entry.timestamp);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const { baseCost, cacheReadCost } = estimateCost(entry.message?.model ?? "", usage);
  return [
    messageId,
    timestamp,
    usage.output_tokens ?? 0,
    (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    baseCost,
    cacheReadCost,
    usage.cache_read_input_tokens ?? 0,
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    modelFamily(entry.message?.model ?? ""),
  ];
}

// Streaming writes several lines per message id: the latest line wins, and on
// a timestamp tie the one with more output tokens (same rule as reduceMessages).
function mergeRecord(records: Map<string, MessageRecord>, record: MessageRecord): void {
  const previous = records.get(record[0]);
  if (
    !previous ||
    record[1] > previous[1] ||
    (record[1] === previous[1] && record[2] >= previous[2])
  ) {
    records.set(record[0], record);
  }
}

function parseLines(text: string, records: Map<string, MessageRecord>): void {
  for (const line of text.split("\n")) {
    if (!line.includes('"input_tokens"')) {
      continue;
    }

    try {
      const record = toRecord(JSON.parse(line) as TranscriptEntry);
      if (record) {
        mergeRecord(records, record);
      }
    } catch {
      continue;
    }
  }
}

// Reads [start, end) and parses every complete line; returns the offset just
// past the last line consumed, so a line still being written is read next time.
function readRange(
  filePath: string,
  start: number,
  end: number,
  records: Map<string, MessageRecord>,
): number {
  if (end <= start) {
    return start;
  }

  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(end - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const chunk = buffer.subarray(0, length);
    const lastNewline = chunk.lastIndexOf(0x0a);
    const tail = chunk.subarray(lastNewline + 1).toString("utf8");

    if (lastNewline >= 0) {
      parseLines(chunk.subarray(0, lastNewline + 1).toString("utf8"), records);
    }

    if (tail.trim()) {
      try {
        JSON.parse(tail);
        parseLines(tail, records);
        return start + length;
      } catch {
        return start + lastNewline + 1;
      }
    }

    return start + length;
  } catch {
    return start;
  } finally {
    if (fd != null) {
      closeSync(fd);
    }
  }
}

function listJsonlFiles(dirPath: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  // Plain code-unit order: localeCompare would load ICU collation (~9 ms) on every render.
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function listProjects(projectsDir: string): string[] {
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

type Bounds = { day: number; week: number; month: number };

function addTotals(bucket: StatsBucket, totals: DayTotals, dayStart: number, bounds: Bounds): void {
  const [totalTokens, baseCost, cacheReadCost, cacheReadTokens, inputTokens] = totals;

  bucket.all_tok += totalTokens;
  bucket.all_cost += baseCost;
  bucket.all_ccost += cacheReadCost;
  bucket.all_cr_tok += cacheReadTokens;
  bucket.all_in_tok += inputTokens;

  if (dayStart >= bounds.month) {
    bucket.month_tok += totalTokens;
    bucket.month_cost += baseCost;
    bucket.month_ccost += cacheReadCost;
  }

  if (dayStart >= bounds.week) {
    bucket.week_tok += totalTokens;
    bucket.week_cost += baseCost;
    bucket.week_ccost += cacheReadCost;
    bucket.week_cr_tok += cacheReadTokens;
    bucket.week_in_tok += inputTokens;
  }

  if (dayStart >= bounds.day) {
    bucket.today_tok += totalTokens;
    bucket.today_cost += baseCost;
    bucket.today_ccost += cacheReadCost;
    bucket.today_cr_tok += cacheReadTokens;
    bucket.today_in_tok += inputTokens;
  }
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayStart(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

// Message ids are deduplicated per project directory, across all its files;
// the surviving messages are summed per local day, and those since
// `recentSince` also per minute.
function summarize(
  fileRecords: MessageRecord[][],
  recentSince: number,
): Pick<ProjectSummary, "days" | "minutes"> {
  const merged = new Map<string, MessageRecord>();
  for (const records of fileRecords) {
    for (const record of records) {
      mergeRecord(merged, record);
    }
  }

  const days: Record<string, DayTotals> = {};
  const minutes: Record<string, Record<string, number>> = {};
  for (const record of merged.values()) {
    const totals = (days[dayKey(record[1])] ??= [0, 0, 0, 0, 0]);
    totals[0] += record[3];
    totals[1] += record[4];
    totals[2] += record[5];
    totals[3] += record[6];
    totals[4] += record[7];

    if (record[1] >= recentSince) {
      const minute = Math.floor(record[1] / MINUTE_MS);
      const family = (minutes[record[8]] ??= {});
      family[minute] = (family[minute] ?? 0) + record[4] + record[5];
    }
  }

  return { days, minutes };
}

function aggregate(
  projects: Map<string, Pick<ProjectSummary, "days" | "minutes">>,
  now: Date,
): TokenStats {
  const stats: TokenStats = { ...ZERO_BUCKET, projects: {}, recent: {}, recentByFamily: {} };
  const firstRecentMinute = Math.floor((now.getTime() - RECENT_MS) / MINUTE_MS);
  const bounds: Bounds = {
    day: startOfLocalDay(now).getTime(),
    week: startOfLocalWeek(now).getTime(),
    month: startOfLocalMonth(now).getTime(),
  };

  for (const [projectName, { days, minutes }] of projects) {
    const projectStats: StatsBucket = { ...ZERO_BUCKET };
    for (const [key, totals] of Object.entries(days)) {
      const start = dayStart(key);
      addTotals(stats, totals, start, bounds);
      addTotals(projectStats, totals, start, bounds);
    }

    // A summary made earlier covers more than RECENT_MS back; trim to now.
    for (const [family, perMinute] of Object.entries(minutes ?? {})) {
      for (const [minute, cost] of Object.entries(perMinute)) {
        if (Number(minute) >= firstRecentMinute) {
          stats.recent[minute] = (stats.recent[minute] ?? 0) + cost;
          const byFamily = (stats.recentByFamily[family] ??= {});
          byFamily[minute] = (byFamily[minute] ?? 0) + cost;
        }
      }
    }

    if (
      projectStats.all_tok > 0 ||
      projectStats.all_cost > 0 ||
      projectStats.all_ccost > 0
    ) {
      stats.projects[projectName] = projectStats;
    }
  }

  return stats;
}

export async function scanTokenStats(
  projectsDir: string,
  now: Date = new Date(),
): Promise<TokenStats> {
  const projects = new Map<string, Pick<ProjectSummary, "days" | "minutes">>();

  for (const projectName of listProjects(projectsDir)) {
    const fileRecords: MessageRecord[][] = [];
    for (const filePath of listJsonlFiles(path.join(projectsDir, projectName))) {
      const records = new Map<string, MessageRecord>();
      let size = 0;
      try {
        size = statSync(filePath).size;
      } catch {
        continue;
      }
      readRange(filePath, 0, size, records);
      fileRecords.push([...records.values()]);
    }
    projects.set(projectName, summarize(fileRecords, now.getTime() - RECENT_MS));
  }

  return aggregate(projects, now);
}

type StatEntry = { key: string; filePath: string; ino: number; size: number; mtimeMs: number };

function updateFiles(
  stats: StatEntry[],
  previousFiles: Record<string, FileEntry>,
): Record<string, FileEntry> {
  const files: Record<string, FileEntry> = {};

  for (const stat of stats) {
    const previous = previousFiles[stat.key];
    if (
      previous &&
      previous.ino === stat.ino &&
      previous.size === stat.size &&
      previous.mtimeMs === stat.mtimeMs
    ) {
      files[stat.key] = previous;
      continue;
    }

    // Transcripts only grow; anything else (shrunk, replaced) is read again.
    const appended = previous && previous.ino === stat.ino && stat.size > previous.size;
    const records = new Map<string, MessageRecord>(
      appended ? previous.records.map((record) => [record[0], record]) : [],
    );
    const offset = readRange(stat.filePath, appended ? previous.offset : 0, stat.size, records);
    files[stat.key] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      offset,
      records: [...records.values()],
    };
  }

  return files;
}

// Days are bucketed in local time, so the cache is tied to the time zone.
// Winter and summer offsets identify it without Intl, which costs ~13 ms to load.
function timeZoneKey(now: Date): string {
  const year = now.getFullYear();
  return [
    process.env.TZ ?? "",
    new Date(year, 0, 1).getTimezoneOffset(),
    new Date(year, 6, 1).getTimezoneOffset(),
  ].join("|");
}

// Same result as scanTokenStats. Unchanged projects come straight from the
// index; for a changed project only the bytes appended to its transcripts
// since the last render are read.
export function scanTokenStatsCached(
  projectsDir: string,
  cacheDirectory: string,
  now: Date = new Date(),
): TokenStats {
  const pricing = pricingFingerprint();
  const timeZone = timeZoneKey(now);
  const indexPath = path.join(cacheDirectory, "index.json");
  const cached = readJsonCache<UsageIndex>(indexPath);
  const previous =
    cached?.version === INDEX_VERSION &&
    cached.pricing === pricing &&
    cached.root === projectsDir &&
    cached.timeZone === timeZone &&
    cached.projects
      ? cached.projects
      : {};
  const index: UsageIndex = { version: INDEX_VERSION, pricing, root: projectsDir, timeZone, projects: {} };
  const projects = new Map<string, Pick<ProjectSummary, "days" | "minutes">>();
  let changed = previous !== cached?.projects;

  for (const projectName of listProjects(projectsDir)) {
    const stats: StatEntry[] = [];
    for (const filePath of listJsonlFiles(path.join(projectsDir, projectName))) {
      try {
        const stat = statSync(filePath);
        stats.push({
          key: path.relative(projectsDir, filePath),
          filePath,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }

    const signature = shortHash(
      stats.map((stat) => `${stat.key}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`).join("\n"),
    );
    const summary = previous[projectName];
    if (summary?.signature === signature) {
      index.projects[projectName] = summary;
      projects.set(projectName, summary);
      continue;
    }

    changed = true;
    const projectPath = path.join(cacheDirectory, `project-${shortHash(projectName)}.json`);
    const projectCache = readJsonCache<ProjectCache>(projectPath);
    const previousFiles =
      projectCache?.version === PROJECT_CACHE_VERSION &&
      projectCache.pricing === pricing &&
      projectCache.project === projectName &&
      projectCache.files
        ? projectCache.files
        : {};
    const files = updateFiles(stats, previousFiles);
    // The summary is reused until these files change, so later renders trim
    // its minutes to their own RECENT_MS (see aggregate).
    const summarized = summarize(
      Object.values(files).map((file) => file.records),
      now.getTime() - RECENT_MS,
    );

    writeJsonCache(projectPath, {
      version: PROJECT_CACHE_VERSION,
      pricing,
      project: projectName,
      files,
    } satisfies ProjectCache);
    index.projects[projectName] = { signature, ...summarized };
    projects.set(projectName, summarized);
  }

  for (const projectName of Object.keys(previous)) {
    if (!(projectName in index.projects)) {
      changed = true;
      rmSync(path.join(cacheDirectory, `project-${shortHash(projectName)}.json`), { force: true });
    }
  }

  if (changed) {
    writeJsonCache(indexPath, index);
  }

  return aggregate(projects, now);
}
