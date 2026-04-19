import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const gitBin = process.env.RELEASE_GIT_BIN || "git";
const npmBin = process.env.RELEASE_NPM_BIN || "npm";

function run(command, args) {
  const isCmdShim = /\.cmd$/i.test(command);
  const result = spawnSync(isCmdShim ? "cmd.exe" : command, isCmdShim ? ["/d", "/s", "/c", command, ...args] : args, {
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

  return String(result.stdout ?? "").trim();
}

function ensureCleanWorktree() {
  const output = run(gitBin, ["status", "--short"]);

  if (output) {
    throw new Error(`Working tree is not clean.\n${output}`);
  }
}

function readBranchName() {
  const branch = run(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"]);

  if (!branch || branch === "HEAD") {
    throw new Error("HEAD is detached. Check out the release branch before running the final release workflow.");
  }

  return branch;
}

function runChecks() {
  run(npmBin, ["test"]);
  run(npmBin, ["run", "test:release"]);
}

function printSummary(branch, commit) {
  const version = String(packageJson.version);
  const nextCommands = [
    `git push origin ${branch}`,
    `git tag v${version}`,
    `git push origin v${version}`,
    "npm publish"
  ];

  process.stdout.write("Final release checks passed\n");
  process.stdout.write(`Version: ${version}\n`);
  process.stdout.write(`Branch: ${branch}\n`);
  process.stdout.write(`Commit: ${commit}\n`);
  process.stdout.write("Checks run:\n");
  process.stdout.write("  npm test\n");
  process.stdout.write("  npm run test:release\n");
  process.stdout.write("Next commands:\n");
  for (const command of nextCommands) {
    process.stdout.write(`  ${command}\n`);
  }
}

try {
  ensureCleanWorktree();
  const branch = readBranchName();
  const commit = run(gitBin, ["rev-parse", "--short", "HEAD"]);
  runChecks();
  printSummary(branch, commit);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
