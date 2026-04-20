# Changelog

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
