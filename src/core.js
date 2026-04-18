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

function getSessionMeta(entries) {
  return entries.find((entry) => entry.type === "session_meta")?.payload ?? null;
}

function isSubagentRollout(entries) {
  const payload = getSessionMeta(entries);
  if (!payload) {
    return false;
  }
  if (payload?.source?.subagent?.thread_spawn) {
    return true;
  }

  const sessionSource = String(payload.session_source ?? payload.source ?? "");
  return /sub.?agent/i.test(sessionSource);
}

function rolloutMatchesId(filePath, entries, requestedId) {
  const wanted = String(requestedId ?? "").trim();
  if (!wanted) {
    return false;
  }

  if (filePath.includes(wanted)) {
    return true;
  }

  const payload = getSessionMeta(entries);
  if (!payload) {
    return false;
  }

  const candidates = [
    payload.id,
    payload.session_id,
    payload.thread_id,
    payload.trace_id
  ]
    .filter(Boolean)
    .map((value) => String(value));

  return candidates.some((value) => value === wanted || value.includes(wanted));
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

export function findRolloutById(sessionsRoot, requestedId) {
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Sessions root not found: ${sessionsRoot}`);
  }

  for (const filePath of walkRollouts(sessionsRoot)) {
    const entries = readJsonLines(filePath);
    if (rolloutMatchesId(filePath, entries, requestedId)) {
      return { filePath, entries };
    }
  }

  throw new Error(`No rollout file found for id: ${requestedId}`);
}

export function extractMessages(entries) {
  return extractAssistantItems(entries);
}

function extractAssistantItems(entries) {
  const eventMessages = entries
    .filter((entry) => entry.type === "event_msg" && entry.payload?.type === "agent_message" && entry.payload?.message)
    .map((entry) => ({
      kind: "assistant",
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
          kind: "assistant",
          timestamp: String(entry.timestamp ?? ""),
          message: String(item.text)
        }))
    );
}

function getTimelineKinds(options = {}) {
  if (options.only === "assistant") {
    return new Set(["assistant"]);
  }

  if (options.only === "tools") {
    return new Set(["tool_call", "tool_output"]);
  }

  if (options.only === "mcp") {
    return new Set(["mcp_tool_call_begin", "mcp_tool_call_end"]);
  }

  if (options.includeTools && options.includeMcp) {
    return new Set([
      "assistant",
      "tool_call",
      "tool_output",
      "mcp_tool_call_begin",
      "mcp_tool_call_end"
    ]);
  }

  if (options.includeTools) {
    return new Set(["tool_call", "tool_output"]);
  }

  if (options.includeMcp) {
    return new Set(["mcp_tool_call_begin", "mcp_tool_call_end"]);
  }

  return new Set(["assistant"]);
}

export function extractTimeline(entries, options = {}) {
  const items = [];
  const allowedKinds = getTimelineKinds(options);
  const assistantItems = allowedKinds.has("assistant") ? extractAssistantItems(entries) : [];
  let assistantIndex = 0;

  for (const entry of entries) {
    if (allowedKinds.has("assistant")) {
      while (assistantIndex < assistantItems.length && assistantItems[assistantIndex].timestamp === String(entry.timestamp ?? "")) {
        items.push(assistantItems[assistantIndex]);
        assistantIndex += 1;
      }
      if (
        entry.type === "event_msg"
        && entry.payload?.type === "agent_message"
        && entry.payload?.message
      ) {
        continue;
      }
      if (
        entry.type === "response_item"
        && entry.payload?.type === "message"
        && entry.payload?.role === "assistant"
      ) {
        continue;
      }
    }

    if (
      allowedKinds.has("assistant")
      && assistantItems.length === 0
      && entry.type === "event_msg"
      && entry.payload?.type === "agent_message"
      && entry.payload?.message
    ) {
      items.push({
        kind: "assistant",
        timestamp: String(entry.timestamp ?? ""),
        message: String(entry.payload.message)
      });
      continue;
    }

    if (
      (allowedKinds.has("mcp_tool_call_begin") || allowedKinds.has("mcp_tool_call_end"))
      && entry.type === "event_msg"
    ) {
      const payloadType = String(entry.payload?.type ?? "");
      if (payloadType === "mcp_tool_call_begin" && allowedKinds.has("mcp_tool_call_begin")) {
        const server = String(entry.payload?.invocation?.server ?? entry.payload?.server ?? "").trim();
        const tool = String(entry.payload?.invocation?.tool ?? entry.payload?.tool ?? "").trim();
        items.push({
          kind: "mcp_tool_call_begin",
          timestamp: String(entry.timestamp ?? ""),
          message: `[mcp_tool_call_begin] ${server} ${tool}`.trim(),
          details: entry.payload
        });
        continue;
      }

      if (payloadType === "mcp_tool_call_end" && allowedKinds.has("mcp_tool_call_end")) {
        const server = String(entry.payload?.invocation?.server ?? entry.payload?.server ?? "").trim();
        const tool = String(entry.payload?.invocation?.tool ?? entry.payload?.tool ?? "").trim();
        items.push({
          kind: "mcp_tool_call_end",
          timestamp: String(entry.timestamp ?? ""),
          message: `[mcp_tool_call_end] ${server} ${tool}`.trim(),
          details: entry.payload
        });
        continue;
      }
    }

    if (
      (allowedKinds.has("tool_call") || allowedKinds.has("tool_output"))
      && entry.type === "response_item"
    ) {
      const payloadType = String(entry.payload?.type ?? "");
      if (payloadType === "function_call" && allowedKinds.has("tool_call")) {
        items.push({
          kind: "tool_call",
          timestamp: String(entry.timestamp ?? ""),
          message: `[tool_call] ${String(entry.payload.name ?? "")}`.trim(),
          details: entry.payload
        });
        continue;
      }

      if (payloadType === "function_call_output" && allowedKinds.has("tool_output")) {
        items.push({
          kind: "tool_output",
          timestamp: String(entry.timestamp ?? ""),
          message: `[tool_output] ${String(entry.payload.call_id ?? "")}`.trim(),
          details: entry.payload
        });
      }
    }
  }

  while (assistantIndex < assistantItems.length) {
    items.push(assistantItems[assistantIndex]);
    assistantIndex += 1;
  }

  return items;
}

export function formatMessages(messages, options = {}) {
  return messages
    .map((message, index) => {
      const bodyLines = String(message.message).replace(/\r\n/g, "\n").split("\n");
      if (message.kind?.startsWith("mcp_")) {
        const argumentsValue = message.details?.invocation?.arguments ?? message.details?.arguments;
        if (argumentsValue !== undefined) {
          let normalizedArguments = argumentsValue;
          if (typeof normalizedArguments === "string") {
            try {
              normalizedArguments = JSON.parse(normalizedArguments);
            } catch {
              // Keep the original string when it is not valid JSON.
            }
          }
          bodyLines.push("");
          if (!options.compactArguments && normalizedArguments !== null && typeof normalizedArguments === "object") {
            bodyLines.push("arguments:");
            bodyLines.push(...JSON.stringify(normalizedArguments, null, 2).split("\n"));
          } else {
            bodyLines.push(`arguments: ${JSON.stringify(normalizedArguments)}`);
          }
        }
      }

      const lines = [
        "==========",
        `[${index + 1}] ${message.timestamp}`,
        "",
        ...bodyLines
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

export function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return path.join(os.homedir(), "Desktop", `codex-ai-replies-${timestamp}.txt`);
}
