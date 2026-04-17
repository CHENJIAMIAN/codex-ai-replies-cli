import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function walkRollouts(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  results.sort().reverse();
  return results;
}

function readJsonLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isSubagentRollout(entries) {
  const sessionMeta = entries.find((entry) => entry.type === "session_meta");
  if (!sessionMeta?.payload) {
    return false;
  }

  const { payload } = sessionMeta;
  if (payload?.source?.subagent?.thread_spawn) {
    return true;
  }

  const sessionSource = String(payload.session_source ?? payload.source ?? "");
  return /sub.?agent/i.test(sessionSource);
}

export function findLatestMainRollout(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Sessions root not found: ${sessionsRoot}`);
  }

  for (const filePath of walkRollouts(sessionsRoot)) {
    const entries = readJsonLines(filePath);
    if (!isSubagentRollout(entries)) {
      return { filePath, entries };
    }
  }

  throw new Error(`No main-agent rollout file found under: ${sessionsRoot}`);
}

export function extractMessages(entries) {
  const eventMessages = entries
    .filter((entry) => entry.type === "event_msg" && entry.payload?.type === "agent_message" && entry.payload?.message)
    .map((entry) => ({
      timestamp: String(entry.timestamp ?? ""),
      message: String(entry.payload.message)
    }));

  if (eventMessages.length > 0) {
    return eventMessages;
  }

  return entries
    .filter((entry) => entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "assistant")
    .flatMap((entry) =>
      (entry.payload.content ?? [])
        .filter((item) => item.type === "output_text" && item.text)
        .map((item) => ({
          timestamp: String(entry.timestamp ?? ""),
          message: String(item.text)
        }))
    );
}

export function formatMessages(messages) {
  return messages
    .map((message, index) => {
      const lines = [
        "==========",
        `[${index + 1}] ${message.timestamp}`,
        "",
        ...String(message.message).replace(/\r\n/g, "\n").split("\n")
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

export function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return path.join(os.homedir(), "Desktop", `codex-ai-replies-${timestamp}.txt`);
}
