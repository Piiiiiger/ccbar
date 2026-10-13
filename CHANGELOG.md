# Changelog

## 1.8.0 - 2026-10-13

- The session's effort level follows the model name (`Opus 5.5 · medium effort`; just the level in the compact layout), from the `effort.level` Claude Code passes to the status line for models that support effort. "thinking off" is added when the session runs without thinking.

## 1.7.0 - 2026-10-13

- The spending row is gone: each limit bar is now followed by the spending in its window (`5-hour ━━─── 21%  $43.3  resets in 2h 58m`, likewise Weekly), and the month and all-time totals sit after the Context bar. All bar rows share the same columns.
- Model-only weekly limits (Fable) get their own bar row with their own spending, shown once the model has been used in the current window: the server reports usage, or this machine's transcripts have spending on it since the window opened. It replaces the `· Fable N%` note on the Weekly row.
- Spending is now also kept per model family for the last 8 days (cache format change: the first render after updating reads the transcripts once).
- Very narrow terminals: the month and all-time totals move to their own line under Context.

## 1.6.0 - 2026-10-13

- Pricing for the current models at Anthropic's list prices: Claude Opus 5.5 ($4/$20, cache writes $5/$8, cache reads $0.20), Opus 5, Fable 5.1 (cache reads $0.25) and Mythos 5.1, Sonnet 5.5, Haiku 5.5 (with its higher rate for prompts over 100K tokens), and fast mode on Opus 5/5.5 (2x). Claude Sonnet 5 was priced at $3/$15 and is now $2/$10. Opus 5.5 had been priced at the fallback rate; because cache reads dominate Claude Code usage, the corrected totals are lower (about 15% on the author's history). Cached totals are recomputed automatically.
- Model ids resolve to the longest matching table entry and ignore context suffixes such as `[1m]`, so a dated Opus 5.5 id can no longer fall back to Opus 5's price.
- The 5-hour and weekly bars match `/usage`: a usage-endpoint reading less than 2 minutes old is shown as is. Claude Code also passes its own reading (`rate_limits`, from its latest API response) to the status line; ccbar now uses it when the endpoint reading is older or failing, or when a window has just reset. The two are the same meter rounded differently and can differ by one point (31.6% is 32 at the endpoint, 0.31 in the response headers).
- No stale limits: a window whose reset time has passed shows "reset, updating" instead of its old percentage, a reading older than 3 minutes says how old it is, and the 5-hour and week spending count from the reset once a window has rolled over.
- `ccbar doctor` lists both limit sources with the age of each reading.

## 1.5.0 - 2026-10-13

- New spending row below the limits: `Spent 5h · week · month · all time`. `5h` counts from when the current 5-hour limit window opened and `week` from the last weekly reset, so each matches its bar; without limit data they fall back to the last 5 hours and the calendar week. Window totals match exact per-message sums (spend is kept per minute for the last 8 days, and window starts are rounded to the minute they open on).
- Lines added and removed this session are back, as `Lines +2963 −9` in the right column (the `lines` item).
- Narrow terminals: below the compact width only the limits and spending remain, and the spending row wraps onto two lines instead of running past the edge.
- A row with fewer cells than the others now runs its last cell across the remaining columns.
- Today's spend moved out of the default layout; it is still available as the `today` item.

## 1.4.0 - 2026-10-13

