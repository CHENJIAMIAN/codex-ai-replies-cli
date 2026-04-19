import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const releaseScriptPath = path.join(repoRoot, "scripts", "release-check.js");
const finalReleaseScriptPath = path.join(repoRoot, "scripts", "final-release.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-ai-replies-release-"));
}

function writeCommandShim(filePath, lines) {
  fs.writeFileSync(filePath, `${lines.join("\r\n")}\r\n`, "utf8");
}

function runFinalReleaseWithShims({
  gitResponses,
  npmResponses,
  gitBin = "git.cmd",
  npmBin = "npm.cmd"
}) {
  const tempDir = makeTempDir();
  const shimDir = path.join(tempDir, "bin");
  const gitLogPath = path.join(tempDir, "git.log");
  const npmLogPath = path.join(tempDir, "npm.log");
  const gitStatePath = path.join(tempDir, "git-state.json");
  const npmStatePath = path.join(tempDir, "npm-state.json");

  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(gitStatePath, JSON.stringify(gitResponses), "utf8");
  fs.writeFileSync(npmStatePath, JSON.stringify(npmResponses), "utf8");

  writeCommandShim(path.join(shimDir, "git.cmd"), [
    "@echo off",
    `echo %*>> "${gitLogPath}"`,
    `node -e "const fs=require('fs'); const statePath=process.argv[1]; const key=process.argv.slice(2).join(' '); const state=JSON.parse(fs.readFileSync(statePath,'utf8')); const response=state[key]; if(!response){console.error('missing git response for '+key); process.exit(97);} if(response.stdout){process.stdout.write(response.stdout);} if(response.stderr){process.stderr.write(response.stderr);} process.exit(response.status ?? 0);" "${gitStatePath}" %*`
  ]);

  writeCommandShim(path.join(shimDir, "npm.cmd"), [
    "@echo off",
    `echo %*>> "${npmLogPath}"`,
    `node -e "const fs=require('fs'); const statePath=process.argv[1]; const key=process.argv.slice(2).join(' '); const state=JSON.parse(fs.readFileSync(statePath,'utf8')); const response=state[key]; if(!response){console.error('missing npm response for '+key); process.exit(98);} if(response.stdout){process.stdout.write(response.stdout);} if(response.stderr){process.stderr.write(response.stderr);} process.exit(response.status ?? 0);" "${npmStatePath}" %*`
  ]);

  const result = spawnSync(process.execPath, [finalReleaseScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_GIT_BIN: gitBin,
      RELEASE_NPM_BIN: npmBin,
      PATH: `${shimDir};${process.env.PATH ?? ""}`
    }
  });

  return {
    result,
    gitLog: fs.existsSync(gitLogPath) ? fs.readFileSync(gitLogPath, "utf8") : "",
    npmLog: fs.existsSync(npmLogPath) ? fs.readFileSync(npmLogPath, "utf8") : ""
  };
}

test("package.json exposes release verification as a separate script", () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  assert.equal(packageJson.scripts["test:release"], "node scripts/release-check.js");
});

test("package.json exposes the final release workflow as a separate script", () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  assert.equal(packageJson.scripts["release:final"], "node scripts/final-release.js");
});

test("release verification checks pack contents and current-source CLI smoke", () => {
  const result = spawnSync(process.execPath, [releaseScriptPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /Pack contents OK/);
  assert.match(result.stdout, /CLI smoke OK/);
  assert.match(result.stdout, /--help/);
  assert.match(result.stdout, /--version/);
  assert.equal(result.stderr, "");
});

test("final release workflow fails fast when the worktree is dirty", () => {
  const { result, gitLog, npmLog } = runFinalReleaseWithShims({
    gitResponses: {
      "status --short": { status: 0, stdout: " M package.json\n?? notes.txt\n" }
    },
    npmResponses: {}
  });

  assert.notEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /Working tree is not clean/);
  assert.match(result.stderr, /M package\.json/);
  assert.match(gitLog, /status --short/);
  assert.equal(npmLog, "");
});

test("final release workflow runs checks and prints exact next commands without executing them", () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const escapedVersion = packageJson.version.replaceAll(".", "\\.");

  const { result, gitLog, npmLog } = runFinalReleaseWithShims({
    gitResponses: {
      "status --short": { status: 0, stdout: "" },
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "release/candidate\n" },
      "rev-parse --short HEAD": { status: 0, stdout: "abc1234\n" }
    },
    npmResponses: {
      "test": { status: 0, stdout: "all tests passed\n" },
      "run test:release": { status: 0, stdout: "release checks passed\n" }
    }
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Final release checks passed/);
  assert.match(result.stdout, new RegExp(`Version: ${escapedVersion}`));
  assert.match(result.stdout, /Branch: release\/candidate/);
  assert.match(result.stdout, /Commit: abc1234/);
  assert.match(result.stdout, /Next commands:/);
  assert.match(result.stdout, /git push origin release\/candidate/);
  assert.match(result.stdout, new RegExp(`git tag v${escapedVersion}`));
  assert.match(result.stdout, new RegExp(`git push origin v${escapedVersion}`));
  assert.match(result.stdout, /npm publish/);
  assert.doesNotMatch(result.stdout, /published/);
  assert.match(gitLog, /status --short/);
  assert.match(gitLog, /rev-parse --abbrev-ref HEAD/);
  assert.match(gitLog, /rev-parse --short HEAD/);
  assert.match(npmLog, /^test/m);
  assert.match(npmLog, /^run test:release/m);
});

test("final release workflow can invoke npm through the standard Windows npm shim name", () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const escapedVersion = packageJson.version.replaceAll(".", "\\.");

  const { result, gitLog, npmLog } = runFinalReleaseWithShims({
    gitResponses: {
      "status --short": { status: 0, stdout: "" },
      "rev-parse --abbrev-ref HEAD": { status: 0, stdout: "release/candidate\n" },
      "rev-parse --short HEAD": { status: 0, stdout: "abc1234\n" }
    },
    npmResponses: {
      "test": { status: 0, stdout: "all tests passed\n" },
      "run test:release": { status: 0, stdout: "release checks passed\n" }
    },
    npmBin: "npm"
  });

  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Final release checks passed/);
  assert.match(result.stdout, new RegExp(`Version: ${escapedVersion}`));
  assert.match(gitLog, /status --short/);
  assert.match(npmLog, /^test/m);
  assert.match(npmLog, /^run test:release/m);
});
