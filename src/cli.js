import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  defaultOutputPath,
  extractSelectedItems,
  findLatestMainRollout,
  findMainRolloutByRecency,
  findRolloutById,
  findSubagentRollout,
  formatMessages,
  formatSessionList,
  formatSubagentList,
  listRecentMainSessions,
  listSubagentRollouts,
  readJsonLines,
  usesTimelineOutput,
  watchRollout
} from "./core.js";

const HELP_TEXT = `codex-ai-replies

Usage:
  codex-ai-replies [options]

Options:
  --list-sessions, -l       list recently updated main-agent sessions, default 20
  --count <n>, -n <n>       limit messages, sessions with --list-sessions, or displayed agents with --agents
  --watch, -w [n]           stream rank n main-agent rollout by update time, default 1
  --watch<n>, -w<n>         compact rank form, for example --watch2 or -w2
  --agents [n]              list subagents of the selected main session; optional rank defaults to 1
  --agents<n>               compact main-session rank form, for example --agents2
  --agent <n|agentPath>     read a selected subagent by list rank or agent path
  --agent<n>                compact subagent rank form, for example --agent2
  --save, -s                write the extracted messages to a text file and open with VS Code when available
  --open, -O                legacy alias for opening the saved output
  --output <path>, -o <path> explicit output path
  --raw-file <path>, -f <path> read a specific rollout file instead of auto-discovering
  --id <sessionId>, -i <sessionId> read a specific session id instead of the latest session
  --json, -j                print JSON instead of the formatted text view
  --include-tools, -T       select function/tool call events
  --include-mcp, -M         select MCP events
  --include-user-input, -U  select RequestUserInput-style events
  --timeline, -t            render selected events in timeline order
  --only <kind>, -y <kind>  with timeline output, keep only assistant, tools, mcp, or user-input events
  --all-events, -A          render every raw rollout event
  --mcp-server <name>, -S <name> filter selected MCP events by MCP server name
  --mcp-tool <name>, -K <name> filter selected MCP events by MCP tool name
  --compact-arguments, -c   render arguments as one-line JSON
  --sessions-root <path>, -r <path> override the default sessions root
  --help, -h                show this help
  --version, -v             show package version
`;

const TIMELINE_FILTER_VALUES = new Set(["assistant", "tools", "mcp", "user-input"]);
const DEFAULT_SESSION_LIST_COUNT = 20;

function readPackageVersion() {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return String(packageJson.version);
}

