import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const execFileAsync = promisify(execFile);
const { gitOperations } = await import("../../src/services/git.js");

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("cloneForReview creates the fixed base ref used by review prompts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clauditor-git-test-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "clone");

  try {
    await fs.mkdir(source);
    await git(source, "init", "--initial-branch", "main");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test User");
    await fs.writeFile(path.join(source, "file.txt"), "base\n");
    await git(source, "add", "file.txt");
    await git(source, "commit", "-m", "base");
    const baseSha = await git(source, "rev-parse", "HEAD");

    await git(source, "checkout", "-b", "feature");
    await fs.writeFile(path.join(source, "file.txt"), "feature\n");
    await git(source, "commit", "-am", "feature");
    await git(root, "clone", "--bare", source, remote);

    await gitOperations.cloneForReview(remote, clone, "feature", "main");

    assert.equal(await git(clone, "rev-parse", "refs/clauditor/base"), baseSha);
    assert.equal(await git(clone, "diff", "--name-only", "refs/clauditor/base...HEAD"), "file.txt");
    await assert.rejects(
      () => git(clone, "config", "--get", "http.extraHeader"),
      /Command failed/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("authenticated git failures redact the GitHub credential", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clauditor-git-redaction-test-"));
  const encodedToken = Buffer.from("x-access-token:test-token").toString("base64");

  try {
    await git(root, "init");
    await assert.rejects(
      () => gitOperations.pushNewBranch(root, "test-branch"),
      (err) => {
        assert.match(err.message, /http\.extraHeader=Authorization: Basic <redacted>/);
        assert.doesNotMatch(err.message, /test-token/);
        assert.ok(!err.message.includes(encodedToken));
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
