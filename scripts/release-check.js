import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const cliEntry = path.join(repoRoot, "bin", "codex-ai-replies.js");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const EXPECTED_PACK_FILES = [
  "LICENSE",
  "README.md",
  "bin/codex-ai-replies.js",
  "package.json",
  "src/cli.js",
  "src/core.js"
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "").trim();
    const details = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${details ? `\n${details}` : ""}`);
  }

  return result;
}

function verifyPackContents() {
  const result = process.platform === "win32"
    ? run("cmd.exe", ["/d", "/s", "/c", "npm pack --json --dry-run"])
    : run("npm", ["pack", "--json", "--dry-run"]);
  const packReport = JSON.parse(result.stdout);
  const actualFiles = [...new Set((packReport[0]?.files ?? []).map((file) => String(file.path)))].sort();
  const expectedFiles = [...EXPECTED_PACK_FILES].sort();

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Pack contents mismatch\nExpected: ${expectedFiles.join(", ")}\nActual: ${actualFiles.join(", ")}`
    );
  }

  process.stdout.write(`Pack contents OK (${actualFiles.length} files)\n`);
}

function verifyCliSmoke() {
  const helpResult = run(process.execPath, [cliEntry, "--help"]);
  const versionResult = run(process.execPath, [cliEntry, "--version"]);

  if (!helpResult.stdout.includes("codex-ai-replies") || !helpResult.stdout.includes("--help")) {
    throw new Error("CLI help smoke check failed");
  }

  const reportedVersion = versionResult.stdout.trim();
  if (reportedVersion !== String(packageJson.version)) {
    throw new Error(`CLI version mismatch\nExpected: ${packageJson.version}\nActual: ${reportedVersion}`);
  }

  process.stdout.write("CLI smoke OK (--help, --version)\n");
}

try {
  verifyPackContents();
  verifyCliSmoke();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