function parseArgs(argv) {
  const options = {
    count: 100,
    countProvided: false,
    watch: false,
    watchRank: 1,
    save: false,
    open: false,
    json: false,
    includeTools: false,
    includeMcp: false,
    includeUserInput: false,
    timeline: false,
    only: null,
    allEvents: false,
    compactArguments: false,
    mcpServer: null,
    mcpTool: null,
    sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
    outputPath: null,
    rawFile: null,
    sessionId: null,
    listSessions: false,
    listAgents: false,
    agentParentRank: null,
    agentSelector: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const compactAgentsMatch = arg.match(/^--agents(?:=)?(\d+)$/);
    if (compactAgentsMatch) {
      const parentRank = Number.parseInt(compactAgentsMatch[1], 10);
      if (!Number.isInteger(parentRank) || parentRank < 1) {
        throw new Error("--agents rank must be a positive integer");
      }
      options.listAgents = true;
      options.agentParentRank = parentRank;
      continue;
    }

    const compactAgentMatch = arg.match(/^--agent(?:=)?(\d+)$/);
    if (compactAgentMatch) {
      const agentRank = Number.parseInt(compactAgentMatch[1], 10);
      if (!Number.isInteger(agentRank) || agentRank < 1) {
        throw new Error("--agent rank must be a positive integer");
      }
      options.agentSelector = String(agentRank);
      continue;
    }

    const compactWatchMatch = arg.match(/^--watch(?:=)?(\d+)$/) ?? arg.match(/^-w(\d+)$/);
    if (compactWatchMatch) {
      const watchRank = Number.parseInt(compactWatchMatch[1], 10);
      if (!Number.isInteger(watchRank) || watchRank < 1) {
        throw new Error("--watch rank must be a positive integer");
      }
      options.watch = true;
      options.watchRank = watchRank;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--count":
      case "-n":
        options.count = Number.parseInt(argv[++i], 10);
        options.countProvided = true;
        break;
      case "--list-sessions":
      case "-l":
        options.listSessions = true;
        break;
      case "--watch":
      case "-w": {
        options.watch = true;
        const nextValue = argv[i + 1];
        if (nextValue && /^\d+$/.test(nextValue)) {
          const watchRank = Number.parseInt(nextValue, 10);
          if (!Number.isInteger(watchRank) || watchRank < 1) {
            throw new Error("--watch rank must be a positive integer");
          }
          options.watchRank = watchRank;
          i += 1;
        }
        break;
      }
      case "--agents": {
        options.listAgents = true;
        const nextValue = argv[i + 1];
        if (nextValue && /^\d+$/.test(nextValue)) {
          const parentRank = Number.parseInt(nextValue, 10);
          if (!Number.isInteger(parentRank) || parentRank < 1) {
            throw new Error("--agents rank must be a positive integer");
          }
          options.agentParentRank = parentRank;
          i += 1;
        }
        break;
      }
      case "--agent": {
        const selector = argv[i + 1];
        if (!selector || selector.startsWith("-")) {
          throw new Error("--agent requires a positive rank or agent path");
        }
        options.agentSelector = selector;
        i += 1;
        break;
      }
      case "--save":
      case "-s":
        options.save = true;
        break;
      case "--open":
      case "-O":
        options.open = true;
        options.save = true;
        break;
      case "--output":
      case "-o":
        options.outputPath = argv[++i];
        options.save = true;
        break;
      case "--raw-file":
      case "-f":
        options.rawFile = argv[++i];
        break;
      case "--id":
      case "-i":
        options.sessionId = argv[++i];
        break;
      case "--json":
      case "-j":
        options.json = true;
        break;
      case "--include-tools":
      case "-T":
        options.includeTools = true;
        break;
      case "--include-mcp":
      case "-M":
        options.includeMcp = true;
        break;
      case "--include-user-input":
      case "-U":
        options.includeUserInput = true;
        break;
      case "--timeline":
      case "-t":
        options.timeline = true;
        break;
      case "--all-events":
      case "-A":
        options.allEvents = true;
        break;
      case "--only":
      case "-y": {
        const onlyValue = argv[i + 1];
        if (!onlyValue || onlyValue.startsWith("-")) {
          throw new Error("--only requires one of: assistant, tools, mcp, user-input");
        }
        const normalizedOnlyValue = String(onlyValue).trim().toLowerCase();
        if (normalizedOnlyValue === "all") {
          options.allEvents = true;
        } else {
          options.only = normalizedOnlyValue;
        }
        i += 1;
        break;
      }
      case "--compact-arguments":
      case "-c":
        options.compactArguments = true;
        break;
      case "--mcp-server":
      case "-S":
        options.mcpServer = argv[++i];
        break;
      case "--mcp-tool":
      case "-K":
        options.mcpTool = argv[++i];
        break;
      case "--sessions-root":
      case "-r":
        options.sessionsRoot = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error("--count must be a positive integer");
  }

  if (options.only) {
    if (!TIMELINE_FILTER_VALUES.has(options.only)) {
      throw new Error("--only must be one of: assistant, tools, mcp, user-input");
    }
    if (options.includeTools || options.includeMcp || options.includeUserInput) {
      throw new Error("--only cannot be combined with --include-tools, --include-mcp, or --include-user-input");
    }
    options.timeline = true;
  }

  if (options.allEvents) {
    if (options.includeTools || options.includeMcp || options.includeUserInput || options.only) {
      throw new Error("--all-events cannot be combined with --only, --include-tools, --include-mcp, or --include-user-input");
    }
    options.only = "all";
    options.timeline = true;
  }

  if (options.listSessions) {
    const incompatibleOption = [
      [options.rawFile, "--raw-file"],
      [options.sessionId, "--id"],
      [options.watch, "--watch"],
      [options.listAgents, "--agents"],
      [options.agentSelector, "--agent"],
      [options.includeTools, "--include-tools"],
      [options.includeMcp, "--include-mcp"],
      [options.includeUserInput, "--include-user-input"],
      [options.allEvents, "--all-events"],
      [options.timeline, "--timeline"],
      [options.only, "--only"],
      [options.compactArguments, "--compact-arguments"],
      [options.mcpServer, "--mcp-server"],
      [options.mcpTool, "--mcp-tool"]
    ].find(([isSet]) => Boolean(isSet));

    if (incompatibleOption) {
      throw new Error(`--list-sessions cannot be combined with ${incompatibleOption[1]}`);
    }
  }

  if (options.listAgents && !options.agentSelector) {
    const incompatibleOption = [
      [options.watch, "--watch"],
      [options.includeTools, "--include-tools"],
      [options.includeMcp, "--include-mcp"],
      [options.includeUserInput, "--include-user-input"],
      [options.allEvents, "--all-events"],
      [options.timeline, "--timeline"],
      [options.only, "--only"],
      [options.compactArguments, "--compact-arguments"],
      [options.mcpServer, "--mcp-server"],
      [options.mcpTool, "--mcp-tool"]
    ].find(([isSet]) => Boolean(isSet));

    if (incompatibleOption) {
      throw new Error(`--agents cannot be combined with ${incompatibleOption[1]} unless --agent is also provided`);
    }
  }

  const selectsMcp = options.only === "mcp" || options.includeMcp;
  if ((options.mcpServer || options.mcpTool) && !selectsMcp) {
    throw new Error("--mcp-server and --mcp-tool require MCP events to be selected");
  }

  return options;
}

function chooseRollout(options) {
  if (options.rawFile) {
    if (!fs.existsSync(options.rawFile)) {
      throw new Error(`Rollout file not found: ${options.rawFile}`);
    }
    return {
      filePath: options.rawFile,
      entries: readJsonLines(options.rawFile)
    };
  }

  if (options.sessionId) {
    return findRolloutById(options.sessionsRoot, options.sessionId);
  }

  const rank = options.agentParentRank ?? options.watchRank;
  return rank > 1
    ? findMainRolloutByRecency(options.sessionsRoot, rank)
    : findLatestMainRollout(options.sessionsRoot);
}

function addSubagentSource(items, agent) {
  return items.map((item) => ({
    ...item,
    source: {
      kind: "subagent",
      rank: agent.rank,
      agentPath: agent.agentPath || null,
      parentSessionId: agent.parentSessionId,
      filePath: agent.filePath
    }
  }));
}

function maybeOpen(filePath) {
  const codeLookup = process.platform === "win32"
    ? spawnSync("where", ["code"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["code"], { encoding: "utf8" });

  if (codeLookup.status === 0) {
    const codeCommand = process.platform === "win32" ? "cmd" : "code";
    const codeArgs = process.platform === "win32" ? ["/c", "code", filePath] : [filePath];
    const codeChild = spawn(codeCommand, codeArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    codeChild.on("error", () => {});
    codeChild.unref();
    return;
  }

  const platform = process.platform;
  let command;
  let args = [];

  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", filePath];
  } else if (platform === "darwin") {
    command = "open";
    args = [filePath];
  } else {
    command = "xdg-open";
    args = [filePath];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {});
  child.unref();
}

function saveOutput(output, options) {
  if (!options.save) {
    return;
  }

  const outputPath = options.outputPath ?? defaultOutputPath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${output}\n`, "utf8");
  process.stderr.write(`Saved: ${outputPath}\n`);
  maybeOpen(outputPath);
}

export async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (options.version) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  if (options.listSessions) {
    const count = options.countProvided ? options.count : DEFAULT_SESSION_LIST_COUNT;
    const sessions = listRecentMainSessions(options.sessionsRoot, count);
    const output = options.json ? JSON.stringify(sessions, null, 2) : formatSessionList(sessions);
    process.stdout.write(`${output}\n`);
    saveOutput(output, options);
    return;
  }

  const parentRollout = chooseRollout(options);
  if (options.listAgents && !options.agentSelector) {
    const agents = listSubagentRollouts(options.sessionsRoot, parentRollout);
    const recentAgents = options.countProvided ? agents.slice(0, options.count) : agents;
    const output = options.json ? JSON.stringify(recentAgents, null, 2) : formatSubagentList(parentRollout, recentAgents, agents.length);
    process.stdout.write(`${output}\n`);
    saveOutput(output, options);
    return;
  }

  const selected = options.agentSelector
    ? findSubagentRollout(options.sessionsRoot, parentRollout, options.agentSelector)
    : { ...parentRollout, agent: null };
  const useTimelineSelection = usesTimelineOutput(options);
  const messages = extractSelectedItems(selected.entries, options);

  if (messages.length === 0) {
    if (options.only) {
      throw new Error(`No ${options.only} timeline events found in: ${selected.filePath}`);
    }
    if (useTimelineSelection) {
      throw new Error(`No timeline events found in: ${selected.filePath}`);
    }
    throw new Error(`No assistant messages found in: ${selected.filePath}`);
  }

  const recentMessages = options.only === "all" && !options.countProvided
    ? messages
    : messages.slice(-options.count);
  const outputMessages = selected.agent ? addSubagentSource(recentMessages, selected.agent) : recentMessages;
  const sourceLabel = selected.agent
    ? `subagent #${selected.agent.rank} ${selected.agent.agentPath || "(unknown agent path)"}`
    : null;
  const output = options.json
    ? JSON.stringify(outputMessages, null, 2)
    : formatMessages(outputMessages, { ...options, sourceLabel });

  process.stdout.write(`${output}\n`);

  saveOutput(output, options);

  if (options.watch) {
    let printedCount = recentMessages.length;
    await watchRollout(selected.filePath, selected.entries, options, async (newItems) => {
      const watchOutput = options.json
        ? JSON.stringify(selected.agent ? addSubagentSource(newItems, selected.agent) : newItems, null, 2)
        : formatMessages(newItems, {
          ...options,
          sourceLabel,
          startingIndex: printedCount
        });
      printedCount += newItems.length;
      process.stdout.write(`${watchOutput}\n`);
    });
  }
}
