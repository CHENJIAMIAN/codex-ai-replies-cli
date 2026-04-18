import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(repoRoot, "bin", "codex-ai-replies.js");
const packageJsonPath = path.join(repoRoot, "package.json");

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

test("prefers the main-agent rollout when root and subagent share the requested id", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const sharedId = "019root-shared";

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-root.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-17T10:00:00Z",
      type: "session_meta",
      payload: { session_source: "cli", id: sharedId }
    }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "root session" } })
  ]);

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-subagent.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-17T11:00:00Z",
      type: "session_meta",
      payload: {
        id: sharedId,
        source: { subagent: { thread_spawn: { parent: "root-session" } } }
      }
    }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "subagent session" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--id",
    sharedId
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /root session/);
  assert.doesNotMatch(result.stdout, /subagent session/);
});

test("matches --id against rollout identity fields instead of incidental file path substrings", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-root-target-session.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-17T10:00:00Z",
      type: "session_meta",
      payload: { session_source: "cli", id: "actual-root-id" }
    }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "root by filename only" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--id",
    "target-session"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /No rollout file found for id: target-session/);
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

test("extracts only MCP events without requiring --timeline", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "18", "rollout-2026-04-18T09-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-18T09:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-18T09:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "assistant before" } }),
    JSON.stringify({ timestamp: "2026-04-18T09:00:02Z", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }),
    JSON.stringify({
      timestamp: "2026-04-18T09:00:03Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "deepwiki", tool: "ask_question", arguments: "{\"q\":\"types\"}" }
    }),
    JSON.stringify({
      timestamp: "2026-04-18T09:00:04Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", server: "deepwiki", tool: "ask_question", duration_ms: 45, success: true }
    }),
    JSON.stringify({ timestamp: "2026-04-18T09:00:05Z", type: "event_msg", payload: { type: "agent_message", message: "assistant after" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-mcp"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[mcp_tool_call_begin\] deepwiki ask_question/);
  assert.match(result.stdout, /\[mcp_tool_call_end\] deepwiki ask_question/);
  assert.doesNotMatch(result.stdout, /assistant before/);
  assert.doesNotMatch(result.stdout, /assistant after/);
  assert.doesNotMatch(result.stdout, /\[tool_call\] read_file/);
});

test("applies --count after filtering selected categories on a mixed timeline", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "18", "rollout-2026-04-18T10-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-18T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-18T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "assistant 1" } }),
    JSON.stringify({
      timestamp: "2026-04-18T10:00:02Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "server-1", tool: "alpha", arguments: "{\"step\":1}" }
    }),
    JSON.stringify({ timestamp: "2026-04-18T10:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "assistant 2" } }),
    JSON.stringify({
      timestamp: "2026-04-18T10:00:04Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "server-2", tool: "beta", arguments: "{\"step\":2}" }
    }),
    JSON.stringify({ timestamp: "2026-04-18T10:00:05Z", type: "event_msg", payload: { type: "agent_message", message: "assistant 3" } }),
    JSON.stringify({
      timestamp: "2026-04-18T10:00:06Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", server: "server-2", tool: "beta", duration_ms: 20, success: true }
    }),
    JSON.stringify({ timestamp: "2026-04-18T10:00:07Z", type: "event_msg", payload: { type: "agent_message", message: "assistant 4" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-mcp",
    "--timeline",
    "--count",
    "2"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[1\] 2026-04-18T10:00:04Z/);
  assert.match(result.stdout, /\[mcp_tool_call_begin\] server-2 beta/);
  assert.match(result.stdout, /\[2\] 2026-04-18T10:00:06Z/);
  assert.match(result.stdout, /\[mcp_tool_call_end\] server-2 beta/);
  assert.doesNotMatch(result.stdout, /assistant 4/);
  assert.doesNotMatch(result.stdout, /server-1 alpha/);
});

test("treats include flags as category selectors and --timeline as ordering only", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "18", "rollout-2026-04-18T11-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-18T11:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-18T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "assistant only" } }),
    JSON.stringify({ timestamp: "2026-04-18T11:00:02Z", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } }),
    JSON.stringify({ timestamp: "2026-04-18T11:00:03Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_9", output: "{\"ok\":true}" } }),
    JSON.stringify({
      timestamp: "2026-04-18T11:00:04Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "deepwiki", tool: "ask_question", arguments: "{\"q\":\"timeline\"}" }
    })
  ]);

  const toolsTimeline = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-tools",
    "--timeline"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(toolsTimeline.status, 0, `stdout=${toolsTimeline.stdout}\nstderr=${toolsTimeline.stderr}`);
  assert.match(toolsTimeline.stdout, /\[tool_call\] read_file/);
  assert.match(toolsTimeline.stdout, /\[tool_output\] call_9/);
  assert.doesNotMatch(toolsTimeline.stdout, /assistant only/);
  assert.doesNotMatch(toolsTimeline.stdout, /\[mcp_tool_call_begin\] deepwiki ask_question/);

  const assistantTimeline = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--timeline"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(assistantTimeline.status, 0, `stdout=${assistantTimeline.stdout}\nstderr=${assistantTimeline.stderr}`);
  assert.match(assistantTimeline.stdout, /assistant only/);
  assert.doesNotMatch(assistantTimeline.stdout, /\[tool_call\] read_file/);
  assert.doesNotMatch(assistantTimeline.stdout, /\[mcp_tool_call_begin\] deepwiki ask_question/);
});

test("keeps assistant fallback output available in timeline mode", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "18", "rollout-2026-04-18T12-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-18T12:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-18T12:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "assistant fallback text" }
        ]
      }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--only",
    "assistant"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /assistant fallback text/);
});

test("fails fast when --only has no value", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--only"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /--only requires one of: assistant, tools, mcp/);
});

test("fails with file and line details when a rollout JSONL line is malformed", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const rolloutPath = path.join(sessionsRoot, "2026", "04", "18", "rollout-2026-04-18T14-00-00-root.jsonl");

  writeLines(rolloutPath, [
    JSON.stringify({ timestamp: "2026-04-18T14:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    "{ not valid json",
    JSON.stringify({ timestamp: "2026-04-18T14:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "should not be shown" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Failed to parse rollout JSONL/);
  assert.match(result.stderr, /rollout-2026-04-18T14-00-00-root\.jsonl/);
  assert.match(result.stderr, /line 2/);
});

test("combined include flags enable the full mixed timeline even without --timeline", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "18", "rollout-2026-04-18T13-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-18T13:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-18T13:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "assistant mixed" } }),
    JSON.stringify({ timestamp: "2026-04-18T13:00:02Z", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } }),
    JSON.stringify({
      timestamp: "2026-04-18T13:00:03Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "deepwiki", tool: "ask_question", arguments: "{\"q\":\"mixed\"}" }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-tools",
    "--include-mcp"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /assistant mixed/);
  assert.match(result.stdout, /\[tool_call\] read_file/);
  assert.match(result.stdout, /\[mcp_tool_call_begin\] deepwiki ask_question/);
});

test("exports both cxr and codex-ai-replies bin commands", () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  assert.equal(packageJson.bin.cxr, "bin/codex-ai-replies.js");
  assert.equal(packageJson.bin["codex-ai-replies"], "bin/codex-ai-replies.js");
});
