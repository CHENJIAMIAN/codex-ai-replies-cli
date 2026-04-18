import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const releaseScriptPath = path.join(repoRoot, "scripts", "release-check.js");

test("package.json exposes release verification as a separate script", () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  assert.equal(packageJson.scripts["test:release"], "node scripts/release-check.js");
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
