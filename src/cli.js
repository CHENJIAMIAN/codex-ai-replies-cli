import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { defaultOutputPath, extractMessages, extractTimeline, findLatestMainRollout, findRolloutById, formatMessages } from "./core.js";

const HELP_TEXT = `codex-ai-replies

Usage:
  codex-ai-replies [options]

Options:
  --count <n>            limit to the latest n messages, default 100
  --save                 write the extracted messages to a text file and open with VS Code when available
  --open                 legacy alias for opening the saved output
  --output <path>        explicit output path
  --raw-file <path>      read a specific rollout file instead of auto-discovering
  --id <sessionId>       read a specific session id instead of the latest session
  --json                 print JSON instead of the formatted text view
  --include-tools        include function/tool call events
  --include-mcp          include MCP events
  --timeline             mix assistant, tool, and MCP events in timestamp order
  --compact-arguments    render MCP arguments as one-line JSON
  --sessions-root <path> override the default sessions root
  --help                 show this help
  --version              show package version
`;

function readPackageVersion() {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return String(packageJson.version);
}

function parseArgs(argv) {
  const options = {
    count: 100,
    save: false,
    open: false,
    json: false,
    includeTools: false,
    includeMcp: false,
    timeline: false,
    compactArguments: false,
    sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
    outputPath: null,
    rawFile: null,
    sessionId: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
        options.count = Number.parseInt(argv[++i], 10);
        break;
      case "--save":
        options.save = true;
        break;
      case "--open":
        options.open = true;
        options.save = true;
        break;
      case "--output":
        options.outputPath = argv[++i];
        options.save = true;
        break;
      case "--raw-file":
        options.rawFile = argv[++i];
        break;
      case "--id":
        options.sessionId = argv[++i];
        break;
      case "--json":
        options.json = true;
        break;
      case "--include-tools":
        options.includeTools = true;
        break;
      case "--include-mcp":
        options.includeMcp = true;
        break;
      case "--timeline":
        options.timeline = true;
        break;
      case "--compact-arguments":
        options.compactArguments = true;
        break;
      case "--sessions-root":
        options.sessionsRoot = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error("--count must be a positive integer");
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
      entries: fs
        .readFileSync(options.rawFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    };
  }

  if (options.sessionId) {
    return findRolloutById(options.sessionsRoot, options.sessionId);
  }

  return findLatestMainRollout(options.sessionsRoot);
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

  const selected = chooseRollout(options);
  const messages = options.timeline
    ? extractTimeline(selected.entries, options)
    : extractMessages(selected.entries);

  if (messages.length === 0) {
    throw new Error(`No assistant messages found in: ${selected.filePath}`);
  }

  const recentMessages = messages.slice(-options.count);
  const output = options.json ? JSON.stringify(recentMessages, null, 2) : formatMessages(recentMessages, options);

  process.stdout.write(`${output}\n`);

  if (options.save) {
    const outputPath = options.outputPath ?? defaultOutputPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${output}\n`, "utf8");
    process.stderr.write(`Saved: ${outputPath}\n`);
    maybeOpen(outputPath);
  }
}
