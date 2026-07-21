import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

async function waitForText(getText, expectedText, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getText().includes(expectedText)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for text: ${expectedText}\nCurrent output:\n${getText()}`);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => child.once("exit", resolve));
}

function formatLocalTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  const second = String(parsed.getSeconds()).padStart(2, "0");
  const hasFractionalSeconds = /\.\d+/.test(timestamp);
  const milliseconds = String(parsed.getMilliseconds()).padStart(3, "0");

  return hasFractionalSeconds
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}.${milliseconds}`
    : `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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
  assert.match(result.stdout, new RegExp(`\\[1\\] ${formatLocalTimestamp("2026-04-17T10:00:01Z")}`));
  assert.match(result.stdout, /第一条/);
  assert.match(result.stdout, new RegExp(`\\[2\\] ${formatLocalTimestamp("2026-04-17T10:00:02Z")}`));
  assert.match(result.stdout, /第二行/);
  assert.doesNotMatch(result.stdout, /SUBAGENT/);

  const written = fs.readFileSync(outputPath, "utf8");
  assert.match(written, /^==========/m);
  assert.match(written, new RegExp(`\\[1\\] ${formatLocalTimestamp("2026-04-17T10:00:01Z")}`));
  assert.match(written, new RegExp(`\\[2\\] ${formatLocalTimestamp("2026-04-17T10:00:02Z")}`));
  assert.match(written, /第二条\n第二行/);
});

test("streams appended rollout messages in --watch mode after printing the latest count", async () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const rolloutPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T10-00-00-root.jsonl");

  writeLines(rolloutPath, [
    JSON.stringify({ timestamp: "2026-04-21T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-21T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "message 1" } }),
    JSON.stringify({ timestamp: "2026-04-21T10:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "message 2" } }),
    JSON.stringify({ timestamp: "2026-04-21T10:00:03Z", type: "event_msg", payload: { type: "agent_message", message: "message 3" } })
  ]);

  const child = spawn(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--watch",
    "--count",
    "2"
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForText(() => stdout, "message 3");
    assert.match(stdout, /\[1\][\s\S]*message 2/);
    assert.match(stdout, /\[2\][\s\S]*message 3/);
    assert.match(stdout, /message 2/);
    assert.match(stdout, /message 3/);
    assert.doesNotMatch(stdout, /message 1/);

    fs.appendFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-04-21T10:00:04Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "message 4" }
    })}\n`, "utf8");

    await waitForText(() => stdout, "message 4");
    assert.match(stdout, /\[3\][\s\S]*message 4/);
    assert.match(stdout, /message 4/);

    fs.appendFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-04-21T10:00:05Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "message 5" }
    })}\n`, "utf8");

    await waitForText(() => stdout, "message 5");
    assert.match(stdout, /\[4\][\s\S]*message 5/);
    assert.equal(stderr, "", `stderr=${stderr}`);
  } finally {
    if (!child.killed) {
      child.kill();
    }
    await waitForExit(child);
  }
});

test("--watchN 跟随按更新时间排名的指定主会话", async () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const thirdPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T10-00-00-third.jsonl");
  const secondPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T11-00-00-second.jsonl");
  const latestPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T12-00-00-latest.jsonl");
  const subagentPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T13-00-00-subagent.jsonl");

  writeLines(thirdPath, [
    JSON.stringify({ timestamp: "2026-04-21T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-21T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "third initial" } })
  ]);
  writeLines(secondPath, [
    JSON.stringify({ timestamp: "2026-04-21T11:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-21T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "second initial" } })
  ]);
  writeLines(latestPath, [
    JSON.stringify({ timestamp: "2026-04-21T12:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-21T12:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "latest initial" } })
  ]);
  writeLines(subagentPath, [
    JSON.stringify({
      timestamp: "2026-04-21T13:00:00Z",
      type: "session_meta",
      payload: { source: { subagent: { thread_spawn: { parent: "root" } } } }
    }),
    JSON.stringify({ timestamp: "2026-04-21T13:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "subagent initial" } })
  ]);

  fs.utimesSync(thirdPath, new Date("2026-04-21T10:00:00Z"), new Date("2026-04-21T10:00:00Z"));
  fs.utimesSync(secondPath, new Date("2026-04-21T11:00:00Z"), new Date("2026-04-21T11:00:00Z"));
  fs.utimesSync(latestPath, new Date("2026-04-21T12:00:00Z"), new Date("2026-04-21T12:00:00Z"));
  fs.utimesSync(subagentPath, new Date("2026-04-21T13:00:00Z"), new Date("2026-04-21T13:00:00Z"));

  const child = spawn(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--watch3"
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForText(() => stdout, "third initial");
    assert.doesNotMatch(stdout, /second initial|latest initial|subagent initial/);

    fs.appendFileSync(thirdPath, `${JSON.stringify({
      timestamp: "2026-04-21T10:00:02Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "third appended" }
    })}\n`, "utf8");

    await waitForText(() => stdout, "third appended");
    assert.equal(stderr, "", `stderr=${stderr}`);
  } finally {
    if (!child.killed) {
      child.kill();
    }
    await waitForExit(child);
  }
});

test("拒绝无效的 watch 排名", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--watch0"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /--watch rank must be a positive integer/);
});

test("renders rollout timestamps in the local timezone for text output", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "07", "01", "rollout-2026-07-01T12-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-01T12:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-07-01T12:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "summer time check" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TZ: "Europe/London"
    }
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[1\] 2026-07-01 13:00:01/);
  assert.doesNotMatch(result.stdout, /2026-07-01T12:00:01Z/);
});

test("selects latest main-agent rollout by file update time", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const updatedLaterPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-root.jsonl");
  const namedLaterPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-root.jsonl");

  writeLines(updatedLaterPath, [
    JSON.stringify({ timestamp: "2026-04-17T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "updated later" } })
  ]);

  writeLines(namedLaterPath, [
    JSON.stringify({ timestamp: "2026-04-17T11:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "named later" } })
  ]);

  fs.utimesSync(updatedLaterPath, new Date("2026-04-17T12:00:00Z"), new Date("2026-04-17T12:00:00Z"));
  fs.utimesSync(namedLaterPath, new Date("2026-04-17T11:00:00Z"), new Date("2026-04-17T11:00:00Z"));

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /updated later/);
  assert.doesNotMatch(result.stdout, /named later/);
});

test("列出最近主会话并跳过子代理", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const olderPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-older.jsonl");
  const newerPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-newer.jsonl");
  const subagentPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T12-00-00-sub.jsonl");

  writeLines(olderPath, [
    JSON.stringify({ timestamp: "2026-04-17T10:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "older-root", cwd: "D:\\workspace\\older" } }),
    JSON.stringify({
      timestamp: "2026-04-17T10:00:01Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "older request" }] }
    })
  ]);

  writeLines(newerPath, [
    JSON.stringify({ timestamp: "2026-04-17T11:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "newer-root", cwd: "D:\\workspace\\initial" } }),
    JSON.stringify({
      timestamp: "2026-04-17T11:00:01Z",
      type: "event_msg",
      payload: { type: "user_message", message: "newer first request\nwith whitespace" }
    }),
    JSON.stringify({
      timestamp: "2026-04-17T11:00:02Z",
      type: "event_msg",
      payload: { type: "user_message", message: "newer last request" }
    }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:03Z", type: "turn_context", payload: { cwd: "D:\\workspace\\newer" } })
  ]);

  writeLines(subagentPath, [
    JSON.stringify({
      timestamp: "2026-04-17T12:00:00Z",
      type: "session_meta",
      payload: { id: "subagent", source: { subagent: { thread_spawn: { parent: "root" } } } }
    }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:01Z", type: "event_msg", payload: { type: "user_message", message: "do not show" } })
  ]);

  fs.utimesSync(olderPath, new Date("2026-04-17T10:00:00Z"), new Date("2026-04-17T10:00:00Z"));
  fs.utimesSync(newerPath, new Date("2026-04-17T11:00:00Z"), new Date("2026-04-17T11:00:00Z"));
  fs.utimesSync(subagentPath, new Date("2026-04-17T12:00:00Z"), new Date("2026-04-17T12:00:00Z"));

  const { result } = runCli(["--sessions-root", sessionsRoot, "--list-sessions"], { tempDir });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /id: newer-root/);
  assert.match(result.stdout, /first request: newer first request with whitespace/);
  assert.match(result.stdout, /last request: newer last request/);
  assert.match(result.stdout, /cwd: D:\\workspace\\newer/);
  assert.match(result.stdout, new RegExp(`path: ${newerPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  assert.match(result.stdout, /id: older-root/);
  assert.match(result.stdout, /first request: older request/);
  assert.match(result.stdout, /last request: older request/);
  assert.match(result.stdout, /cwd: D:\\workspace\\older/);
  assert.ok(result.stdout.indexOf("id: newer-root") < result.stdout.indexOf("id: older-root"));
  assert.doesNotMatch(result.stdout, /subagent|do not show/);
});

