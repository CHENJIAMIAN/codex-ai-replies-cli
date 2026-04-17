# codex-ai-replies-cli

Extract assistant replies from the latest main-agent Codex rollout under `~/.codex/sessions`.

## Install

```bash
npm install -g codex-ai-replies-cli
```

## Usage

```bash
codex-ai-replies
codex-ai-replies --count 20
codex-ai-replies --save
codex-ai-replies --save --output ./messages.txt
codex-ai-replies --open
codex-ai-replies --id 019d9bb5-d432-7453-a92c-b3376ef23b58
codex-ai-replies --json
codex-ai-replies --include-tools --include-mcp --timeline
codex-ai-replies --include-mcp --timeline --compact-arguments
codex-ai-replies --raw-file ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
```

## Behavior

- Reads the latest main-agent rollout by default
- Excludes subagent rollouts
- Prefers `event_msg.agent_message`
- Falls back to `response_item.message.output_text`
- Can optionally include tool/function and MCP events in timeline mode
- Prints formatted output to stdout
- Saves to a text file and opens it automatically when `--save` or `--open` is used

## Options

- `--count <n>`: limit to the latest `n` messages, default `100`
- `--save`: write the extracted messages to a text file and open it automatically
- `--open`: legacy alias for saving and opening the output file
- `--output <path>`: explicit output path
- `--raw-file <path>`: read a specific rollout file instead of auto-discovering
- `--id <sessionId>`: read a specific session id instead of the latest main-agent session
- `--json`: print JSON instead of the formatted text view
- `--include-tools`: include function/tool call events
- `--include-mcp`: include MCP events
- `--timeline`: mix assistant, tool, and MCP events in timestamp order
- `--compact-arguments`: render MCP arguments as one-line JSON instead of formatted blocks
- `--sessions-root <path>`: override the default sessions root, mainly for testing
