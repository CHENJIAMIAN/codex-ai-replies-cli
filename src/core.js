import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
        const stats = fs.statSync(fullPath);
        results.push({ filePath: fullPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  results.sort((left, right) => {
    const mtimeDifference = right.mtimeMs - left.mtimeMs;
    if (mtimeDifference !== 0) {
      return mtimeDifference;
    }
    return right.filePath.localeCompare(left.filePath);
  });
  return results.map((result) => result.filePath);
}

function formatParseFailure(filePath, lineNumber, cause) {
  const reason = cause instanceof Error && cause.message ? cause.message : String(cause);
  return `Failed to parse rollout JSONL: ${filePath} line ${lineNumber}: ${reason}`;
}

export function readJsonLines(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new Error(formatParseFailure(filePath, index + 1, error), { cause: error });
    }
  }

  return entries;
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

function normalizeLookupValue(value) {
  return String(value ?? "").trim();
}

function matchesExactRolloutPath(filePath, requestedId) {
  const wanted = normalizeLookupValue(requestedId);
  if (!wanted) {
    return false;
  }

  const normalizedWanted = path.normalize(wanted).toLowerCase();
  const normalizedFilePath = path.normalize(filePath).toLowerCase();
  const basename = path.basename(filePath);
  const basenameWithoutExtension = basename.replace(/\.jsonl$/i, "");

  return (
    normalizedFilePath === normalizedWanted
    || basename.toLowerCase() === wanted.toLowerCase()
    || basenameWithoutExtension.toLowerCase() === wanted.toLowerCase()
  );
}

function getRolloutMatchScore(filePath, entries, requestedId) {
  const wanted = String(requestedId ?? "").trim();
  if (!wanted) {
    return -1;
  }

  const payload = getSessionMeta(entries);
  const idMatches = payload
    ? [payload.id, payload.session_id, payload.thread_id, payload.trace_id]
      .filter(Boolean)
      .map((value) => normalizeLookupValue(value))
      .some((value) => value === wanted)
    : false;

  const pathMatches = matchesExactRolloutPath(filePath, wanted);
  if (!idMatches && !pathMatches) {
    return -1;
  }

  let score = idMatches ? 100 : 10;
  if (!isSubagentRollout(entries)) {
    score += 1;
  }
  return score;
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

  let bestMatch = null;

  for (const filePath of walkRollouts(sessionsRoot)) {
    const entries = readJsonLines(filePath);
    const score = getRolloutMatchScore(filePath, entries, requestedId);
    if (score > (bestMatch?.score ?? -1)) {
      bestMatch = { filePath, entries, score };
    }
  }

  if (bestMatch) {
    return { filePath: bestMatch.filePath, entries: bestMatch.entries };
  }

  throw new Error(`No rollout file found for id: ${requestedId}`);
}

export function extractMessages(entries) {
  return extractAssistantItems(entries);
}

export function extractAllItems(entries) {
  return entries.map((entry) => ({
    kind: "raw",
    timestamp: String(entry.timestamp ?? ""),
    message: `type: ${String(entry.type ?? "")}`.trim(),
    details: entry
  }));
}

export function usesTimelineOutput(options = {}) {
  return Boolean(
    options.timeline
    || options.includeTools
    || options.includeMcp
    || options.includeUserInput
    || options.only
  );
}

export function extractSelectedItems(entries, options = {}) {
  if (options.only === "all") {
    return extractAllItems(entries);
  }

  if (usesTimelineOutput(options)) {
    return extractTimeline(entries, options);
  }

  return extractMessages(entries);
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

  if (options.only === "user-input") {
    return new Set(["user_input"]);
  }

  if (options.only === "all") {
    return new Set(["all"]);
  }

  const selectedIncludeKinds = [];
  if (options.includeTools) {
    selectedIncludeKinds.push("tools");
  }

  if (options.includeMcp) {
    selectedIncludeKinds.push("mcp");
  }

  if (options.includeUserInput) {
    selectedIncludeKinds.push("user_input");
  }

  if (selectedIncludeKinds.length === 0) {
    return new Set(["assistant"]);
  }

  const kinds = new Set();
  if (selectedIncludeKinds.length > 1) {
    kinds.add("assistant");
  }

  if (options.includeTools) {
    kinds.add("tool_call");
    kinds.add("tool_output");
  }

  if (options.includeMcp) {
    kinds.add("mcp_tool_call_begin");
    kinds.add("mcp_tool_call_end");
  }

  if (options.includeUserInput) {
    kinds.add("user_input");
  }

  return kinds;
}