test("最近会话列表支持数量限制和 JSON 输出", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const olderPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T10-00-00-older.jsonl");
  const newerPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-newer.jsonl");

  writeLines(olderPath, [
    JSON.stringify({ timestamp: "2026-04-17T10:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "older-root" } }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "older request" } })
  ]);
  writeLines(newerPath, [
    JSON.stringify({ timestamp: "2026-04-17T11:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "newer-root", cwd: "D:\\workspace\\initial" } }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "user_message", message: "newer first request" } }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:02Z", type: "event_msg", payload: { type: "user_message", message: "newer last request" } }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:03Z", type: "turn_context", payload: { cwd: "D:\\workspace\\newer" } })
  ]);

  fs.utimesSync(olderPath, new Date("2026-04-17T10:00:00Z"), new Date("2026-04-17T10:00:00Z"));
  fs.utimesSync(newerPath, new Date("2026-04-17T11:00:00Z"), new Date("2026-04-17T11:00:00Z"));

  const { result } = runCli([
    "--sessions-root",
    sessionsRoot,
    "--list-sessions",
    "--count",
    "1",
    "--json"
  ], { tempDir });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  const sessions = JSON.parse(result.stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "newer-root");
  assert.equal(sessions[0].firstUserMessage, "newer first request");
  assert.equal(sessions[0].lastUserMessage, "newer last request");
  assert.equal(sessions[0].workingDirectory, "D:\\workspace\\newer");
  assert.equal(sessions[0].filePath, newerPath);
  assert.match(sessions[0].updatedAt, /^2026-04-17T11:00:00/);
});

test("短参数可列出并读取指定会话", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const rolloutPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-root.jsonl");

  writeLines(rolloutPath, [
    JSON.stringify({ timestamp: "2026-04-17T11:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "short-option-root" } }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "user_message", message: "short option request" } }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "short option answer" } })
  ]);

  const listed = runCli(["-r", sessionsRoot, "-l", "-n", "1", "-j"], { tempDir }).result;
  assert.equal(listed.status, 0, `stdout=${listed.stdout}\nstderr=${listed.stderr}`);
  assert.equal(JSON.parse(listed.stdout)[0].id, "short-option-root");

  const selected = runCli(["-r", sessionsRoot, "-i", "short-option-root", "-n", "1", "-j"], { tempDir }).result;
  assert.equal(selected.status, 0, `stdout=${selected.stdout}\nstderr=${selected.stderr}`);
  assert.equal(JSON.parse(selected.stdout)[0].message, "short option answer");

  const rawFile = runCli(["-f", rolloutPath, "-n", "1", "-j"], { tempDir }).result;
  assert.equal(rawFile.status, 0, `stdout=${rawFile.stdout}\nstderr=${rawFile.stderr}`);
  assert.equal(JSON.parse(rawFile.stdout)[0].message, "short option answer");
});

test("短参数可筛选 MCP 时间线", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T11:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-17T11:00:01Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "server-a", tool: "tool-a", arguments: "{\"line\":\"one\"}" }
    }),
    JSON.stringify({
      timestamp: "2026-04-17T11:00:02Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "server-b", tool: "tool-b", arguments: "{\"line\":\"two\"}" }
    })
  ]);

  const result = runCli([
    "-r",
    sessionsRoot,
    "-y",
    "mcp",
    "-S",
    "server-a",
    "-K",
    "tool-a",
    "-c"
  ], { tempDir }).result;

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[mcp_tool_call_begin\] server-a tool-a/);
  assert.doesNotMatch(result.stdout, /server-b|tool-b/);
  assert.match(result.stdout, /arguments: {"line":"one"}/);
});

