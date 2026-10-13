<div align="center">

<br>

<img src="assets/logo.svg" alt="ccbar" width="400">

<br>
<br>

**Vibe coding 不再只是玩玩而已。你得知道花了多少。**

Claude Code 实时成本追踪与配额监控，零依赖。

[![PyPI](https://img.shields.io/pypi/v/ccbar?style=flat-square&color=blue)](https://pypi.org/project/ccbar/)
[![Downloads](https://img.shields.io/pypi/dm/ccbar?style=flat-square&color=green)](https://pypi.org/project/ccbar/)
[![Python](https://img.shields.io/pypi/pyversions/ccbar?style=flat-square)](https://pypi.org/project/ccbar/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)

[![English](https://img.shields.io/badge/lang-English-grey?style=flat-square)](./README.md)
[![中文](https://img.shields.io/badge/lang-中文-blue?style=flat-square)](#)

</div>

<br>

<div align="center">
<img src="assets/demo.svg" alt="ccbar 演示" width="920">
</div>

<br>

## 为什么用 ccbar

你每天在烧 API 额度或者 $200/月的 Max 订阅——但 Claude Code 不告诉你烧了多快、哪个项目烧的、到今天结束会花多少。ccbar 填上这个空缺。

它**同时支持两种计费模式**：无论你是 API 按量付费还是 Pro/Max 订阅按配额使用，ccbar 都能实时追踪你的花费。不用猜，月底不再有惊吓。

## 安装

公开 GitHub marketplace：

```bash
/plugin marketplace add https://github.com/Narcooo/ccbar
/plugin install ccbar@narcooo
/ccbar:setup
```

这是目前公开可用的安装方式。

本地开发 marketplace：

如果你在本地开发，或者市场上架前要先试装，先用独立的开发版 marketplace 清单走文件路径安装。使用 `.claude-plugin/dev-marketplace/marketplace.json` 可以避免本地调试时覆盖公开 `narcooo` marketplace 标识。

```bash
/plugin marketplace add /absolute/path/to/ccbar/.claude-plugin/dev-marketplace/marketplace.json
/plugin install ccbar@ccbar-dev
/ccbar:setup
```

`ccbar` 现在是原生 Claude Code 插件。`setup` 会把插件接到 `statusLine.command`，之后 `SessionStart` hook 会在配置漂移时自动修复。

如果你只是做本地调试，也可以用一个很薄的 Python wrapper 去调用已经构建好的 Node CLI。这个入口不是正式安装方式，前提仍然是先把本地 Node 构建产物生成出来。

```bash
npm run build
python -m ccbar doctor
```

## 你看到什么

```
Context ━━━─────── 34%  month $3.1k · all time $3.5k   Opus 5.5 · medium effort · ccbar ⎇ main*
5-hour  ━━──────── 21%  $43.3  resets in 2h 58m        Session $1.23 · 15 min
Weekly  ━━━─────── 32%  $384   resets in 5d 4h         Lines +2963 −9
Fable   ━━━━────── 41%  $12.0  resets in 5d 4h
◐ Bash  npm test    ◐ Explore agent  find callers · 2 min    ▸ Render activity (1 of 2 done)
```

每个限额后面紧跟着它所在窗口内的花费：5-hour 行是当前 5 小时窗口开始以来的花费，Weekly 行是每周限额上次重置以来的花费。Context 行放没有窗口的花费：本月和累计。右列是你在哪里（模型及其 effort 等级、项目、git 分支）、本会话的花费和时长，以及本会话新增和删除的代码行数。会话关闭 thinking 时，effort 等级后会显示 "thinking off"。

只针对某个模型的周限额（Fable）在当前窗口内用过该模型后，会有自己的进度条和花费；在此之前这一行不显示。活动行只在有东西运行时出现：正在执行的工具、子代理或后台 workflow，以及进行中的 todo。

终端太窄？ccbar 先缩短进度条和标签，再去掉右列；终端非常窄时，本月和累计花费会移到单独一行。单元格内容永不截断，只有活动行会按终端宽度裁剪。

## 极致轻量

ccbar 现在是基于 Node.js/TypeScript 的原生 Claude Code 插件。不再依赖 PyPI 引导层，也不需要单独执行 `ccbar --install`。它直接读取 Claude Code 已有的 JSONL 日志，并通过插件链路输出到底部状态栏。

| | ccbar | 同类工具 |
|---|---|---|
| 运行形态 | **原生 Claude 插件** | 外部脚本 + 手工接线 |
| 安装方式 | **`/plugin install` + `/ccbar:setup`** | 包管理器安装 + shell 胶水 |
| 后台进程 | **非必需** | 持久守护进程 |
| 配置 | 插件 JSON 配置 + slash commands | YAML + env + 后台设置 |

## 精确到分

大多数工具用统一费率估算成本。这是错的——Opus 输出比 Haiku 贵 **19 倍**。ccbar 做对了：

- **按模型定价** — 逐条读取模型 ID。Opus、Sonnet、Haiku 各自正确计价。
- **流式去重** — 每次 API 调用写入 2–7 条 JSONL。ccbar 按 `message.id` 去重，每条消息只算一次。
- **缓存区分** — 缓存写入和读取按各模型自己的价格计算（Opus 5.5 的缓存读取为新输入的 5%，Fable 5.1 为 2.5%，其余多为 10%），并包括 Haiku 5.5 的长提示价格和 fast mode。
- **跨会话累计** — 会话费用重启归零，你的账单不会。ccbar 扫描全部 JSONL——日、周、月、按项目。

## 每个数字的含义

| 行 | 它告诉你什么 |
|----|-------------|
| **Context** | 上下文窗口用了多满，然后是本自然月和累计的花费。 |
| **5-hour** | 5 小时限额用了多少、这个窗口开始以来的花费、何时重置。 |
| **Weekly** | 每周限额的同样信息：用量、上次重置以来的花费（与进度条对应）、重置时间。 |
| **Fable** | Fable 自己的周限额以及其中的 Fable 花费；在窗口内用过 Fable 后显示（服务器报告了用量，或本机 transcript 中有窗口开始以来的 Fable 花费）。 |
| **Session** | 本会话到目前为止的花费和时长。 |
| **Lines** | 本会话新增和删除的代码行数。 |

没有限额数据时（API key），5 小时花费为最近 5 小时，每周花费为从周一开始的自然周。今天的花费（含本项目份额）可通过 `today` 项加回来（见配置）。

## API 和订阅——全都追踪

**API 用户** — ccbar 从逐模型 token 定价精确计算费用。你能看到每会话、每项目、每天的美元花费。

**Pro / Max 订阅用户** — 5 小时和每周进度条显示的就是 `/usage` 和 claude.ai 显示的数字：Anthropic 的用量接口，最多每分钟刷新一次。当这个读数超过 2 分钟（例如接口持续失败）时，ccbar 改用 Claude Code 每次响应后传给状态栏的读数；两者是同一个计量、取整方式不同，可能相差 1 个百分点。已过重置时间的窗口显示 "reset, updating"，而不是旧的百分比；超过 3 分钟的读数会注明是多久以前的。`ccbar doctor` 会列出两个数据源及其时效。

**关于美元数字** — 它们是按 Anthropic API 标价对本机记录的用量所做的估算。订阅用户看到的是这些用量若走 API 需要多少钱，而不是你实际支付的金额，也不包括其他设备上的用量。

不管哪种，一条状态栏讲完整个故事。

## 配置

```bash
/ccbar:configure
/ccbar:doctor
```

<details>
<summary>配置参考</summary>

```json
{
  "rows": [["ctx", "id"], ["5h", "session"], ["7d", "lines"], ["scoped"]],
  "activity": true,
  "columns": null
}
```

| 字段 | 说明 |
|------|------|
| `rows` | 布局覆盖——可用项: `ctx` `5h` `7d` `scoped` `id` `session` `lines` `spend` `today` `week` `month` `total` `history`。`scoped`（只针对某个模型的周限额进度条）和 `spend`（所有花费时段一行）应单独占一行。单元格比其他行少的行，最后一个单元格会横跨剩余的列。 |
| `compactRows` | 窄终端使用的布局。默认与 `rows` 相同，以紧凑方式绘制。 |
| `compactBreakpoint` | 宽度不超过该值时总是使用紧凑布局。默认由 ccbar 选择能放下的布局。 |
| `columns` | 覆盖检测到的宽度（`null` = 自动检测；如果拿不到宽度信号，会回退到安全默认值） |
| `activity` | 设为 `false` 隐藏正在运行的工具、子代理和 todo 这一行。 |

</details>

插件配置保存在 `~/.claude/plugins/ccbar/config.json`。

## 工作原理

```
stdin JSON → 插件运行时 → 读取 ~/.claude/projects/**/*.jsonl 的新增内容
           → 按 message.id 去重 → 按模型定价
           → 自适应布局 → stdout
```

每个 transcript 只完整读取一次。ccbar 把各项目的汇总保存在 `~/.cache/ccbar/`，之后每次渲染只读取上次以来新追加的字节，因此无论历史多长，一次渲染只需几十毫秒。用量限额由一个短暂的后台进程最多每分钟刷新一次，期间渲染显示最近一次的数值。

插件命令：
- `/ccbar:setup` 接管 `statusLine.command`
- `/ccbar:configure` 编辑插件配置
- `/ccbar:doctor` 检查插件缓存与状态栏接线

## 卸载

```bash
/plugin remove ccbar
```

---

<div align="center">

MIT

</div>
