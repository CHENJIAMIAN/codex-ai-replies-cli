# codex-ai-replies-cli

Extract assistant replies, tool calls, and MCP activity from local Codex session rollouts.

This CLI reads `~/.codex/sessions`, finds the latest main-agent rollout by default, and turns JSONL session history into a readable timeline. It is useful when you want to inspect what Codex said, what tools it called, and which MCP actions ran during a session.

## Install

```bash
npm install -g codex-ai-replies-cli
```

After install, the recommended short command is:

```bash
cxr
```

## What It Does

- Reads the latest main-agent rollout by default
- Excludes subagent rollouts
- Supports selecting a session explicitly by `--id` or `--raw-file`
- Prefers exact rollout identity matches and main-agent/root rollouts when `--id` could match multiple files
- Extracts assistant replies from `event_msg.agent_message`
- Falls back to `response_item.message.output_text` when needed
- Lets you select assistant, tool, or MCP events directly
- Treats `--include-tools` and `--include-mcp` as category selectors
- Applies `--count` after category filtering, so targeted extracts stay accurate
- Fails fast on malformed rollout JSONL with file and line details instead of silently dropping bad lines
- Formats MCP arguments as readable blocks by default
- Saves output to a text file and opens it automatically when `--save` or `--open` is used

## Quick Examples

Read the latest main-agent session:

```bash
cxr
```

Read a specific session by id:

```bash
cxr --id 019d9bb5-d432-7453-a92c-b3376ef23b58
```

Show a mixed timeline with tool and MCP events:

```bash
cxr --include-tools --include-mcp --timeline
```

Read only MCP activity from a specific session:

```bash
cxr --id 019d9bb5-d432-7453-a92c-b3376ef23b58 --include-mcp
```

Read only tool calls and tool outputs:

```bash
cxr --only tools --json
```

Save output and open it in VS Code:

```bash
cxr --count 20 --save --output ./messages.txt
```

Render MCP arguments as compact one-line JSON:

```bash
cxr --include-mcp --timeline --compact-arguments
```

Read a specific rollout file directly:

```bash
cxr --raw-file ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
```

## Output Shape

Formatted output uses a readable block structure:

```txt
==========
[1] 2026-04-17T13:57:47.361Z

[mcp_tool_call_end] chrome-devtools take_snapshot

arguments:
{
  "verbose": false
}
```

## Options

- `--count <n>`: limit to the latest `n` extracted items after category filtering, default `100`
- `--save`: write the extracted messages to a text file and open it automatically
- `--open`: legacy alias for saving and opening the output file
- `--output <path>`: explicit output path
- `--raw-file <path>`: read a specific rollout file instead of auto-discovering
- `--id <sessionId>`: read a specific session id instead of the latest main-agent session, preferring exact identity matches and root rollouts
- `--json`: print JSON instead of the formatted text view
- `--include-tools`: select function/tool call events; also enables timeline extraction
- `--include-mcp`: select MCP events; also enables timeline extraction
- `--timeline`: render the selected event categories in timestamp order; when category flags are present, it is optional
- `--only <kind>`: select exactly one timeline category: `assistant`, `tools`, or `mcp`
- `--compact-arguments`: render MCP arguments as one-line JSON instead of formatted blocks
- `--sessions-root <path>`: override the default sessions root, mainly for testing
- `--help`: show help
- `--version`: show package version

## Selection Rules

- `cxr` with no timeline-related flags still returns assistant replies only.
- `--include-tools` returns tool events only unless you also add `--include-mcp`.
- `--include-mcp` returns MCP events only unless you also add `--include-tools`.
- `--include-tools --include-mcp` already switches to the full mixed timeline with assistant, tool, and MCP events together.
- Adding `--timeline` to `--include-tools --include-mcp` is allowed and keeps the same mixed result.
- `--only <kind>` forces a single category and cannot be combined with `--include-tools` or `--include-mcp`.

## Reliability Notes

- If a rollout JSONL file contains malformed JSON, `cxr` stops and reports the exact file and line number.
- `--id` no longer matches incidental path substrings; it prefers exact rollout identity fields and exact rollout filenames/paths.

## Typical Use Cases

- Review what the assistant actually replied in a prior session
- Inspect MCP interactions without opening raw JSONL files
- Audit tool-call sequences around a bug or regression
- Save a readable session transcript for sharing or archiving
