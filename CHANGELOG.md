# Changelog

## 0.6.0

Release focused on real-time transcript following for active Codex sessions.

### Added

- `--watch` mode to print the latest filtered items first and then continue streaming newly appended rollout content from the same session
- README quick-start examples for real-time follow workflows

### Fixed

- Watch-mode block numbering now continues from the initial output instead of restarting at `[1]` for each appended chunk

## 0.5.1

Release focused on fixing hour offsets in human-readable timestamp output.

### Fixed

- Text-mode output now renders rollout timestamps in the runtime's local timezone instead of echoing raw UTC strings
- Summer-time and other DST-sensitive environments no longer show one-hour timestamp drift in the readable transcript view

### Changed

- README now documents that text output is localized while `--json` preserves raw rollout timestamps

## 0.5.0

Release focused on default session freshness and broader rollout inspection.

### Added

- `--include-user-input` and `--only user-input` for RequestUserInput-style prompt events
- `--only all` for exporting every raw rollout entry

### Changed

- Default main-agent rollout selection now uses the rollout file update time instead of filename order
- `--only all` returns the full raw rollout by default instead of applying the normal 100-item cap
- README examples and command reference now cover user-input and raw rollout export workflows

## 0.4.0

Release focused on making MCP output easier to inspect when you need one exact server/tool path and when arguments contain multiline script strings.

### Added

- MCP-specific filtering via `--mcp-server <name>` and `--mcp-tool <name>`
- Direct workflow for isolating `chrome-devtools evaluate_script` activity without post-filtering

### Changed

- Default text-mode MCP argument rendering now shows multiline strings as readable text blocks instead of escaped JSON string literals
- README examples and command reference now cover MCP server/tool filtering and readable multiline argument output

## 0.3.0

Final release for the current development cycle after the repo-facing surface, timeline filtering, rollout selection hardening, and release workflow were completed.

### Added

- Timeline category filtering with `--only assistant|tools|mcp`
- Mixed timeline selection via `--include-tools` and `--include-mcp` without requiring `--timeline`
- Release checks for dry-run pack contents plus CLI `--help` / `--version` smoke coverage

### Changed

- README now reflects the current CLI behavior and the `0.3.0` release-candidate positioning
- Package metadata expanded for the broader transcript, rollout, tool, and MCP-focused CLI surface
- Session lookup by `--id` now prefers exact rollout identity and root/main-agent matches before subagent matches

### Fixed

- Rollout JSONL parse failures now report the exact file and line number
- Assistant extraction still falls back to assistant `response_item` text when `event_msg.agent_message` is unavailable
