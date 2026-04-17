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

function createCodeShim(tempDir) {
  const shimDir = path.join(tempDir, "bin");
  const markerPath = path.join(tempDir, "code-invoked.txt");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    path.join(shimDir, "code.cmd"),
    `@echo off\r\necho %* > "${markerPath}"\r\n`,
    "utf8"
  );
  return { shimDir, markerPath };
}

function runCli(args, options = {}) {
  const tempDir = options.tempDir ?? makeTempDir();
  const { shimDir, markerPath } = createCodeShim(tempDir);
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      PATH: `${shimDir};${options.env?.PATH ?? process.env.PATH ?? ""}`
    }
  });
  return { result, markerPath, tempDir };
}

function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function waitForFile(filePath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return fs.existsSync(filePath);
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

  const { result } = runCli([
    "--sessions-root",
    sessionsRoot,
    "--save",
    "--output",
    outputPath
  ], { tempDir });

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

test("save also opens output in VS Code when code is available", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const outputPath = path.join(tempDir, "messages.txt");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "open me" } })
  ]);

  const { result, markerPath } = runCli([
    "--sessions-root",
    sessionsRoot,
    "--save",
    "--output",
    outputPath
  ], { tempDir });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(waitForFile(markerPath), true, "expected code shim to be invoked");
});

test("includes tool and MCP events when requested in timeline output", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T12-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T12:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "AI before tool" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:02Z", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:03Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:04Z", type: "event_msg", payload: { type: "mcp_tool_call_begin", server: "deepwiki", tool: "ask_question", arguments: "{\"q\":\"types\"}" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:05Z", type: "event_msg", payload: { type: "mcp_tool_call_end", server: "deepwiki", tool: "ask_question", duration_ms: 123, success: true } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:06Z", type: "event_msg", payload: { type: "agent_message", message: "AI after tool" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-tools",
    "--include-mcp",
    "--timeline"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /AI before tool/);
  assert.match(result.stdout, /\[tool_call\] read_file/);
  assert.match(result.stdout, /\[tool_output\] call_1/);
  assert.match(result.stdout, /\[mcp_tool_call_begin\] deepwiki ask_question/);
  assert.match(result.stdout, /\[mcp_tool_call_end\] deepwiki ask_question/);
  assert.match(result.stdout, /arguments:\n\{\n  "q": "types"\n\}/);
  assert.match(result.stdout, /AI after tool/);
});

test("selects a specific session by id when --id is provided", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-aaa111.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-17T10:00:00Z",
      type: "session_meta",
      payload: { session_source: "cli", id: "aaa111" }
    }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "session aaa111" } })
  ]);

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-bbb222.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-17T11:00:00Z",
      type: "session_meta",
      payload: { session_source: "cli", id: "bbb222" }
    }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "session bbb222" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--id",
    "aaa111"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /session aaa111/);
  assert.doesNotMatch(result.stdout, /session bbb222/);
});

test("renders compact arguments when --compact-arguments is provided", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T12-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T12:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-17T12:00:04Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "deepwiki", tool: "ask_question", arguments: "{\"q\":\"types\"}" }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-mcp",
    "--timeline",
    "--compact-arguments"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /arguments: \{"q":"types"\}/);
  assert.doesNotMatch(result.stdout, /arguments:\n\{/);
});
