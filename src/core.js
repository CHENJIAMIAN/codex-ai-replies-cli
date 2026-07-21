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

function readFirstSessionMeta(filePath) {
  const fileDescriptor = fs.openSync(filePath, "r");
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(0x0A);
      if (newlineIndex >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newlineIndex)));
        break;
      }

      chunks.push(Buffer.from(chunk));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }

  const firstLine = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").replace(/\r$/, "");
  if (!firstLine) {
    return null;
  }

  try {
    const entry = JSON.parse(firstLine);
    return entry.type === "session_meta" ? entry.payload ?? null : null;
  } catch (error) {
    throw new Error(formatParseFailure(filePath, 1, error), { cause: error });
  }
}

function getSessionMeta(entries) {
  return entries.find((entry) => entry.type === "session_meta")?.payload ?? null;
}

function getSessionId(filePath, entries) {
  const payload = getSessionMeta(entries);
  const id = [payload?.id, payload?.session_id, payload?.thread_id, payload?.trace_id]
    .map((value) => normalizeLookupValue(value))
    .find(Boolean);

  if (id) {
    return id;
  }

  return path.basename(filePath).replace(/^rollout-/i, "").replace(/\.jsonl$/i, "");
}

function getTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  for (const item of content) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const text = item.text ?? item.input_text ?? item.value;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }

  return "";
}

function getUserRequestMessages(entries) {
  const eventMessages = [];
  const responseMessages = [];

  for (const entry of entries) {
    if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
      const message = entry.payload.message ?? entry.payload.text;
      if (typeof message === "string" && message.trim()) {
        eventMessages.push(message.trim());
      }
    }

    if (
      entry.type === "response_item"
      && entry.payload?.type === "message"
      && entry.payload?.role === "user"
    ) {
      const message = getTextContent(entry.payload.content);
      if (message) {
        responseMessages.push(message);
      }
    }
  }

  return eventMessages.length > 0 ? eventMessages : responseMessages;
}

function getWorkingDirectory(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "turn_context") {
      continue;
    }

    const cwd = entry.payload?.cwd;
    if (typeof cwd === "string" && cwd.trim()) {
      return cwd.trim();
    }
  }

  const cwd = getSessionMeta(entries)?.cwd;
  return typeof cwd === "string" ? cwd.trim() : "";
}

