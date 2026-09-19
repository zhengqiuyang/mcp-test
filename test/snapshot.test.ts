import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_VERSION } from "../src/diff.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CLI = path.join(REPO, "dist", "src", "cli.js");
const SERVER = path.join(REPO, "example", "server.js");
// The ref parser must survive a quoted path (and this exercises it end-to-end).
const SERVER_REF = `"${process.execPath}" "${SERVER}"`;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface JsonFinding {
  kind: string;
  reason: string;
}

interface JsonToolChange {
  tool: string;
  kind: string;
  findings: JsonFinding[];
}

interface JsonReport {
  exitCode: number;
  old: { kind: string };
  new: { kind: string; serverInfo: { name?: string; version?: string } };
  tools: JsonToolChange[];
  counts: { breaking: number; additive: number; changed: number; unchanged: number };
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err !== null && typeof err.code !== "number") return reject(err); // spawn failure, not an exit code
        resolve({ code: err === null ? 0 : (err.code as number), stdout, stderr });
      },
    );
  });
}

const scratch = mkdtempSync(path.join(tmpdir(), "mcp-test-diff-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test("snapshot writes a valid, name-sorted, versioned snapshot to stdout", async () => {
  const run = await runCli(["snapshot", "--command", SERVER_REF]);
  assert.equal(run.code, 0, `stderr: ${run.stderr}`);

  const snapshot = JSON.parse(run.stdout);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(typeof snapshot.$schema, "string");
  assert.match(snapshot.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(snapshot.serverInfo, { name: "example-notes", version: "1.2.3" });
  assert.deepEqual(
    snapshot.tools.map((t: { name: string }) => t.name),
    ["echo", "read_notes"],
  );
  const echo = snapshot.tools[0];
  assert.equal(echo.inputSchema.type, "object");
  assert.deepEqual(Object.keys(echo.inputSchema.properties).sort(), ["loud", "message"]);
  assert.deepEqual(echo.inputSchema.required, ["message"]);
});

test("snapshot -o writes the file and a summary line on stderr", async () => {
  const out = path.join(scratch, "v1.json");
  const run = await runCli(["snapshot", "--command", SERVER_REF, "-o", out]);
  assert.equal(run.code, 0, `stderr: ${run.stderr}`);
  assert.equal(run.stdout, "");

  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.version, SNAPSHOT_VERSION);
  assert.deepEqual(
    written.tools.map((t: { name: string }) => t.name),
    ["echo", "read_notes"],
  );
  assert.match(run.stderr, /snapshot written to .*v1\.json/);
  assert.match(run.stderr, /2 tools from example-notes 1\.2\.3/);
});