test("最近会话列表拒绝与会话读取选项混用", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--list-sessions", "--id", "some-session"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /--list-sessions cannot be combined with --id/);
});

test("prints help text", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /codex-ai-replies/);
  assert.match(result.stdout, /--count <n>/);
  assert.match(result.stdout, /--list-sessions/);
  assert.match(result.stdout, /-l/);
  assert.match(result.stdout, /-n <n>/);
  assert.match(result.stdout, /--save/);
  assert.match(result.stdout, /--open/);
  assert.match(result.stdout, /--all-events/);
  assert.match(result.stdout, /-A/);
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

test("includes tool calls and MCP events when requested in timeline output", () => {
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
  assert.match(result.stdout, /arguments:\n\{\n  "path": "a\.txt"\n\}/);
  assert.doesNotMatch(result.stdout, /\[tool_output\] call_1/);
  assert.match(result.stdout, /\[mcp_tool_call_begin\] deepwiki ask_question/);
  assert.match(result.stdout, /\[mcp_tool_call_end\] deepwiki ask_question/);
  assert.match(result.stdout, /arguments:\n\{\n  "q": "types"\n\}/);
  assert.match(result.stdout, /AI after tool/);
});

test("expands custom tool calls into their concrete tools and arguments", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T12-30-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T12:30:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-17T12:30:01Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "custom_call_1",
        input: "const label = 'tools.not_a_real_call()';\nconst result = await tools.shell_command({\"command\":\"es -n 100 -ext docx Tooltip\"});\ntext(result);"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-17T12:30:02Z",
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "custom_call_1" }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-tools"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[tool_call\] shell_command/);
  assert.match(result.stdout, /arguments:\n\{\n  "command": "es -n 100 -ext docx Tooltip"\n\}/);
  assert.doesNotMatch(result.stdout, /\[tool_call\] exec|\[tool_calls\]|not_a_real_call|\[tool_output\] custom_call_1/);
});