function makeSessionMessagePreview(message, maxLength = 160) {
  const compact = String(message ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}

function isSubagentSessionMeta(payload) {
  if (!payload) {
    return false;
  }
  if (payload?.source?.subagent?.thread_spawn) {
    return true;
  }

  const sessionSource = String(payload.session_source ?? payload.source ?? "");
  return /sub.?agent/i.test(sessionSource);
}

function isSubagentRollout(entries) {
  return isSubagentSessionMeta(getSessionMeta(entries));
}

function getSubagentThreadSpawnFromMeta(payload) {
  const threadSpawn = payload?.source?.subagent?.thread_spawn;
  return threadSpawn && typeof threadSpawn === "object" ? threadSpawn : null;
}

function getSubagentParentSessionIdFromMeta(payload) {
  const threadSpawn = getSubagentThreadSpawnFromMeta(payload);
  return [
    threadSpawn?.parent_thread_id,
    threadSpawn?.parentThreadId,
    threadSpawn?.parent_id,
    threadSpawn?.parentId,
    threadSpawn?.parent
  ]
    .map((value) => normalizeLookupValue(value))
    .find(Boolean) ?? "";
}

function getSubagentPathFromMeta(payload) {
  const threadSpawn = getSubagentThreadSpawnFromMeta(payload);
  return normalizeLookupValue(threadSpawn?.agent_path ?? threadSpawn?.agentPath);
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

function getUuidV7Date(requestedId) {
  const compactId = normalizeLookupValue(requestedId).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compactId) || compactId[12].toLowerCase() !== "7") {
    return null;
  }

  const timestampMs = Number.parseInt(compactId.slice(0, 12), 16);
  if (!Number.isSafeInteger(timestampMs)) {
    return null;
  }

  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatSessionDatePath(date, useUtc) {
  const year = useUtc ? date.getUTCFullYear() : date.getFullYear();
  const month = String((useUtc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
  const day = String(useUtc ? date.getUTCDate() : date.getDate()).padStart(2, "0");
  return path.join(String(year), month, day);
}

function findUuidV7RolloutCandidates(sessionsRoot, requestedId) {
  const date = getUuidV7Date(requestedId);
  if (!date) {
    return [];
  }

  const wantedId = normalizeLookupValue(requestedId).toLowerCase();
  const fileSuffix = `-${wantedId}.jsonl`;
  const dateDirectories = [...new Set([
    formatSessionDatePath(date, false),
    formatSessionDatePath(date, true)
  ])];
  const candidates = [];

  for (const dateDirectory of dateDirectories) {
    const directoryPath = path.join(sessionsRoot, dateDirectory);
    if (!fs.existsSync(directoryPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const entryName = entry.name.toLowerCase();
      if (
        entry.isFile()
        && entryName.startsWith("rollout-")
        && entryName.endsWith(fileSuffix)
      ) {
        candidates.push(path.join(directoryPath, entry.name));
      }
    }
  }

  return candidates;
}

export function findMainRolloutByRecency(sessionsRoot, rank = 1) {
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error("Rollout recency rank must be a positive integer");
  }

  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Sessions root not found: ${sessionsRoot}`);
  }

  let mainRolloutCount = 0;
  for (const filePath of walkRollouts(sessionsRoot)) {
    const entries = readJsonLines(filePath);
    if (!isSubagentRollout(entries)) {
      mainRolloutCount += 1;
      if (mainRolloutCount === rank) {
        return { filePath, entries };
      }
    }
  }

  if (rank > 1) {
    throw new Error(`No main-agent rollout found at recency rank ${rank} under: ${sessionsRoot}`);
  }

  throw new Error(`No main-agent rollout file found under: ${sessionsRoot}`);
}

export function findLatestMainRollout(sessionsRoot) {
  return findMainRolloutByRecency(sessionsRoot);
}

export function findRolloutById(sessionsRoot, requestedId) {
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Sessions root not found: ${sessionsRoot}`);
  }

  for (const filePath of findUuidV7RolloutCandidates(sessionsRoot, requestedId)) {
    const entries = readJsonLines(filePath);
    const score = getRolloutMatchScore(filePath, entries, requestedId);
    if (score >= 101) {
      return { filePath, entries };
    }
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

function getSubagentExecutionEntries(entries) {
  const firstTurnContextIndex = entries.findIndex((entry) => entry.type === "turn_context");
  return firstTurnContextIndex >= 0 ? entries.slice(firstTurnContextIndex + 1) : entries;
}

function getAssistantMessageDetails(entries) {
  const eventMessages = entries
    .filter((entry) => entry.type === "event_msg" && entry.payload?.type === "agent_message" && entry.payload?.message)
    .map((entry) => ({
      timestamp: String(entry.timestamp ?? ""),
      phase: normalizeLookupValue(entry.payload.phase),
      message: String(entry.payload.message)
    }));

  if (eventMessages.length > 0) {
    return eventMessages;
  }

  return entries
    .filter((entry) => entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "assistant")
    .map((entry) => ({
      timestamp: String(entry.timestamp ?? ""),
      phase: "assistant",
      message: getTextContent(entry.payload.content)
    }))
    .filter((message) => message.message);
}

function getSubagentMessageSummary(entries) {
  const messages = getAssistantMessageDetails(getSubagentExecutionEntries(entries));
  const firstMessage = messages[0] ?? null;
  const lastMessage = messages.at(-1) ?? null;

  return {
    messageCount: messages.length,
    firstMessage: firstMessage ? makeSessionMessagePreview(firstMessage.message, 220) : null,
    firstMessageAt: firstMessage?.timestamp || null,
    firstPhase: firstMessage?.phase || null,
    lastMessage: lastMessage ? makeSessionMessagePreview(lastMessage.message, 220) : null,
    lastMessageAt: lastMessage?.timestamp || null,
    lastPhase: lastMessage?.phase || null
  };
}

function collectSubagentRollouts(sessionsRoot, parentRollout) {
  if (!parentRollout?.filePath || !Array.isArray(parentRollout.entries)) {
    throw new Error("A parent rollout with filePath and entries is required to find subagents");
  }

  const parentSessionId = getSessionId(parentRollout.filePath, parentRollout.entries);
  const subagents = [];

  for (const filePath of walkRollouts(sessionsRoot)) {
    let sessionMeta;
    try {
      sessionMeta = readFirstSessionMeta(filePath);
    } catch {
      continue;
    }

    if (
      !isSubagentSessionMeta(sessionMeta)
      || getSubagentParentSessionIdFromMeta(sessionMeta) !== parentSessionId
    ) {
      continue;
    }

    const entries = readJsonLines(filePath);
    const messageSummary = getSubagentMessageSummary(entries);
    subagents.push({
      filePath,
      entries,
      parentSessionId,
      sessionId: getSessionId(filePath, entries),
      agentPath: getSubagentPathFromMeta(sessionMeta),
      updatedAt: fs.statSync(filePath).mtime.toISOString(),
      ...messageSummary
    });
  }

  return subagents.map((subagent, index) => ({
    ...subagent,
    rank: index + 1
  }));
}

export function listSubagentRollouts(sessionsRoot, parentRollout) {
  return collectSubagentRollouts(sessionsRoot, parentRollout).map(({ entries, ...subagent }) => subagent);
}

export function findSubagentRollout(sessionsRoot, parentRollout, selector) {
  const normalizedSelector = normalizeLookupValue(selector);
  if (!normalizedSelector) {
    throw new Error("Subagent selector is required");
  }

  const subagents = collectSubagentRollouts(sessionsRoot, parentRollout);
  const parentSessionId = getSessionId(parentRollout.filePath, parentRollout.entries);
  let selected;

  if (/^\d+$/.test(normalizedSelector)) {
    const rank = Number.parseInt(normalizedSelector, 10);
    if (!Number.isInteger(rank) || rank < 1) {
      throw new Error("Subagent rank must be a positive integer");
    }
    selected = subagents[rank - 1];
  } else {
    const matches = subagents.filter((subagent) => subagent.agentPath === normalizedSelector);
    if (matches.length > 1) {
      throw new Error(`Multiple subagent rollouts match agent path: ${normalizedSelector}. Use --agent<n> instead.`);
    }
    selected = matches[0];
  }

  if (!selected) {
    throw new Error(`No subagent rollout found for selector: ${normalizedSelector} under parent session: ${parentSessionId}`);
  }

  const { entries, ...agent } = selected;
  return { filePath: selected.filePath, entries, agent };
}

export function listRecentMainSessions(sessionsRoot, count) {
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Sessions root not found: ${sessionsRoot}`);
  }

  const sessions = [];
  for (const filePath of walkRollouts(sessionsRoot)) {
    const entries = readJsonLines(filePath);
    if (isSubagentRollout(entries)) {
      continue;
    }

    const userRequests = getUserRequestMessages(entries);

    sessions.push({
      id: getSessionId(filePath, entries),
      updatedAt: fs.statSync(filePath).mtime.toISOString(),
      firstUserMessage: makeSessionMessagePreview(userRequests[0]),
      lastUserMessage: makeSessionMessagePreview(userRequests[userRequests.length - 1]),
      workingDirectory: getWorkingDirectory(entries),
      filePath
    });

    if (sessions.length >= count) {
      return sessions;
    }
  }

  if (sessions.length > 0) {
    return sessions;
  }

  throw new Error(`No main-agent rollout file found under: ${sessionsRoot}`);
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
    return new Set(["tool_call"]);
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

function isToolIdentifierStart(character) {
  return Boolean(character) && /[A-Za-z_$]/.test(character);
}

function isToolIdentifierCharacter(character) {
  return Boolean(character) && /[A-Za-z0-9_$]/.test(character);
}

function skipJavaScriptString(input, startIndex) {
  const quote = input[startIndex];
  let index = startIndex + 1;

  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === quote) {
      return index + 1;
    }
    index += 1;
  }

  return input.length;
}

function skipJavaScriptComment(input, startIndex) {
  if (input[startIndex + 1] === "/") {
    const endIndex = input.indexOf("\n", startIndex + 2);
    return endIndex === -1 ? input.length : endIndex + 1;
  }
  if (input[startIndex + 1] === "*") {
    const endIndex = input.indexOf("*/", startIndex + 2);
    return endIndex === -1 ? input.length : endIndex + 2;
  }
  return startIndex;
}

function findJavaScriptCallEnd(input, openParenthesisIndex) {
  let depth = 0;
  let index = openParenthesisIndex;

  while (index < input.length) {
    const character = input[index];
    if (character === "\"" || character === "'" || character === "`") {
      index = skipJavaScriptString(input, index);
      continue;
    }
    if (character === "/" && (input[index + 1] === "/" || input[index + 1] === "*")) {
      index = skipJavaScriptComment(input, index);
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }

  return -1;
}

function parseCustomToolArguments(argumentsSource) {
  if (!argumentsSource) {
    return {};
  }

  try {
    return JSON.parse(argumentsSource);
  } catch {
    return { input: argumentsSource };
  }
}

function resolveCustomToolArguments(input, argumentsSource, toolCallIndex) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argumentsSource)) {
    return parseCustomToolArguments(argumentsSource);
  }

  const variableName = argumentsSource;
  const escapedVariableName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationPattern = new RegExp(
    `\\b(?:const|let|var)\\s+${escapedVariableName}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`,
    "g"
  );
  let resolvedValue;

  for (const match of input.matchAll(declarationPattern)) {
    if (match.index >= toolCallIndex) {
      break;
    }
    try {
      resolvedValue = JSON.parse(match[1]);
    } catch {
      // Keep looking for an earlier valid static declaration.
    }
  }

  return resolvedValue === undefined
    ? parseCustomToolArguments(argumentsSource)
    : { [variableName]: resolvedValue };
}