test("diff snapshot(v1) vs live(v2) finds the expected breaking/additive/changed verdicts", async () => {
  const out = path.join(scratch, "v1-for-diff.json");
  assert.equal((await runCli(["snapshot", "--command", SERVER_REF, "-o", out])).code, 0);

  const run = await runCli(
    ["diff", "--snapshot", out, "--new", SERVER_REF, "--format", "json"],
    { MCP_EXAMPLE_V2: "1" },
  );
  assert.equal(run.code, 1, `expected the breaking diff to exit 1; stderr: ${run.stderr}`);

  const report: JsonReport = JSON.parse(run.stdout);
  assert.equal(report.exitCode, 1);
  assert.equal(report.old.kind, "snapshot");
  assert.equal(report.new.kind, "live");
  assert.deepEqual(report.new.serverInfo, { name: "example-notes", version: "2.0.0" });

  const byName = new Map(report.tools.map((t) => [t.tool, t] as const));
  const readNotes = byName.get("read_notes") as JsonToolChange;
  assert.equal(readNotes.kind, "breaking");
  assert.ok(
    readNotes.findings.some((f) => f.reason === '+required prop "limit"'),
    `read_notes findings: ${JSON.stringify(readNotes.findings)}`,
  );

  const notesSearch = byName.get("notes.search") as JsonToolChange;
  assert.equal(notesSearch.kind, "additive");
  assert.deepEqual(notesSearch.findings, [{ kind: "additive", reason: "tool added" }]);

  const echo = byName.get("echo") as JsonToolChange;
  assert.equal(echo.kind, "breaking");
  assert.ok(echo.findings.some((f) => f.kind === "breaking" && /type boolean → string/.test(f.reason)));
  assert.ok(echo.findings.some((f) => f.kind === "changed" && f.reason === "description changed"));

  assert.equal(report.counts.breaking, 2);
  assert.equal(report.counts.additive, 1);
  assert.equal(report.counts.changed, 2); // tool description + prop "loud" description
  assert.equal(report.counts.unchanged, 0);

  // The console format names the same verdicts (spot-check through one more run).
  const consoleRun = await runCli(["diff", "--snapshot", out, "--new", SERVER_REF], { MCP_EXAMPLE_V2: "1" });
  assert.equal(consoleRun.code, 1);
  assert.match(consoleRun.stdout, /\+required prop "limit"/);
  assert.match(consoleRun.stdout, /notes\.search\s+tool added/);
  assert.match(consoleRun.stdout, /2 breaking · 1 additive · 2 changed · 0 unchanged/);
});

test("diff v1 vs v1 (both live, or snapshot vs live) is clean and exits 0", async () => {
  const liveRun = await runCli(["diff", "--old", SERVER_REF, "--new", SERVER_REF, "--format", "json"]);
  assert.equal(liveRun.code, 0, `stderr: ${liveRun.stderr}`);
  const liveReport: JsonReport = JSON.parse(liveRun.stdout);
  assert.deepEqual(liveReport.counts, { breaking: 0, additive: 0, changed: 0, unchanged: 2 });
  assert.deepEqual(liveReport.tools, []);

  const out = path.join(scratch, "v1-clean.json");
  await runCli(["snapshot", "--command", SERVER_REF, "-o", out]);
  const strictRun = await runCli(["diff", "--snapshot", out, "--new", SERVER_REF, "--fail-on", "additive"]);
  assert.equal(strictRun.code, 0, `stderr: ${strictRun.stderr}`);
  assert.match(strictRun.stdout, /0 breaking · 0 additive · 0 changed · 2 unchanged/);
});

test("an unreachable --new side is a clean harness error (exit 2), not a diff verdict", async () => {
  const out = path.join(scratch, "v1-error.json");
  await runCli(["snapshot", "--command", SERVER_REF, "-o", out]);

  const run = await runCli(["diff", "--snapshot", out, "--new", "mcp-test-no-such-command-xyz"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /cannot connect to the new server/);
  assert.doesNotMatch(run.stdout, /breaking/);
});

test("bad diff usage and unreadable snapshots exit 2 with guidance", async () => {
  const noArgs = await runCli(["diff"]);
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.stderr, /--old <ref> or --snapshot <path>/);

  const bothSides = await runCli(["diff", "--old", "node a.js", "--snapshot", "x.json", "--new", "node b.js"]);
  assert.equal(bothSides.code, 2);
  assert.match(bothSides.stderr, /mutually exclusive/);

  const missingSnapshot = await runCli(["diff", "--snapshot", path.join(scratch, "nope.json"), "--new", SERVER_REF]);
  assert.equal(missingSnapshot.code, 2);
  assert.match(missingSnapshot.stderr, /cannot read snapshot file/);

  const badVersion = path.join(scratch, "wrong-version.json");
  writeFileSync(badVersion, JSON.stringify({ version: 99, tools: [] }));
  const wrongVersion = await runCli(["diff", "--snapshot", badVersion, "--new", SERVER_REF]);
  assert.equal(wrongVersion.code, 2);
  assert.match(wrongVersion.stderr, /version 99/);
});
