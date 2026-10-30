import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPublicTree } from "../verify-public-tree.mjs";

test("batches existing tracked paths with NUL delimiters, including broken symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "concourse-public-tree-"));
  try {
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "--quiet");
    writeFileSync(join(root, ".gitignore"), "*.private\n");
    const names = ["space name.private", "line\nbreak.private", "missing.private", "ordinary.txt"];
    for (const name of names) writeFileSync(join(root, name), "test");
    symlinkSync("absent-target", join(root, "link.private"));
    git("add", "--force", ".");
    rmSync(join(root, "missing.private"));
    const calls = [];
    const forbidden = verifyPublicTree(root, (...args) => { calls.push(args); return spawnSync(...args); });
    assert.deepEqual(forbidden.sort(), ["line\nbreak.private", "link.private", "space name.private"].sort());
    assert.equal(calls.filter(([, args]) => args[0] === "check-ignore").length, 1);
    assert.ok(!calls[1][2].input.includes("missing.private"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("distinguishes a clean tree from scanner errors", () => {
  const tracked = { status: 0, stdout: "" };
  assert.deepEqual(verifyPublicTree(".", (_, args) => args[0] === "ls-files" ? tracked : { status: 1, stdout: "" }), []);
  assert.throws(() => verifyPublicTree(".", (_, args) => args[0] === "ls-files" ? tracked : { status: 128, stderr: "scanner failed" }), /ignore scan failed/);
  assert.throws(() => verifyPublicTree(".", () => ({ status: 128, stderr: "not a repository" })), /tracked-file scan failed/);
  assert.throws(() => verifyPublicTree(".", () => ({ error: new Error("spawn failed") })), /tracked-file scan failed/);
});
