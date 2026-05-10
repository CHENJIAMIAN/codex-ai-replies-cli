# Local Time Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `cxr` text output display rollout timestamps in the runtime's local timezone so users stop seeing hour offsets from raw UTC timestamps.

**Architecture:** Keep raw rollout timestamps unchanged in parsed data and JSON output. Convert timestamps only at text-formatting time, and leave invalid or non-ISO timestamps untouched as a safe fallback.

**Tech Stack:** Node.js, built-in `node:test`, plain ESM modules

---

### Task 1: Lock the regression with a failing test

**Files:**
- Modify: `test/core.test.js`

**Step 1: Write the failing test**

Add a CLI test that runs `bin/codex-ai-replies.js` with `TZ=Europe/London` and a rollout entry timestamp of `2026-07-01T12:00:01Z`, then assert the formatted text output contains local summer time `2026-07-01 13:00:01`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "renders rollout timestamps in the local timezone for text output"`

Expected: FAIL because current output still prints `2026-07-01T12:00:01Z`.

### Task 2: Implement local-time formatting in text mode

**Files:**
- Modify: `src/core.js`

**Step 1: Add a small timestamp formatter**

Parse ISO-like timestamps with `new Date(value)`. If parsing succeeds, format using `Intl.DateTimeFormat("sv-SE", ...)` with local timezone defaults to produce `YYYY-MM-DD HH:mm:ss`. If parsing fails, return the original string.

**Step 2: Use the formatter only in `formatMessages`**

Replace the displayed header timestamp string with the formatted local timestamp while keeping the underlying `message.timestamp` data unchanged for JSON output and internal matching.

**Step 3: Run the focused test**

Run: `npm test -- --test-name-pattern "renders rollout timestamps in the local timezone for text output"`

Expected: PASS

### Task 3: Update release-facing docs and version

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Step 1: Document the new text-output behavior**

Update the formatted output section in `README.md` to state that text mode shows local time while `--json` preserves raw timestamps.

**Step 2: Add changelog entry and bump patch version**

Add `0.5.1` release notes describing the local-time display fix and update `package.json` from `0.5.0` to `0.5.1`.

### Task 4: Verify and release

**Files:**
- No new code files

**Step 1: Run verification**

Run:
- `npm test`
- `npm run test:release`
- `npm run release:final`

Expected: all pass.

**Step 2: Commit and publish**

Run:
- `git add docs/plans/2026-05-10-local-time-display-design.md test/core.test.js src/core.js README.md CHANGELOG.md package.json`
- `git commit -m "fix: 修复 cxr 时间显示时区偏差"`
- `git push origin master`
- `git tag v0.5.1`
- `git push origin v0.5.1`
- `npm publish`
