import { spawnSync } from "child_process";
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
  clone(repoUrl, workDir, branch) {
    logger.info(`Cloning branch '${branch}'...`);

    run("git", [
      ...authHeaderArgs(),
      "clone",
      "--depth", "1",
      "--branch", branch,
      "--single-branch",
      repoUrl,
      workDir,
    ], { cwd: "/" });

    // Configure git identity for commits
    run("git", ["config", "user.email", config.gitEmail], { cwd: workDir });
    run("git", ["config", "user.name", config.gitName], { cwd: workDir });

    // Persist the auth header in this clone's local config so subsequent
    // pushes also authenticate without exposing the token in the URL.
    const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
    run("git", ["config", "http.extraHeader", `Authorization: Basic ${basic}`], { cwd: workDir });
  },

  /**
   * Stage all changes, commit, and push. Returns the commit SHA.
   */
  commitAndPush(workDir, branch, message) {
    const status = runOutput("git", ["status", "--porcelain"], { cwd: workDir });
    if (!status.trim()) {
      throw new Error("Claude Code made no file changes despite marking feedback as actionable");
    }

    logger.info(`Files changed:\n${status}`);

    run("git", ["add", "-A"], { cwd: workDir });
    run("git", ["commit", "-m", message], { cwd: workDir });
    run("git", ["push", "origin", branch], { cwd: workDir });

    const sha = runOutput("git", ["rev-parse", "HEAD"], { cwd: workDir }).trim();
    logger.info(`Pushed commit ${sha} to ${branch}`);
    return sha;
  },
};

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { ...opts, encoding: "utf-8" });
  if (result.error) throw new Error(`${cmd} error: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr}`);
  }
  return result;
}

function runOutput(cmd, args, opts = {}) {
  return run(cmd, args, opts).stdout;
}
