# codex-ai-replies-cli

Read local Codex session rollouts as a usable CLI transcript.

`codex-ai-replies-cli` scans `~/.codex/sessions`, picks the most recently updated main-agent rollout by default, and turns JSONL session history into readable output. It helps when you want to review what the assistant said, inspect tool-call sequences, or isolate MCP activity without digging through raw rollout files by hand.

## Release Status

Current package version: `0.7.0`

- Timeline filtering, rollout selection hardening, and release checks are included
- `npm test`, `npm run test:release`, and `npm run release:final` are the intended release gates
- The CLI is ready for normal npm installation and repository-based validation

## Why Use It

- Review assistant replies from a recent Codex run
- Inspect concrete tool calls alongside assistant messages
- Isolate MCP activity for debugging or audit work
- Save a readable transcript to a text file and open it immediately
- Target a specific session by id or read a rollout file directly
- 先列出最近的主会话，再按会话 ID 读取所需内容

## Install

Install from npm:

```bash
npm install -g codex-ai-replies-cli
```

After install, the recommended short command is:

```bash
cxr
```

If you prefer to validate from a clone before or after publishing, run the entrypoint directly:

```bash
node bin/codex-ai-replies.js --help
```

## Quick Start

Show assistant replies from the latest main-agent session:

```bash
cxr
```

Keep following the same rollout as new items arrive:

```bash
cxr --watch
```

Start by showing the latest 20 items, then continue streaming new ones:

```bash
cxr --watch --count 20
```

跟随按更新时间排名第二、第三或任意第 N 个主会话：

```bash
cxr --watch2
cxr --watch3
cxr --watch 4
cxr -w4
```

Read a specific session by id:

```bash
cxr --id 019d9bb5-d432-7453-a92c-b3376ef23b58
```

列出最近更新的 20 个主会话，再用其中的 ID 读取内容：

```bash
cxr --list-sessions
cxr --id 019d9bb5-d432-7453-a92c-b3376ef23b58
```

限制为最近 10 个会话并输出 JSON：

```bash
cxr --list-sessions --count 10 --json
```

Show a mixed timeline with assistant, tool, and MCP events:

```bash
cxr --include-tools --include-mcp
```

Read RequestUserInput prompts:

```bash
cxr --only user-input
```

Export every raw rollout entry:

```bash
cxr --id 019d9bb5-d432-7453-a92c-b3376ef23b58 --only all --save
```

Read only MCP activity:

```bash
cxr --include-mcp
```

Read only `chrome-devtools evaluate_script` MCP activity:

```bash
cxr --only mcp --mcp-server chrome-devtools --mcp-tool evaluate_script
```

Save the latest extracted items and open the output file:

```bash
cxr --count 20 --save --output ./messages.txt
```

## What The CLI Actually Reads

- Defaults to `~/.codex/sessions`
- Chooses the most recently updated root/main-agent rollout when no selector is given
- Excludes subagent rollouts from the default lookup
- `--list-sessions` 按 rollout 文件更新时间列出最近的主会话，默认 20 个
- Accepts `--id` to select a specific session
- Accepts `--raw-file` to read one rollout JSONL file directly

When `--id` could match more than one rollout, the CLI prefers exact rollout identity matches and main-agent/root rollouts over subagent matches.

## Output Modes

By default, `cxr` prints assistant replies only. Timeline-related flags switch it into event selection mode:

- `--include-tools` selects tool call events
- `--include-mcp` selects MCP events
- `--include-user-input` selects RequestUserInput-style events
- `--include-tools --include-mcp` returns the full mixed timeline with assistant, tool, and MCP events together
- `--only assistant|tools|mcp|user-input` forces a single category
- `--all-events` renders every raw rollout event without the default 100-item cap
- `--mcp-server <name>` filters selected MCP events by server name
- `--mcp-tool <name>` filters selected MCP events by tool name
- `--timeline` keeps selected events in timestamp order, and becomes optional once include flags are present

Formatted output uses a readable block layout:

```txt
==========
[1] 2026-04-17 21:57:47.361

[mcp_tool_call_end] chrome-devtools take_snapshot

arguments:
{
  "verbose": false
}
```

Text-mode timestamps are shown in the runtime's local timezone for easier reading. Use `--json` if you need the original raw rollout timestamps unchanged.

In default text mode, multiline MCP string arguments are rendered as readable text blocks instead of escaped JSON string literals. Use `--compact-arguments` if you want the old one-line JSON style.

Use `--json` if you want machine-friendly output instead.