function extractUserInputItem(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const payloadType = String(payload.type ?? "").trim().toLowerCase();
  if (payloadType === "request_user_input" || payloadType === "requestuserinput") {
    return {
      message: "[user_input] request_user_input",
      details: payload
    };
  }

  if (payloadType === "function_call" && String(payload.name ?? "").trim() === "request_user_input") {
    let normalizedArguments = payload.arguments;
    if (typeof normalizedArguments === "string") {
      try {
        normalizedArguments = JSON.parse(normalizedArguments);
      } catch {
        // Keep the original string when it is not valid JSON.
      }
    }

    const questions = Array.isArray(normalizedArguments?.questions) ? normalizedArguments.questions : [];
    const label = questions
      .map((question) => String(question?.question ?? question?.header ?? "").trim())
      .filter(Boolean)
      .join(" | ");

    return {
      message: label ? `[user_input] ${label}` : "[user_input] request_user_input",
      details: {
        ...payload,
        arguments: normalizedArguments
      }
    };
  }

  if (payloadType === "message" && payload.role === "assistant") {
    const inputRequest = (payload.content ?? []).find((item) => {
      const itemType = String(item?.type ?? "").trim().toLowerCase();
      return itemType === "request_user_input" || itemType === "requestuserinput";
    });

    if (inputRequest) {
      return {
        message: "[user_input] request_user_input",
        details: inputRequest
      };
    }
  }

  return null;
}

