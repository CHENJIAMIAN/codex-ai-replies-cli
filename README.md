# codex-ai-replies-cli

Read local Codex session rollouts as a usable CLI transcript.

`codex-ai-replies-cli` scans `~/.codex/sessions`, picks the latest main-agent rollout by default, and turns JSONL session history into readable output. It helps when you want to review what the assistant said, inspect tool-call sequences, or isolate MCP activity without digging through raw rollout files by hand.

## Release Status

Current package version: `0.4.0`

- Timeline filtering, rollout selection hardening, and release checks are included
- `npm test`, `npm run test:release`, and `npm run release:final` are the intended release gates
- The CLI is ready for normal npm installation and repository-based validation

## Why Use It

- Review assistant replies from a recent Codex run
- Inspect tool calls and tool outputs alongside assistant messages
- Isolate MCP activity for debugging or audit work
- Save a readable transcript to a text file and open it immediately
- Target a specific session by id or read a rollout file directly

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

Read a specific session by id:

```bash
cxr --id 019d9bb5-d432-7453-a92c-b3376ef23b58
```

Show a mixed timeline with assistant, tool, and MCP events:

```bash
cxr --include-tools --include-mcp
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
- Chooses the latest root/main-agent rollout when no selector is given
- Excludes subagent rollouts from the default lookup
- Accepts `--id` to select a specific session
- Accepts `--raw-file` to read one rollout JSONL file directly

When `--id` could match more than one rollout, the CLI prefers exact rollout identity matches and main-agent/root rollouts over subagent matches.

## Output Modes

By default, `cxr` prints assistant replies only. Timeline-related flags switch it into event selection mode:

- `--include-tools` selects tool call and tool output events
- `--include-mcp` selects MCP events
- `--include-tools --include-mcp` returns the full mixed timeline with assistant, tool, and MCP events together
- `--only assistant|tools|mcp` forces a single category
- `--mcp-server <name>` filters selected MCP events by server name
- `--mcp-tool <name>` filters selected MCP events by tool name
- `--timeline` keeps selected events in timestamp order, and becomes optional once include flags are present

Formatted output uses a readable block layout:

```txt
==========
[1] 2026-04-17T13:57:47.361Z

[mcp_tool_call_end] chrome-devtools take_snapshot

arguments:
{
  "verbose": false
}
```

In default text mode, multiline MCP string arguments are rendered as readable text blocks instead of escaped JSON string literals. Use `--compact-arguments` if you want the old one-line JSON style.

Use `--json` if you want machine-friendly output instead.

## Examples

Read only tool calls and tool outputs:

```bash
cxr --only tools --json
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

- `--count <n>`: limit to the latest `n` extracted items after category filtering, default `100`
- `--save`: write the extracted output to a text file and open it automatically
- `--open`: legacy alias for saving and opening the output file
- `--output <path>`: explicit output path
- `--raw-file <path>`: read a specific rollout file instead of auto-discovering
- `--id <sessionId>`: read a specific session id instead of the latest main-agent session
- `--json`: print JSON instead of the formatted text view
- `--include-tools`: select function/tool call events
- `--include-mcp`: select MCP events
- `--timeline`: render selected events in timestamp order
- `--only <kind>`: select exactly one category: `assistant`, `tools`, or `mcp`
- `--mcp-server <name>`: filter selected MCP events by server name
- `--mcp-tool <name>`: filter selected MCP events by tool name
- `--compact-arguments`: render MCP arguments as one-line JSON instead of formatted blocks
- `--sessions-root <path>`: override the default sessions root
- `--help`: show help
- `--version`: show package version

## Reliability Notes

- Malformed rollout JSONL is treated as an error, with exact file and line reporting
- Assistant extraction prefers `event_msg.agent_message` and falls back to assistant `response_item` text when needed
- `--count` is applied after category filtering, so targeted extracts stay accurate

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