`--watch` keeps the default initial extraction rules, then streams newly appended items from the same rollout file. It does not switch to a different newer session while running. Use `--all-events` with `--watch` when you need every raw event. `--watch2`, `--watch3`, and other `--watchN` forms choose the Nth most recently updated main-agent rollout; subagent rollouts remain excluded.

## Examples

Read only tool calls:

```bash
cxr --only tools --json
```

Watch every raw event from one session:

```bash
cxr --id <sessionId> --watch --all-events
```

Render MCP arguments as compact one-line JSON:

```bash
cxr --include-mcp --compact-arguments
```

Read a rollout file directly:

```bash
cxr --raw-file ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
```

Use a custom sessions root:

```bash
cxr --sessions-root ./fixtures/sessions --include-tools
```

## Command Reference

- `--list-sessions`: 列出最近更新的主会话；文本输出重点展示首条与末条用户请求、工作目录、会话 ID 和 rollout 路径，默认 20 个
- `--count <n>`: limit to the latest `n` extracted items after category filtering, default `100`; with `--list-sessions`, limit the session list
- `--watch [n]`: keep streaming the nth most recently updated main-agent rollout after printing the initial selection; omit `n` for the latest rollout
- `--watchN`: compact rank form such as `--watch2` or `--watch3`
- `--save`: write the extracted output to a text file and open it automatically
- `--open`: legacy alias for saving and opening the output file
- `--output <path>`: explicit output path
- `--raw-file <path>`: read a specific rollout file instead of auto-discovering
- `--id <sessionId>`: read a specific session id instead of the latest main-agent session
- `--json`: print JSON instead of the formatted text view
- `--include-tools`: select function/tool call events
- `--include-mcp`: select MCP events
- `--include-user-input`: select RequestUserInput-style events
- `--timeline`: render selected events in timestamp order
- `--only <kind>`: select exactly one category: `assistant`, `tools`, `mcp`, or `user-input`
- `--all-events`: render every raw rollout event without the default 100-item cap; incompatible with `--only` and include selectors
- `--mcp-server <name>`: filter selected MCP events by server name
- `--mcp-tool <name>`: filter selected MCP events by tool name
- `--compact-arguments`: render MCP arguments as one-line JSON instead of formatted blocks
- `--sessions-root <path>`: override the default sessions root
- `--help`: show help
- `--version`: show package version

## 短参数

短参数与长参数等价，可以和原有长参数混用。带值的短参数需要把值作为下一个参数传入，例如 `cxr -l -n 10 -j`。

| 长参数 | 短参数 |
| --- | --- |
| `--list-sessions` | `-l` |
| `--count <n>` | `-n <n>` |
| `--watch [n]` | `-w [n]` |
| `--save` | `-s` |
| `--open` | `-O` |
| `--output <path>` | `-o <path>` |
| `--raw-file <path>` | `-f <path>` |
| `--id <sessionId>` | `-i <sessionId>` |
| `--json` | `-j` |
| `--include-tools` | `-T` |
| `--include-mcp` | `-M` |
| `--include-user-input` | `-U` |
| `--timeline` | `-t` |
| `--only <kind>` | `-y <kind>` |
| `--all-events` | `-A` |
| `--mcp-server <name>` | `-S <name>` |
| `--mcp-tool <name>` | `-K <name>` |
| `--compact-arguments` | `-c` |
| `--sessions-root <path>` | `-r <path>` |
| `--help` | `-h` |
| `--version` | `-v` |

也可以把排名直接附在短参数后，例如 `-w2`、`-w3`。

## Reliability Notes

- Malformed rollout JSONL is treated as an error, with exact file and line reporting
- Assistant extraction prefers `event_msg.agent_message` and falls back to assistant `response_item` text when needed
- `--count` is applied after category filtering, so targeted extracts stay accurate
- 最近会话列表按文件更新时间排序，忽略子代理 rollout；首条与末条用户请求均压缩为最多 160 个字符的单行预览，工作目录优先采用最后一个 turn context

## Release Checks

Use the repo checks that back this release candidate surface:

```bash
npm test
npm run test:release
npm run release:final
```

`npm run release:final` verifies the worktree is clean, reruns the test gates, and prints the exact next `push/tag/publish` commands without executing them.

## Typical Use Cases

- Audit what Codex actually replied in a prior session
- Inspect MCP interactions without opening raw JSONL files
- Review tool-call sequences around a bug or regression
- Save a readable transcript for sharing or archiving
