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
codex-ai-replies --json
codex-ai-replies --raw-file ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
```

## Behavior

- Reads the latest main-agent rollout by default
- Excludes subagent rollouts
- Prefers `event_msg.agent_message`
- Falls back to `response_item.message.output_text`
- Prints formatted output to stdout
- Saves to a text file when `--save` or `--open` is used

## Options

- `--count <n>`: limit to the latest `n` messages, default `100`
- `--save`: write the extracted messages to a text file
- `--open`: save and open the output file with the system default app
- `--output <path>`: explicit output path
- `--raw-file <path>`: read a specific rollout file instead of auto-discovering
- `--json`: print JSON instead of the formatted text view
- `--sessions-root <path>`: override the default sessions root, mainly for testing
