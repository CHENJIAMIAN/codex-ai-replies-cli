import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(repoRoot, "bin", "codex-ai-replies.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-ai-replies-cli-"));
}

function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

test("prints latest main-agent messages with divider and timestamp", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const outputPath = path.join(tempDir, "messages.txt");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "第一条" } }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "第二条\n第二行" } })
  ]);

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-sub.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-17T11:00:00Z",
      type: "session_meta",
      payload: { source: { subagent: { thread_spawn: { parent: "root" } } } }
    }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "SUBAGENT" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--save",
    "--output",
    outputPath
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[1\] 2026-04-17T10:00:01Z/);
  assert.match(result.stdout, /第一条/);
  assert.match(result.stdout, /\[2\] 2026-04-17T10:00:02Z/);
  assert.match(result.stdout, /第二行/);
  assert.doesNotMatch(result.stdout, /SUBAGENT/);

  const written = fs.readFileSync(outputPath, "utf8");
  assert.match(written, /^==========/m);
  assert.match(written, /\[1\] 2026-04-17T10:00:01Z/);
  assert.match(written, /\[2\] 2026-04-17T10:00:02Z/);
  assert.match(written, /第二条\n第二行/);
});

test("prints help text", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /codex-ai-replies/);
  assert.match(result.stdout, /--count <n>/);
  assert.match(result.stdout, /--save/);
  assert.match(result.stdout, /--open/);
});
