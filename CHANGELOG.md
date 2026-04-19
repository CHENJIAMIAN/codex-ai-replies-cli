# Changelog

## 0.3.0-rc

Release candidate state for the next `0.3.0` release. This worktree updates the repo-facing surface only and does not publish the package.

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
