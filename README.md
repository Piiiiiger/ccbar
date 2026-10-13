<div align="center">

<br>

<img src="assets/logo.svg" alt="ccbar" width="400">

<br>
<br>

**Vibe coding is no longer just for fun. Know what it costs.**

Real-time cost tracking and quota monitoring for Claude Code. Zero dependencies.

[![PyPI](https://img.shields.io/pypi/v/ccbar?style=flat-square&color=blue)](https://pypi.org/project/ccbar/)
[![Downloads](https://img.shields.io/pypi/dm/ccbar?style=flat-square&color=green)](https://pypi.org/project/ccbar/)
[![Python](https://img.shields.io/pypi/pyversions/ccbar?style=flat-square)](https://pypi.org/project/ccbar/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)

[![English](https://img.shields.io/badge/lang-English-blue?style=flat-square)](#)
[![中文](https://img.shields.io/badge/lang-中文-grey?style=flat-square)](./README_CN.md)

</div>

<br>

<div align="center">
<img src="assets/demo.svg" alt="ccbar demo" width="920">
</div>

<br>

## Why ccbar

You're burning through API credits or a $200/month Max subscription — but Claude Code doesn't tell you how fast, which project, or what it'll cost by end of day. ccbar fills that gap.

It works with **both billing models**: whether you're on the API (pay-per-token) or a Pro/Max subscription (quota-based), ccbar tracks your spend in real time. No guessing, no surprises at the end of the month.

## Install

Public GitHub marketplace:

```bash
/plugin marketplace add https://github.com/Narcooo/ccbar
/plugin install ccbar@narcooo
/ccbar:setup
```

This is the current public install path.

Local development marketplace:

For local development or pre-listing installs, add the dedicated development marketplace manifest from a filesystem path. Use `.claude-plugin/dev-marketplace/marketplace.json` so local work does not clobber the public `narcooo` marketplace identity.

```bash
/plugin marketplace add /absolute/path/to/ccbar/.claude-plugin/dev-marketplace/marketplace.json
/plugin install ccbar@ccbar-dev
/ccbar:setup
```

`ccbar` installs as a native Claude Code plugin. `setup` wires the plugin into `statusLine.command`, and the bundled `SessionStart` hook repairs the wiring if it drifts later.

For local debugging only, there is also a thin Python wrapper around the built Node CLI. This is not the primary install path and still requires the local Node build output.

```bash
npm run build
python -m ccbar doctor
```

## What you get

```
Context ━━━─────── 34%  month $3.1k · all time $3.5k   Opus 5.5 · medium effort · ccbar ⎇ main*
5-hour  ━━──────── 21%  $43.3  resets in 2h 58m        Session $1.23 · 15 min
Weekly  ━━━─────── 32%  $384   resets in 5d 4h         Lines +2963 −9
Fable   ━━━━────── 41%  $12.0  resets in 5d 4h
◐ Bash  npm test    ◐ Explore agent  find callers · 2 min    ▸ Render activity (1 of 2 done)
```

Each limit is followed by what was spent in its window: the 5-hour row shows the spending since the current 5-hour window opened, the Weekly row since the weekly limit last reset. The Context row carries the spending with no window of its own, this month and all time. The right column says where you are (model and its effort level, project, git branch), what this session has cost and how long it has run, and how many lines it has added and removed. "thinking off" follows the effort level when the session runs without thinking.

A model-only weekly limit (Fable's) gets its own bar, with its own spending, once that model has been used in the current window; until then the row is not shown. The activity line appears only while something is running: a tool, a subagent or background workflow, and the todo in progress.

Terminal too narrow? ccbar shortens the bars and labels first, then drops the right column, and on very narrow terminals moves the month and all-time totals onto their own line. Cells are never cut off; only the activity line is trimmed to the terminal width.

## Lightweight by design

ccbar is now a native Claude Code plugin built on Node.js/TypeScript. There is no PyPI bootstrap layer, no extra daemon requirement for correctness, and no separate `ccbar --install` step. It reads the JSONL logs Claude Code already writes and renders directly through Claude's plugin-driven statusline flow.

| | ccbar | typical alternatives |
|---|---|---|
| Runtime path | **Native Claude plugin** | external script + manual wiring |
| Setup | **`/plugin install` + `/ccbar:setup`** | package install + shell glue |
| Background process | **None required** | Persistent daemon |
| Config | plugin config JSON + slash commands | YAML + env + dashboard setup |

## Accurate to the cent

Most tools estimate costs with a flat rate. That's wrong — Opus output is **19x** more expensive than Haiku. ccbar gets it right:

- **Per-model pricing** — reads the model ID from every message. Opus, Sonnet, Haiku each priced correctly.
- **Streaming dedup** — each API call writes 2–7 JSONL entries. ccbar deduplicates by `message.id`. Every message counted exactly once.
- **Cache separation** — cache writes and reads are priced at each model's own rates (Opus 5.5 reads cost 5% of fresh input, Fable 5.1 2.5%, most others 10%), along with Haiku 5.5's long-prompt rate and fast mode.
- **Cross-session history** — session cost resets when you restart. Your bill doesn't. ccbar scans all JSONL — today, this week, this month, per project.

## What each number means

| Row | What it tells you |
|-----|-------------------|
| **Context** | How full the context window is, then spending this calendar month and all time. |
| **5-hour** | How much of the 5-hour limit is used, the spending since that window opened, and when it resets. |
| **Weekly** | The same for the weekly limit: usage, spending since it last reset (so it matches the bar), reset time. |
| **Fable** | Fable's own weekly limit and Fable spending in it, shown once Fable has been used in the window: the server reports usage, or this machine's transcripts have Fable spending since the window opened. |
| **Session** | What this session has cost so far, and how long it has run. |
| **Lines** | Lines of code this session has added and removed. |

Without limit data (API keys), the 5-hour spending covers the last 5 hours and the weekly spending the calendar week from Monday. Today's spend, with this project's share, is available as the `today` item (see Configure).

## API & Subscription — both covered

**API users** — ccbar calculates exact costs from per-model token pricing. You see dollars spent per session, per project, per day.

**Pro / Max subscribers** — the 5-hour and weekly bars show what `/usage` and claude.ai show: Anthropic's usage endpoint, refreshed at most once a minute. When that reading is more than 2 minutes old (say the endpoint is failing), ccbar uses the reading Claude Code passes to the status line after each response instead; the two are the same meter rounded differently and can differ by one point. A window whose reset has passed shows "reset, updating" rather than an old percentage, and a reading more than 3 minutes old says how old it is. `ccbar doctor` prints both sources with their age.

**About the dollar figures** — they are estimates at Anthropic's API list prices for the usage recorded on this machine. On a subscription they show what that usage would cost through the API, not what you pay, and they do not include usage from other devices.

Either way, you get a single statusline that tells the full story.

## Configure

```bash
/ccbar:configure
/ccbar:doctor
```

<details>
<summary>Config reference</summary>

```json
{
  "rows": [["ctx", "id"], ["5h", "session"], ["7d", "lines"], ["scoped"]],
  "activity": true,
  "columns": null
}
```

| Field | Description |
|-------|-------------|
| `rows` | Layout override — items: `ctx` `5h` `7d` `scoped` `id` `session` `lines` `spend` `today` `week` `month` `total` `history`. `scoped` (the model-only weekly bars) and `spend` (all spending periods in one row) belong on a row of their own. A row with fewer cells than the others runs its last cell across the remaining columns. |
| `compactRows` | Layout for narrow terminals. Defaults to `rows`, drawn compactly. |
| `compactBreakpoint` | Always use the compact layout at or below this width. By default ccbar picks whichever fits. |
| `columns` | Override detected width (`null` = auto-detect, with a safe fallback when no width signal is available) |
| `activity` | `false` hides the line of running tools, subagents and todos. |

</details>

The plugin stores config under `~/.claude/plugins/ccbar/config.json`.

## How it works

```
stdin JSON → plugin runtime → read new lines of ~/.claude/projects/**/*.jsonl
           → dedup by message.id → per-model pricing
           → adaptive layout → stdout
```

Each transcript is read once. ccbar keeps per-project totals in `~/.cache/ccbar/` and, on later renders, reads only the bytes appended since the last one, so a render takes tens of milliseconds however much history there is. The usage limits are refreshed by a short background process at most once a minute, and renders show the last known values meanwhile.

Plugin commands:
- `/ccbar:setup` wires `statusLine.command`
- `/ccbar:configure` edits plugin config
- `/ccbar:doctor` checks plugin cache and statusline wiring

## Uninstall

```bash
/plugin remove ccbar
```

---

<div align="center">

MIT

</div>