test("resolves static patch variables in custom tool calls", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T12-35-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-17T12:35:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-17T12:35:01Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: "const patch = \"*** Begin Patch\\n*** Update File: notes.txt\\n+hello\\n*** End Patch\";\nawait tools.apply_patch(patch);"
      }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-tools"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[tool_call\] apply_patch/);
  assert.match(result.stdout, /arguments:\n\{\n  "patch": \|\n    \*\*\* Begin Patch\n    \*\*\* Update File: notes\.txt\n    \+hello\n    \*\*\* End Patch\n\}/);
  assert.doesNotMatch(result.stdout, /"input": "patch"/);
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

test("looks up UUID v7 sessions before parsing unrelated rollouts", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const sessionId = "019f8221-74d3-7591-ac50-78fc244817c9";

  writeLines(path.join(sessionsRoot, "2026", "07", "21", `rollout-2026-07-21T08-44-18-${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-21T00:44:18Z", type: "session_meta", payload: { session_source: "cli", id: sessionId } }),
    JSON.stringify({ timestamp: "2026-07-21T00:44:19Z", type: "event_msg", payload: { type: "agent_message", message: "UUID v7 session" } })
  ]);

  const unrelatedPath = path.join(sessionsRoot, "2026", "07", "20", "rollout-2026-07-20T10-00-00-unrelated.jsonl");
  fs.mkdirSync(path.dirname(unrelatedPath), { recursive: true });
  fs.writeFileSync(unrelatedPath, "{ not valid json\n", "utf8");

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--id",
    sessionId
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /UUID v7 session/);
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

test("lists and selects child-agent rollouts below a main session", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const parentId = "019f8221-74d3-7591-ac50-78fc244817c9";
  const rootPath = path.join(sessionsRoot, "2026", "07", "21", `rollout-2026-07-21T08-44-18-${parentId}.jsonl`);
  const alphaPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T11-00-00-alpha.jsonl");
  const betaPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T12-00-00-beta.jsonl");
  const unrelatedPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T13-00-00-unrelated.jsonl");
  const malformedPath = path.join(sessionsRoot, "2026", "04", "17", "rollout-2026-04-17T14-00-00-malformed.jsonl");

  writeLines(rootPath, [
    JSON.stringify({ timestamp: "2026-04-17T10:00:00Z", type: "session_meta", payload: { session_source: "cli", id: parentId } }),
    JSON.stringify({ timestamp: "2026-04-17T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "root message" } })
  ]);
  writeLines(alphaPath, [
    JSON.stringify({
      timestamp: "2026-04-17T11:00:00Z",
      type: "session_meta",
      payload: {
        id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: "/root/alpha" } } }
      }
    }),
    JSON.stringify({ timestamp: "2026-04-17T11:00:01Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "alpha result" } })
  ]);
  writeLines(betaPath, [
    JSON.stringify({
      timestamp: "2026-04-17T12:00:00Z",
      type: "session_meta",
      payload: {
        id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: "/root/beta" } } }
      }
    }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "inherited parent reply" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:02Z", type: "turn_context", payload: { turn_id: "beta-turn" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:03Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "beta task preview" } }),
    JSON.stringify({ timestamp: "2026-04-17T12:00:04Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "beta result" } })
  ]);
  writeLines(unrelatedPath, [
    JSON.stringify({
      timestamp: "2026-04-17T13:00:00Z",
      type: "session_meta",
      payload: {
        id: "other-session",
        source: { subagent: { thread_spawn: { parent_thread_id: "other-session", agent_path: "/root/unrelated" } } }
      }
    }),
    JSON.stringify({ timestamp: "2026-04-17T13:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "unrelated result" } })
  ]);
  fs.writeFileSync(malformedPath, "{ not valid json\n", "utf8");

  fs.utimesSync(alphaPath, new Date("2026-04-17T11:00:00Z"), new Date("2026-04-17T11:00:00Z"));
  fs.utimesSync(betaPath, new Date("2026-04-17T12:00:00Z"), new Date("2026-04-17T12:00:00Z"));

  const listed = runCli([
    "--sessions-root",
    sessionsRoot,
    "--id",
    parentId,
    "--agents",
    "--json"
  ], { tempDir }).result;

  assert.equal(listed.status, 0, `stdout=${listed.stdout}\nstderr=${listed.stderr}`);
  const agents = JSON.parse(listed.stdout);
  assert.deepEqual(agents.map((agent) => [agent.rank, agent.agentPath]), [
    [1, "/root/beta"],
    [2, "/root/alpha"]
  ]);
  assert.equal(agents[0].parentSessionId, parentId);
  assert.equal(agents[0].messageCount, 2);
  assert.equal(agents[0].firstMessage, "beta task preview");
  assert.equal(agents[0].lastMessage, "beta result");
  assert.equal(agents[0].lastPhase, "final_answer");

  const textList = runCli([
    "--sessions-root",
    sessionsRoot,
    "--id",
    parentId,
    "--agents"
  ], { tempDir }).result;

  assert.equal(textList.status, 0, `stdout=${textList.stdout}\nstderr=${textList.stderr}`);
  assert.match(textList.stdout, /first reply \(.+commentary\): beta task preview/);
  assert.match(textList.stdout, /last reply \(.+final_answer\): beta result/);
  assert.doesNotMatch(textList.stdout, /first reply .*inherited parent reply/);

  const byRank = runCli([
    "--sessions-root",
    sessionsRoot,
    "--id",
    parentId,
    "--agent2"
  ], { tempDir }).result;

  assert.equal(byRank.status, 0, `stdout=${byRank.stdout}\nstderr=${byRank.stderr}`);
  assert.match(byRank.stdout, /source: subagent #2 \/root\/alpha/);
  assert.match(byRank.stdout, /alpha result/);
  assert.doesNotMatch(byRank.stdout, /beta result/);

  const byPath = runCli([
    "--sessions-root",
    sessionsRoot,
    "--id",
    parentId,
    "--agent",
    "/root/beta",
    "--json"
  ], { tempDir }).result;

  assert.equal(byPath.status, 0, `stdout=${byPath.stdout}\nstderr=${byPath.stderr}`);
  const betaMessages = JSON.parse(byPath.stdout);
  assert.equal(betaMessages.at(-1).message, "beta result");
  assert.equal(betaMessages.at(-1).source.agentPath, "/root/beta");
  assert.equal(betaMessages.at(-1).source.parentSessionId, parentId);
});

test("watches a selected child-agent rollout", async () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const parentId = "watch-parent";
  const rootPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T10-00-00-root.jsonl");
  const subagentPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T11-00-00-subagent.jsonl");

  writeLines(rootPath, [
    JSON.stringify({ timestamp: "2026-04-21T10:00:00Z", type: "session_meta", payload: { session_source: "cli", id: parentId } }),
    JSON.stringify({ timestamp: "2026-04-21T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "root message" } })
  ]);
  writeLines(subagentPath, [
    JSON.stringify({
      timestamp: "2026-04-21T11:00:00Z",
      type: "session_meta",
      payload: {
        id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: "/root/watch-child" } } }
      }
    }),
    JSON.stringify({ timestamp: "2026-04-21T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "child initial" } })
  ]);

  const child = spawn(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--id",
    parentId,
    "--agent1",
    "--watch"
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForText(() => stdout, "child initial");
    assert.match(stdout, /source: subagent #1 \/root\/watch-child/);

    fs.appendFileSync(subagentPath, `${JSON.stringify({
      timestamp: "2026-04-21T11:00:02Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "child appended" }
    })}\n`, "utf8");

    await waitForText(() => stdout, "child appended");
    assert.match(stdout, /\[2\][\s\S]*child appended/);
    assert.equal(stderr, "", `stderr=${stderr}`);
  } finally {
    if (!child.killed) {
      child.kill();
    }
    await waitForExit(child);
  }
});

test("--agentsN selects child agents from the ranked main session", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const olderParentId = "older-parent";
  const latestParentId = "latest-parent";
  const olderRootPath = path.join(sessionsRoot, "2026", "04", "22", "rollout-2026-04-22T10-00-00-older-root.jsonl");
  const latestRootPath = path.join(sessionsRoot, "2026", "04", "22", "rollout-2026-04-22T11-00-00-latest-root.jsonl");
  const olderChildPath = path.join(sessionsRoot, "2026", "04", "22", "rollout-2026-04-22T12-00-00-older-child.jsonl");

  writeLines(olderRootPath, [
    JSON.stringify({ timestamp: "2026-04-22T10:00:00Z", type: "session_meta", payload: { session_source: "cli", id: olderParentId } }),
    JSON.stringify({ timestamp: "2026-04-22T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "older root" } })
  ]);
  writeLines(latestRootPath, [
    JSON.stringify({ timestamp: "2026-04-22T11:00:00Z", type: "session_meta", payload: { session_source: "cli", id: latestParentId } }),
    JSON.stringify({ timestamp: "2026-04-22T11:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "latest root" } })
  ]);
  writeLines(olderChildPath, [
    JSON.stringify({
      timestamp: "2026-04-22T12:00:00Z",
      type: "session_meta",
      payload: {
        id: olderParentId,
        source: { subagent: { thread_spawn: { parent_thread_id: olderParentId, agent_path: "/root/older-child" } } }
      }
    }),
    JSON.stringify({ timestamp: "2026-04-22T12:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "older child" } })
  ]);

  fs.utimesSync(olderRootPath, new Date("2026-04-22T10:00:00Z"), new Date("2026-04-22T10:00:00Z"));
  fs.utimesSync(latestRootPath, new Date("2026-04-22T11:00:00Z"), new Date("2026-04-22T11:00:00Z"));

  const listed = runCli([
    "--sessions-root",
    sessionsRoot,
    "--agents2",
    "--json"
  ], { tempDir }).result;

  assert.equal(listed.status, 0, `stdout=${listed.stdout}\nstderr=${listed.stderr}`);
  assert.equal(JSON.parse(listed.stdout)[0].agentPath, "/root/older-child");

  const selected = runCli([
    "--sessions-root",
    sessionsRoot,
    "--agents2",
    "--agent1"
  ], { tempDir }).result;

  assert.equal(selected.status, 0, `stdout=${selected.stdout}\nstderr=${selected.stderr}`);
  assert.match(selected.stdout, /older child/);
  assert.doesNotMatch(selected.stdout, /latest root/);
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

test("renders multiline MCP argument strings as readable text blocks in default output", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T10-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-20T10:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:01Z",
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        server: "chrome-devtools",
        tool: "evaluate_script",
        invocation: {
          server: "chrome-devtools",
          tool: "evaluate_script",
          arguments: {
            function: "() => {\n  return 'ok';\n}",
            selector: ".el-switch__input"
          }
        }
      }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--only",
    "mcp"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /"function": \|/);
  assert.match(result.stdout, /  \(\) => \{/);
  assert.match(result.stdout, /    return 'ok';/);
  assert.match(result.stdout, /"selector": "\.el-switch__input"/);
  assert.doesNotMatch(result.stdout, /\\n/);
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

test("filters MCP events by server and tool together", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T11-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-20T11:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-20T11:00:01Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", server: "chrome-devtools", tool: "evaluate_script", invocation: { server: "chrome-devtools", tool: "evaluate_script", arguments: { function: "() => true" } } }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T11:00:02Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", server: "chrome-devtools", tool: "take_snapshot", invocation: { server: "chrome-devtools", tool: "take_snapshot", arguments: { verbose: false } } }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T11:00:03Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", server: "deepwiki", tool: "ask_question", invocation: { server: "deepwiki", tool: "ask_question", arguments: { q: "types" } } }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--only",
    "mcp",
    "--mcp-server",
    "chrome-devtools",
    "--mcp-tool",
    "evaluate_script"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[mcp_tool_call_end\] chrome-devtools evaluate_script/);
  assert.doesNotMatch(result.stdout, /take_snapshot/);
  assert.doesNotMatch(result.stdout, /deepwiki/);
});

test("filters MCP events by tool only", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T12-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-20T12:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-20T12:00:01Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "chrome-devtools", tool: "evaluate_script", invocation: { server: "chrome-devtools", tool: "evaluate_script", arguments: { function: "() => 1" } } }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T12:00:02Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "other-server", tool: "evaluate_script", invocation: { server: "other-server", tool: "evaluate_script", arguments: { function: "() => 2" } } }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T12:00:03Z",
      type: "event_msg",
      payload: { type: "mcp_tool_call_begin", server: "chrome-devtools", tool: "take_snapshot", invocation: { server: "chrome-devtools", tool: "take_snapshot", arguments: { verbose: false } } }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--only",
    "mcp",
    "--mcp-tool",
    "evaluate_script"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /chrome-devtools evaluate_script/);
  assert.match(result.stdout, /other-server evaluate_script/);
  assert.doesNotMatch(result.stdout, /take_snapshot/);
});

test("fails when MCP-specific filters are used without selecting MCP events", () => {
  const result = spawnSync(process.execPath, [
    cliEntry,
    "--mcp-server",
    "chrome-devtools"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /--mcp-server and --mcp-tool require MCP events to be selected/);
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
  assert.match(result.stdout, new RegExp(`\\[1\\] ${formatLocalTimestamp("2026-04-18T10:00:04Z")}`));
  assert.match(result.stdout, /\[mcp_tool_call_begin\] server-2 beta/);
  assert.match(result.stdout, new RegExp(`\\[2\\] ${formatLocalTimestamp("2026-04-18T10:00:06Z")}`));
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
  assert.doesNotMatch(toolsTimeline.stdout, /\[tool_output\] call_9/);
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

test("extracts request_user_input function calls as user-input events", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T13-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-20T13:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({
      timestamp: "2026-04-20T13:00:01Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        arguments: JSON.stringify({
          questions: [
            {
              header: "Scope",
              question: "Choose one",
              options: [
                { label: "Quick", description: "Fast path" },
                { label: "Full", description: "Complete path" }
              ]
            }
          ]
        })
      }
    })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--only",
    "user-input"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[user_input\] Choose one/);
  assert.match(result.stdout, /"header": "Scope"/);
  assert.match(result.stdout, /"label": "Quick"/);
});

test("includes user-input events in mixed timeline selection", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T14-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-20T14:00:00Z", type: "session_meta", payload: { session_source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-20T14:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "assistant before" } }),
    JSON.stringify({
      timestamp: "2026-04-20T14:00:02Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        arguments: JSON.stringify({
          questions: [
            { header: "Mode", question: "Pick mode", options: [{ label: "A", description: "Option A" }] }
          ]
        })
      }
    }),
    JSON.stringify({ timestamp: "2026-04-20T14:00:03Z", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } })
  ]);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--include-user-input",
    "--include-tools"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /assistant before/);
  assert.match(result.stdout, /\[user_input\] Pick mode/);
  assert.match(result.stdout, /\[tool_call\] read_file/);
});

test("exports all rollout entries when --all-events is selected", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const outputPath = path.join(tempDir, "all-items.txt");

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T15-00-00-root.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-20T15:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "all-test" } }),
    JSON.stringify({ timestamp: "2026-04-20T15:00:01Z", type: "turn_context", payload: { cwd: "D:\\\\Desktop" } }),
    JSON.stringify({ timestamp: "2026-04-20T15:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "assistant line" } }),
    JSON.stringify({ timestamp: "2026-04-20T15:00:03Z", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"a.txt\"}" } })
  ]);

  const { result } = runCli([
    "--sessions-root",
    sessionsRoot,
    "--id",
    "all-test",
    "--all-events",
    "--save",
    "--output",
    outputPath
  ], { tempDir });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, new RegExp(`\\[1\\] ${formatLocalTimestamp("2026-04-20T15:00:00Z")}`));
  assert.match(result.stdout, /type: session_meta/);
  assert.match(result.stdout, new RegExp(`\\[2\\] ${formatLocalTimestamp("2026-04-20T15:00:01Z")}`));
  assert.match(result.stdout, /type: turn_context/);
  assert.match(result.stdout, new RegExp(`\\[3\\] ${formatLocalTimestamp("2026-04-20T15:00:02Z")}`));
  assert.match(result.stdout, /type: event_msg/);
  assert.match(result.stdout, new RegExp(`\\[4\\] ${formatLocalTimestamp("2026-04-20T15:00:03Z")}`));
  assert.match(result.stdout, /type: response_item/);

  const written = fs.readFileSync(outputPath, "utf8");
  assert.match(written, /"session_source": "cli"/);
  assert.match(written, /"cwd": "D:\\\\\\\\Desktop"/);
  assert.match(written, /"name": "read_file"/);
});

test("keeps --only all as a compatibility alias without the default 100-item cap", () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");

  const lines = [JSON.stringify({ timestamp: "2026-04-20T16:00:00Z", type: "session_meta", payload: { session_source: "cli", id: "all-no-cap" } })];
  for (let index = 1; index <= 105; index += 1) {
    lines.push(JSON.stringify({
      timestamp: `2026-04-20T16:00:${String(index).padStart(2, "0")}Z`,
      type: "event_msg",
      payload: { type: "agent_message", message: `message ${index}` }
    }));
  }

  writeLines(path.join(sessionsRoot, "2026", "04", "20", "rollout-2026-04-20T16-00-00-root.jsonl"), lines);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--id",
    "all-no-cap",
    "--only",
    "all"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /\[106\]/);
  assert.match(result.stdout, /message 105/);
});

test("watch mode keeps the default 100-item initial cap before streaming new items", async () => {
  const tempDir = makeTempDir();
  const sessionsRoot = path.join(tempDir, "sessions");
  const rolloutPath = path.join(sessionsRoot, "2026", "04", "21", "rollout-2026-04-21T11-00-00-root.jsonl");

  const lines = [JSON.stringify({ timestamp: "2026-04-21T11:00:00Z", type: "session_meta", payload: { session_source: "cli" } })];
  for (let index = 1; index <= 105; index += 1) {
    lines.push(JSON.stringify({
      timestamp: `2026-04-21T11:00:${String(index).padStart(2, "0")}Z`,
      type: "event_msg",
      payload: { type: "agent_message", message: `message ${index}` }
    }));
  }

  writeLines(rolloutPath, lines);

  const child = spawn(process.execPath, [
    cliEntry,
    "--sessions-root",
    sessionsRoot,
    "--watch"
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  try {
    await waitForText(() => stdout, "message 105");
    assert.doesNotMatch(stdout, /\nmessage 5\n/);
    assert.match(stdout, /\nmessage 6\n/);
    assert.match(stdout, /\nmessage 105\n/);
  } finally {
    if (!child.killed) {
      child.kill();
    }
    await waitForExit(child);
  }
});

test("fails fast when --only has no value", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--only"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /--only requires one of: assistant, tools, mcp, user-input/);
});

test("rejects --all-events combined with category selectors", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--all-events", "--include-tools"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /--all-events cannot be combined with --only, --include-tools, --include-mcp, or --include-user-input/);
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
