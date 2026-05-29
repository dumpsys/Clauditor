import { spawn } from "child_process";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Authenticate via http.extraHeader so the token never lands in the remote URL
 * (and thus never in `.git/config` or `git remote -v`).
 */
function authHeaderArgs() {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is required for git operations");
  const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

export const gitOperations = {
  /**
   * Clone a repo and checkout a specific branch into workDir.
   */
  async clone(repoUrl, workDir, branch) {
    logger.info(`Cloning branch '${branch}'...`);

    await run("git", [
      ...authHeaderArgs(),
      "clone",
      "--depth", "1",
      "--branch", branch,
      "--single-branch",
      repoUrl,
      workDir,
    ], { cwd: "/" });

    // Configure git identity for commits
    await run("git", ["config", "user.email", config.gitEmail], { cwd: workDir });
    await run("git", ["config", "user.name", config.gitName], { cwd: workDir });

    // Persist the auth header in this clone's local config so subsequent
    // pushes also authenticate without exposing the token in the URL.
    const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
    await run("git", ["config", "http.extraHeader", `Authorization: Basic ${basic}`], { cwd: workDir });
  },

  /**
   * Full clone (no --depth, no --single-branch) so Claude can run
   * `git diff origin/<base>...HEAD` locally during a review.
   * Checks out the head branch.
   */
  async cloneForReview(repoUrl, workDir, headBranch, baseBranch) {
    logger.info(`Cloning '${headBranch}' (with base '${baseBranch}' available)...`);

    await run("git", [
      ...authHeaderArgs(),
      "clone",
      "--branch", headBranch,
      repoUrl,
      workDir,
    ], { cwd: "/" });

    // Make sure the base branch ref exists locally as `origin/<baseBranch>`.
    // A standard clone (without --single-branch) already fetches all remote
    // refs, but we run an explicit fetch in case the default behavior changed.
    await run("git", ["fetch", "origin", baseBranch], { cwd: workDir });

    await run("git", ["config", "user.email", config.gitEmail], { cwd: workDir });
    await run("git", ["config", "user.name", config.gitName], { cwd: workDir });

    const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
    await run("git", ["config", "http.extraHeader", `Authorization: Basic ${basic}`], { cwd: workDir });
  },

  /**
   * Clone the base branch and create a new local branch on top of it.
   * Used by the Sentry handler when no existing fix branch is found.
   * The new branch is NOT pushed yet — that happens in commitAndPush.
   */
  async cloneAndCreateBranch(repoUrl, workDir, baseBranch, newBranch) {
    logger.info(`Cloning base '${baseBranch}' and creating '${newBranch}'...`);

    await run("git", [
      ...authHeaderArgs(),
      "clone",
      "--depth", "1",
      "--branch", baseBranch,
      "--single-branch",
      repoUrl,
      workDir,
    ], { cwd: "/" });

    await run("git", ["checkout", "-b", newBranch], { cwd: workDir });

    await run("git", ["config", "user.email", config.gitEmail], { cwd: workDir });
    await run("git", ["config", "user.name", config.gitName], { cwd: workDir });

    const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
    await run("git", ["config", "http.extraHeader", `Authorization: Basic ${basic}`], { cwd: workDir });
  },

  /**
   * Push a freshly-created local branch, setting upstream. Distinct from
   * commitAndPush — used when the branch is brand new and no commit has
   * been made yet (e.g. we want the branch to exist before opening a PR).
   * Most callers won't need this; commitAndPush handles the common case.
   */
  async pushNewBranch(workDir, branch) {
    await run("git", ["push", "-u", "origin", branch], { cwd: workDir });
  },

  /**
   * Stage all changes, commit, and push. Returns the commit SHA.
   */
  async commitAndPush(workDir, branch, message) {
    const status = await runOutput("git", ["status", "--porcelain"], { cwd: workDir });
    if (!status.trim()) {
      throw new Error("Claude Code made no file changes despite marking feedback as actionable");
    }

    logger.info(`Files changed:\n${status}`);

    await run("git", ["add", "-A"], { cwd: workDir });
    await run("git", ["commit", "-m", message], { cwd: workDir });
    await run("git", ["push", "origin", branch], { cwd: workDir });

    const sha = (await runOutput("git", ["rev-parse", "HEAD"], { cwd: workDir })).trim();
    logger.info(`Pushed commit ${sha} to ${branch}`);
    return sha;
  },
};

/**
 * Run a subprocess to completion, returning { stdout, stderr } on success
 * and rejecting with a descriptive Error on non-zero exit / spawn failure.
 *
 * IMPORTANT: this used to call `spawnSync`, which blocked the entire Node
 * event loop for the duration of the subprocess. A `git clone` that took
 * 30 s would stall every concurrent HTTP request (Sentry webhooks would
 * pile up and time out — that's the exact bug this async port fixes).
 * The async version lets the event loop keep handling requests while git
 * is running.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));
    proc.on("error", (err) => reject(new Error(`${cmd} error: ${err.message}`)));
    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        return reject(new Error(`${cmd} ${args.join(" ")} failed (exit ${code}):\n${stderr}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runOutput(cmd, args, opts = {}) {
  const { stdout } = await run(cmd, args, opts);
  return stdout;
}