function extractCustomToolCalls(payload) {
  const input = payload?.input;
  if (typeof input !== "string") {
    return [];
  }

  const calls = [];
  let index = 0;

  while (index < input.length) {
    const character = input[index];
    if (character === "\"" || character === "'" || character === "`") {
      index = skipJavaScriptString(input, index);
      continue;
    }
    if (character === "/" && (input[index + 1] === "/" || input[index + 1] === "*")) {
      index = skipJavaScriptComment(input, index);
      continue;
    }
    if (!input.startsWith("tools.", index) || isToolIdentifierCharacter(input[index - 1])) {
      index += 1;
      continue;
    }

    const nameStart = index + "tools.".length;
    if (!isToolIdentifierStart(input[nameStart])) {
      index = nameStart;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (isToolIdentifierCharacter(input[nameEnd])) {
      nameEnd += 1;
    }

    let openParenthesisIndex = nameEnd;
    while (/\s/.test(input[openParenthesisIndex] ?? "")) {
      openParenthesisIndex += 1;
    }
    if (input[openParenthesisIndex] !== "(") {
      index = nameEnd;
      continue;
    }

    const closeParenthesisIndex = findJavaScriptCallEnd(input, openParenthesisIndex);
    if (closeParenthesisIndex !== -1) {
      calls.push({
        name: input.slice(nameStart, nameEnd),
        arguments: resolveCustomToolArguments(
          input,
          input.slice(openParenthesisIndex + 1, closeParenthesisIndex).trim(),
          index
        )
      });
    }
    index = nameEnd;
  }

  return calls;
}

function makeCustomToolCallGroupDetails(payload, toolCalls) {
  const { input, ...details } = payload;
  return {
    ...details,
    calls: toolCalls,
    wrapper_name: payload.name,
    wrapper_call_id: payload.call_id
  };
}

function makeExpandedToolCallDetails(payload, toolCall) {
  const { input, ...details } = payload;
  return {
    ...details,
    name: toolCall.name,
    arguments: toolCall.arguments,
    wrapper_name: payload.name,
    wrapper_call_id: payload.call_id
  };
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
      (allowedKinds.has("tool_call") || allowedKinds.has("user_input"))
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

      if (payloadType === "custom_tool_call" && allowedKinds.has("tool_call")) {
        const nestedToolCalls = extractCustomToolCalls(entry.payload);
        if (nestedToolCalls.length === 1) {
          const [toolCall] = nestedToolCalls;
          items.push({
            kind: "tool_call",
            timestamp: String(entry.timestamp ?? ""),
            message: `[tool_call] ${toolCall.name}`,
            details: makeExpandedToolCallDetails(entry.payload, toolCall)
          });
          continue;
        }
        if (nestedToolCalls.length > 1) {
          items.push({
            kind: "tool_call_group",
            timestamp: String(entry.timestamp ?? ""),
            message: `[tool_calls] ${nestedToolCalls.length} calls`,
            details: makeCustomToolCallGroupDetails(entry.payload, nestedToolCalls)
          });
          continue;
        }
      }

      if (
        (payloadType === "function_call" || payloadType === "custom_tool_call")
        && allowedKinds.has("tool_call")
      ) {
        items.push({
          kind: "tool_call",
          timestamp: String(entry.timestamp ?? ""),
          message: `[tool_call] ${String(entry.payload.name ?? "")}`.trim(),
          details: entry.payload
        });
        continue;
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

function normalizeArgumentsValue(argumentsValue) {
  if (typeof argumentsValue !== "string") {
    return argumentsValue;
  }

  try {
    return JSON.parse(argumentsValue);
  } catch {
    return argumentsValue;
  }
}

function appendArguments(bodyLines, argumentsValue, options) {
  if (argumentsValue === undefined) {
    return;
  }

  const normalizedArguments = normalizeArgumentsValue(argumentsValue);
  bodyLines.push("");
  if (!options.compactArguments && normalizedArguments !== null && typeof normalizedArguments === "object") {
    bodyLines.push("arguments:");
    bodyLines.push(...formatReadableValue(normalizedArguments));
    return;
  }

  bodyLines.push(`arguments: ${JSON.stringify(normalizedArguments)}`);
}

function getToolCallArguments(details) {
  if (details?.arguments !== undefined) {
    return details.arguments;
  }

  if (details?.input !== undefined) {
    return { input: details.input };
  }

  return undefined;
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

export function formatSessionList(sessions) {
  return sessions
    .map((session, index) => {
      const firstUserMessage = session.firstUserMessage || "(no user message found)";
      const lastUserMessage = session.lastUserMessage || "(no user message found)";
      const workingDirectory = session.workingDirectory || "(unknown)";
      return [
        "==========",
        `[${index + 1}] ${formatDisplayTimestamp(session.updatedAt)}`,
        `id: ${session.id}`,
        `first request: ${firstUserMessage}`,
        `last request: ${lastUserMessage}`,
        `cwd: ${workingDirectory}`,
        `path: ${session.filePath}`
      ].join("\n");
    })
    .join("\n");
}

export function formatSubagentList(parentRollout, subagents, totalCount = subagents.length) {
  const parentSessionId = getSessionId(parentRollout.filePath, parentRollout.entries);
  const header = [
    `parent session: ${parentSessionId}`,
    `parent path: ${parentRollout.filePath}`,
    `subagents: ${totalCount}`,
    ...(totalCount === subagents.length ? [] : [`shown: ${subagents.length}`])
  ].join("\n");

  if (subagents.length === 0) {
    return header;
  }

  return [
    header,
    ...subagents.map((subagent) => {
      const agentPath = subagent.agentPath || "(unknown agent path)";
      const firstMessageAt = subagent.firstMessageAt
        ? formatDisplayTimestamp(subagent.firstMessageAt)
        : "(no assistant message found)";
      const lastMessageAt = subagent.lastMessageAt
        ? formatDisplayTimestamp(subagent.lastMessageAt)
        : "(no assistant message found)";
      const firstPhase = subagent.firstPhase || "(unknown)";
      const lastPhase = subagent.lastPhase || "(unknown)";
      const firstMessage = subagent.firstMessage || "(no assistant message found)";
      const lastMessage = subagent.lastMessage || "(no assistant message found)";
      return [
        "==========",
        `[${subagent.rank}] ${agentPath}`,
        `session id: ${subagent.sessionId}`,
        `updated: ${formatDisplayTimestamp(subagent.updatedAt)}`,
        `messages: ${subagent.messageCount}`,
        `first reply (${firstMessageAt}, ${firstPhase}): ${firstMessage}`,
        `last reply (${lastMessageAt}, ${lastPhase}): ${lastMessage}`,
        `path: ${subagent.filePath}`
      ].join("\n");
    })
  ].join("\n\n");
}

export function formatMessages(messages, options = {}) {
  const startingIndex = Number.isInteger(options.startingIndex) ? options.startingIndex : 0;
  const sourceLine = options.sourceLabel ? `source: ${options.sourceLabel}` : null;
  return messages
    .map((message, index) => {
      const bodyLines = String(message.message).replace(/\r\n/g, "\n").split("\n");
      if (message.kind?.startsWith("mcp_")) {
        appendArguments(bodyLines, message.details?.invocation?.arguments ?? message.details?.arguments, options);
      }
      if (message.kind === "tool_call") {
        appendArguments(bodyLines, getToolCallArguments(message.details), options);
      }
      if (message.kind === "tool_call_group") {
        for (const toolCall of message.details?.calls ?? []) {
          bodyLines.push("");
          bodyLines.push(`[tool_call] ${toolCall.name}`);
          appendArguments(bodyLines, toolCall.arguments, options);
        }
      }
      if (message.kind === "raw") {
        bodyLines.push("");
        bodyLines.push(...formatReadableValue(message.details));
      }
      if (message.kind === "user_input") {
        appendArguments(bodyLines, message.details?.arguments ?? message.details?.questions ?? message.details, options);
      }

      const lines = [
        "==========",
        `[${startingIndex + index + 1}] ${formatDisplayTimestamp(message.timestamp)}`,
        ...(sourceLine ? [sourceLine] : []),
        "",
        ...bodyLines
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

function entriesHavePrefix(entries, prefix) {
  if (entries.length < prefix.length) {
    return false;
  }

  return prefix.every((entry, index) => JSON.stringify(entry) === JSON.stringify(entries[index]));
}

function readStableEntries(filePath) {
  while (true) {
    const sizeBeforeRead = fs.statSync(filePath).size;
    const entries = readJsonLines(filePath);
    const sizeAfterRead = fs.statSync(filePath).size;
    if (sizeBeforeRead === sizeAfterRead) {
      return { entries, size: sizeAfterRead };
    }
  }
}

export async function watchRollout(filePath, initialEntries, options = {}, onItems) {
  const allEntries = [...initialEntries];
  let emittedItemCount = extractSelectedItems(allEntries, options).length;
  const initialSnapshot = readStableEntries(filePath);

  if (entriesHavePrefix(initialSnapshot.entries, allEntries)) {
    if (initialSnapshot.entries.length > allEntries.length) {
      allEntries.push(...initialSnapshot.entries.slice(allEntries.length));
      const selectedItems = extractSelectedItems(allEntries, options);
      const newItems = selectedItems.slice(emittedItemCount);
      emittedItemCount = selectedItems.length;
      if (newItems.length > 0) {
        await onItems(newItems);
      }
    }
  } else {
    allEntries.splice(0, allEntries.length, ...initialSnapshot.entries);
    emittedItemCount = extractSelectedItems(allEntries, options).length;
  }

  let readOffset = initialSnapshot.size;
  let pendingText = "";
  let nextLineNumber = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;

  while (true) {
    await delay(100);

    const stats = fs.statSync(filePath);
    if (stats.size < readOffset) {
      const resetSnapshot = readStableEntries(filePath);
      allEntries.splice(0, allEntries.length, ...resetSnapshot.entries);
      emittedItemCount = extractSelectedItems(allEntries, options).length;
      readOffset = resetSnapshot.size;
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
