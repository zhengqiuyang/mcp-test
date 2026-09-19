import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { renderGithub, renderJson } from "../src/report.js";
import { runAll } from "../src/runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONFIG = path.resolve(HERE, "../../example/mcp-test.yaml");

test("a full run against the example config: functional passes + real leaks caught", async () => {
  const loaded = loadConfig(EXAMPLE_CONFIG);
  const result = await runAll(loaded.config, { configPath: loaded.path });

  // Functional phase: all 3 tests pass against the real server over stdio.
  assert.equal(result.summary.functionalTotal, 3);
  assert.equal(result.summary.functionalPassed, 3);
  assert.equal(result.summary.functionalFailed, 0);
  assert.equal(result.summary.functionalErrored, 0);
  for (const test of result.functional) {
    assert.equal(test.status, "pass");
    assert.ok(typeof test.latencyMs === "number");
  }

  // Security phase: the vulnerable server genuinely leaks via read_notes.
  const leakIds = result.security.filter((s) => s.verdict === "leak").map((s) => s.probeId);
  assert.ok(leakIds.length >= 2, `expected at least 2 leaks, got [${leakIds.join(", ")}]`);
  assert.ok(leakIds.includes("env-exfiltration"), "env-exfiltration should fire on the env dump");
  assert.ok(
    leakIds.includes("ssh-key-exfil") || leakIds.includes("reveal-system-prompt"),
    "ssh-key-exfil or reveal-system-prompt should fire",
  );
  const sshLeak = result.security.find((s) => s.probeId === "ssh-key-exfil");
  assert.match(sshLeak?.evidence ?? "", /BEGIN OPENSSH PRIVATE KEY/);
  const envLeak = result.security.find((s) => s.probeId === "env-exfiltration");
  assert.match(envLeak?.evidence ?? "", /environment variable dump/);

  assert.equal(result.summary.exitCode, 1);
});

test("json format output is valid, CI-parseable JSON with the full results", async () => {
  const loaded = loadConfig(EXAMPLE_CONFIG);
  const result = await runAll(loaded.config, { configPath: loaded.path, only: "security" });
  const parsed = JSON.parse(renderJson(result)) as {
    summary: { leaks: number; exitCode: number };
    security: Array<{ probeId: string; verdict: string }>;
  };
  assert.ok(parsed.summary.leaks >= 2);
  assert.equal(parsed.summary.exitCode, 1);
  assert.ok(parsed.security.length >= 8);
});

test("github format renders ::error annotations for leaks", async () => {
  const loaded = loadConfig(EXAMPLE_CONFIG);
  const result = await runAll(loaded.config, { configPath: loaded.path, only: "security" });
  const annotations = renderGithub(result, { configPath: "example/mcp-test.yaml", configText: loaded.text });
  const lines = annotations.trim().split("\n");
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.match(line, /^::error file=example\/mcp-test\.yaml/);
  }
  assert.ok(lines.some((line) => line.includes("LEAK")));
});

test("--only functional skips probes and exits clean when everything passes", async () => {
  const loaded = loadConfig(EXAMPLE_CONFIG);
  const result = await runAll(loaded.config, { configPath: loaded.path, only: "functional" });
  assert.equal(result.security.length, 0);
  assert.equal(result.summary.functionalPassed, 3);
  assert.equal(result.summary.exitCode, 0);
});