function matchesMcpFilter(entry, options = {}) {
  if (!options.mcpServer && !options.mcpTool) {
    return true;
  }

  const server = String(entry.payload?.invocation?.server ?? entry.payload?.server ?? "").trim();
  const tool = String(entry.payload?.invocation?.tool ?? entry.payload?.tool ?? "").trim();

  if (options.mcpServer && server !== options.mcpServer) {
    return false;
  }

  if (options.mcpTool && tool !== options.mcpTool) {
    return false;
  }

  return true;
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
      if (payloadType === "mcp_tool_call_begin" && allowedKinds.has("mcp_tool_call_begin") && matchesMcpFilter(entry, options)) {
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

      if (payloadType === "mcp_tool_call_end" && allowedKinds.has("mcp_tool_call_end") && matchesMcpFilter(entry, options)) {
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
      (allowedKinds.has("tool_call") || allowedKinds.has("tool_output") || allowedKinds.has("user_input"))
      && entry.type === "response_item"
    ) {
      const payloadType = String(entry.payload?.type ?? "");
      if (allowedKinds.has("user_input")) {
        const userInputItem = extractUserInputItem(entry.payload);
        if (userInputItem) {
          items.push({
            kind: "user_input",
            timestamp: String(entry.timestamp ?? ""),
            message: userInputItem.message,
            details: userInputItem.details
          });
          continue;
        }
      }

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

    if (allowedKinds.has("user_input") && entry.type === "event_msg") {
      const payloadType = String(entry.payload?.type ?? "").trim().toLowerCase();
      if (payloadType === "request_user_input" || payloadType === "requestuserinput") {
        items.push({
          kind: "user_input",
          timestamp: String(entry.timestamp ?? ""),
          message: "[user_input] request_user_input",
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

function isMultilineString(value) {
  return typeof value === "string" && /[\r\n]/.test(value);
}

function formatScalarInline(value) {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}

function formatReadableValue(value, indentLevel = 0) {
  const indent = "  ".repeat(indentLevel);
  const childIndent = "  ".repeat(indentLevel + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}[]`];
    }

    const lines = [`${indent}[`];
    for (const item of value) {
      if (isMultilineString(item)) {
        lines.push(`${childIndent}|`);
        lines.push(...String(item).replace(/\r\n/g, "\n").split("\n").map((line) => `${"  ".repeat(indentLevel + 2)}${line}`));
      } else {
        lines.push(...formatReadableValue(item, indentLevel + 1));
      }
    }
    lines.push(`${indent}]`);
    return lines;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${indent}{}`];
    }

    const lines = [`${indent}{`];
    for (const [key, entryValue] of entries) {
      const keyLabel = `${childIndent}${JSON.stringify(key)}:`;
      if (isMultilineString(entryValue)) {
        lines.push(`${keyLabel} |`);
        lines.push(...String(entryValue).replace(/\r\n/g, "\n").split("\n").map((line) => `${"  ".repeat(indentLevel + 2)}${line}`));
      } else if (entryValue !== null && typeof entryValue === "object") {
        const rendered = formatReadableValue(entryValue, indentLevel + 1);
        lines.push(`${keyLabel} ${rendered[0].trimStart()}`);
        lines.push(...rendered.slice(1));
      } else {
        lines.push(`${keyLabel} ${formatScalarInline(entryValue)}`);
      }
    }
    lines.push(`${indent}}`);
    return lines;
  }

  return [`${indent}${formatScalarInline(value)}`];
}

function formatDisplayTimestamp(timestamp) {
  const value = String(timestamp ?? "").trim();
  if (!value) {
    return value;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  const second = String(parsed.getSeconds()).padStart(2, "0");
  const hasFractionalSeconds = /\.\d+/.test(value);
  const milliseconds = String(parsed.getMilliseconds()).padStart(3, "0");

  return hasFractionalSeconds
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}.${milliseconds}`
    : `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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
            bodyLines.push(...formatReadableValue(normalizedArguments));
          } else {
            bodyLines.push(`arguments: ${JSON.stringify(normalizedArguments)}`);
          }
        }
      }
      if (message.kind === "raw") {
        bodyLines.push("");
        bodyLines.push(...formatReadableValue(message.details));
      }
      if (message.kind === "user_input") {
        const argumentsValue = message.details?.arguments ?? message.details?.questions ?? message.details;
        if (argumentsValue !== undefined) {
          bodyLines.push("");
          if (!options.compactArguments && argumentsValue !== null && typeof argumentsValue === "object") {
            bodyLines.push("arguments:");
            bodyLines.push(...formatReadableValue(argumentsValue));
          } else {
            bodyLines.push(`arguments: ${JSON.stringify(argumentsValue)}`);
          }
        }
      }

      const lines = [
        "==========",
        `[${index + 1}] ${formatDisplayTimestamp(message.timestamp)}`,
        "",
        ...bodyLines
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function watchRollout(filePath, initialEntries, options = {}, onItems) {
  const allEntries = [...initialEntries];
  let emittedItemCount = extractSelectedItems(allEntries, options).length;
  let readOffset = fs.statSync(filePath).size;
  let pendingText = "";
  let nextLineNumber = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;

  while (true) {
    await delay(100);

    const stats = fs.statSync(filePath);
    if (stats.size < readOffset) {
      readOffset = stats.size;
      pendingText = "";
      nextLineNumber = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
      continue;
    }

    if (stats.size === readOffset) {
      continue;
    }

    const chunkSize = stats.size - readOffset;
    const buffer = Buffer.alloc(chunkSize);
    const fileDescriptor = fs.openSync(filePath, "r");
    try {
      fs.readSync(fileDescriptor, buffer, 0, chunkSize, readOffset);
    } finally {
      fs.closeSync(fileDescriptor);
    }

    readOffset = stats.size;
    pendingText += buffer.toString("utf8");

    const lines = pendingText.split(/\r?\n/);
    pendingText = lines.pop() ?? "";

    let appendedEntries = 0;
    for (const line of lines) {
      const currentLineNumber = nextLineNumber;
      nextLineNumber += 1;

      if (!line) {
        continue;
      }

      try {
        allEntries.push(JSON.parse(line));
        appendedEntries += 1;
      } catch (error) {
        throw new Error(formatParseFailure(filePath, currentLineNumber, error), { cause: error });
      }
    }

    if (appendedEntries === 0) {
      continue;
    }

    const selectedItems = extractSelectedItems(allEntries, options);
    const newItems = selectedItems.slice(emittedItemCount);
    emittedItemCount = selectedItems.length;

    if (newItems.length > 0) {
      await onItems(newItems);
    }
  }
}

export function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return path.join(os.homedir(), "Desktop", `codex-ai-replies-${timestamp}.txt`);
}