- Simpler layout: three labeled rows. Context, 5-hour and Weekly bars on the left with "resets in …"; model, project and branch, then Session and Today spend on the right. Token counts, cache hit rates, $/h, projections and lines changed are gone from the default; `week`, `month` and `total` remain available as layout items.
- The activity line now shows only what is running (tools, subagents, background workflows, the todo in progress) and disappears when idle. Background agents stay listed until their task notification arrives; a new prompt clears tools left without a result.
- Usage colours run blue → amber → orange-red instead of green → red, so they stay distinguishable with red-green colour blindness.
- A model-only weekly limit (e.g. Fable) is shown only once it is in use or while that model is active.
- Renders are about 45x faster (2.7 s → ~60 ms on 714 MB of transcripts): per-project caches in `~/.cache/ccbar/` with daily totals, and only bytes appended since the last render are read. Results match a full scan exactly.
- The usage limits are refreshed by a detached background process at most once a minute; renders never wait on the network once a value is cached. Failed fetches back off exponentially (up to 10 minutes) and keep showing the last good value for up to 10 minutes. Previously a rate-limited fetch retried 5 times immediately on every render, which kept the endpoint rate-limited.
- `claude auth status` is no longer run on every render, and the terminal width is read without starting a login shell.
- `compactBreakpoint` now forces the compact layout at or below that width; by default ccbar uses whichever layout fits.

## 1.3.0 - 2026-10-13

- Merged claude-hud's session view into ccbar: one three-row grid with the context, 5h and 7d bars stacked in the left column, spending in the middle, and model, project and git branch (dirty, ahead/behind) on the right. All labels share one style and width; the project's share follows an orange `›` in every cell.
- Added an activity line for the current session: running tools with their target, per-tool counts with failures, running and just-finished subagents, and the in-progress todo. It is hidden when idle and can be turned off with `"activity": false`.
- New layout items `ctx`, `id`, `week` and `month`; `history` still renders week and month together. The compact layout now aligns columns like the wide one.
- Quota bars now work on Linux: the OAuth token is read from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) before falling back to the macOS Keychain.

## 1.2.1 - 2026-07-17

- Restyled the scoped weekly overlay from half-block glyphs to line glyphs: `━` where both the overall and scoped 7d limits reach, `─` (colored) where only one does, matching the 5h bar aesthetic.

## 1.2.0 - 2026-07-17

- Fixed the pricing table for current Claude models: added `claude-fable-5` ($10/$50), `claude-opus-4-8`/`4-7` ($5/$25), and `claude-sonnet-5`; corrected `claude-opus-4-6`/`4-5` from legacy $15/$75 to $5/$25 and `claude-haiku-4-5` from $0.8/$4 to $1/$5. Cost stats previously underestimated Fable 5 usage ~3.3x and Opus 4.8 usage ~40%.
- Added model-scoped weekly quota (e.g. the Fable 7d limit) as an overlay inside the existing 7d cell: a half-block dual bar (`▀` overall / `▄` scoped / `█` both) plus a `41%·F66%` readout, sourced from the usage API `limits[]` `weekly_scoped` entries. No extra row or cell is used.

## 1.1.2 - 2026-03-24

- Fixed compact quota statusline rendering so narrow Claude Code layouts stay on two lines instead of collapsing back into one long row.
- Shortened compact quota bars, compact countdown text, and narrow-path rendering to keep project and quota data visible on constrained widths.
- Added a regression test that enforces the compact quota rows stay within narrow UI width limits.

## 1.1.1 - 2026-03-24

- Fixed live quota rendering so `ccbar` now resolves Claude auth mode, reads the Claude Code OAuth token, fetches `/api/oauth/usage`, and passes real 5h/7d quota data into the statusline.
- Added auth-aware quota tests covering `claude.ai` detection, API-mode suppression, and live quota cache refresh.

## 1.1.0 - 2026-03-24

- Added a responsive statusline layout that automatically switches to a compact two-row view on narrow widths.
- Added safer width detection with runtime probing and a narrow-screen fallback when Claude does not expose terminal width.
- Fixed plugin launcher, setup docs, and hook repair commands to resolve `ccbar` installs across marketplace cache paths instead of relying on one hardcoded cache layout.

## 1.0.0 - 2026-03-20

- Rebased `ccbar` around the native Claude Code plugin system.
- Made plugin marketplace distribution the primary release path.
- Kept local-development installation available through the repository marketplace manifest.
