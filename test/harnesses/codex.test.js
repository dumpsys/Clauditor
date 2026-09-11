import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const { buildCodexArgs, parseCodexDecision } = await import("../../src/harnesses/codex.js");
const {
  commentDecisionSchema,
  triageDecisionSchema,
  sentryDecisionSchema,
} = await import("../../src/harnesses/schemas.js");

describe("Codex CLI arguments", () => {
  test("uses an isolated, ephemeral workspace-write run for fixes", () => {
    const args = buildCodexArgs({
      sandbox: "workspace-write",
      schemaPath: "/tmp/decision.schema.json",
    });

    assert.deepEqual(args.slice(0, 2), ["exec", "--ephemeral"]);
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("--ignore-rules"));
    assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), [
      "--sandbox",
      "workspace-write",
    ]);
    assert.deepEqual(
      args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2),
      ["--output-schema", "/tmp/decision.schema.json"],
    );
    assert.ok(args.includes('shell_environment_policy.inherit="core"'));
    assert.ok(args.includes("shell_environment_policy.ignore_default_excludes=false"));
    assert.ok(args.includes("project_doc_max_bytes=0"));
    assert.ok(args.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
    assert.ok(args.includes("sandbox_workspace_write.exclude_slash_tmp=true"));
    assert.ok(!args.includes("--ask-for-approval"));
    assert.equal(args.at(-1), "-");
  });

  test("uses read-only mode and skips the repo check only for triage", () => {
    const args = buildCodexArgs({ sandbox: "read-only", skipGitRepoCheck: true });
    assert.ok(args.includes("read-only"));
    assert.ok(args.includes("--skip-git-repo-check"));
    assert.ok(!args.includes("--output-schema"));
  });
});

describe("Codex structured decisions", () => {
  test("parses the schema-constrained JSON object", () => {
    assert.deepEqual(parseCodexDecision('  {"skip":false,"reason":"review it"}\n'), {
      skip: false,
      reason: "review it",
    });
  });

  test("rejects invalid JSON and non-object JSON", () => {
    assert.throws(() => parseCodexDecision("not json"), /invalid structured output/);
    assert.throws(() => parseCodexDecision("[]"), /expected a JSON object/);
  });

  test("schemas are strict and require every downstream field", () => {
    for (const schema of [commentDecisionSchema, triageDecisionSchema, sentryDecisionSchema]) {
      assert.equal(schema.type, "object");
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    }
    assert.deepEqual(sentryDecisionSchema.properties.confidence.enum, ["high", "medium", "low"]);
  });
});
