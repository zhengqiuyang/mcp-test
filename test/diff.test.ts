import test from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_VERSION,
  buildDiffOutcome,
  buildSnapshot,
  deepSortKeys,
  diffSnapshots,
  type DiffSide,
  type Finding,
  type Snapshot,
  type SnapshotTool,
} from "../src/diff.js";

function snap(tools: SnapshotTool[]): Snapshot {
  return {
    $schema: "https://example.com/snapshot-v1.json",
    version: SNAPSHOT_VERSION,
    capturedAt: "2026-09-19T00:00:00.000Z",
    serverInfo: { name: "unit", version: "1.0.0" },
    tools: [...tools].sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

function tool(name: string, inputSchema?: Record<string, unknown>, description?: string): SnapshotTool {
  return description === undefined ? { name, inputSchema } : { name, description, inputSchema };
}

function findingsFor(diff: ReturnType<typeof diffSnapshots>, toolName: string): Finding[] {
  const entry = diff.tools.find((t) => t.tool === toolName);
  return entry ? entry.findings : [];
}

const objectSchema = (properties: Record<string, unknown>, required?: string[]): Record<string, unknown> =>
  required === undefined ? { type: "object", properties } : { type: "object", properties, required };

// ---------------------------------------------------------------------------
// tool-level changes
// ---------------------------------------------------------------------------

test("tool removed is breaking; tool added is additive; both are listed sorted", () => {
  const oldSnap = snap([tool("alpha"), tool("beta"), tool("gamma")]);
  const newSnap = snap([tool("alpha"), tool("delta"), tool("gamma")]);
  const diff = diffSnapshots(oldSnap, newSnap);

  assert.deepEqual(
    diff.tools.map((t) => [t.tool, t.status, t.kind]),
    [
      ["beta", "removed", "breaking"],
      ["delta", "added", "additive"],
    ],
  );
  assert.deepEqual(diff.counts, { breaking: 1, additive: 1, changed: 0, unchanged: 2 });
});

test("identical snapshots classify everything as unchanged", () => {
  const oldSnap = snap([tool("echo", objectSchema({ message: { type: "string" } }, ["message"]), "Hello.")]);
  const diff = diffSnapshots(oldSnap, snap([...oldSnap.tools]));
  assert.deepEqual(diff.tools, []);
  assert.deepEqual(diff.counts, { breaking: 0, additive: 0, changed: 0, unchanged: 1 });
});

// ---------------------------------------------------------------------------
// property-level changes
// ---------------------------------------------------------------------------

test("a required property added is breaking with the canonical reason text", () => {
  const oldSnap = snap([tool("read_notes", objectSchema({ note: { type: "string" } }))]);
  const newSnap = snap([tool("read_notes", objectSchema({ note: { type: "string" }, limit: { type: "integer" } }, ["limit"]))]);
  const diff = diffSnapshots(oldSnap, newSnap);

  assert.deepEqual(findingsFor(diff, "read_notes"), [{ kind: "breaking", reason: '+required prop "limit"' }]);
  assert.equal(diff.counts.breaking, 1);
});

test("a required property becoming optional is additive", () => {
  const oldSnap = snap([tool("t", objectSchema({ a: { type: "string" } }, ["a"]))]);
  const newSnap = snap([tool("t", objectSchema({ a: { type: "string" } }))]);
  const diff = diffSnapshots(oldSnap, newSnap);

  assert.deepEqual(findingsFor(diff, "t"), [{ kind: "additive", reason: 'prop "a" is no longer required' }]);
});

test("a removed property is breaking when it was required, informational when optional", () => {
  const oldSnap = snap([tool("t", objectSchema({ req: { type: "string" }, opt: { type: "string" } }, ["req"]))]);
  const newSnap = snap([tool("t", objectSchema({}))]);
  const diff = diffSnapshots(oldSnap, newSnap);

  const kinds = findingsFor(diff, "t").map((f) => `${f.kind}: ${f.reason}`).sort();
  assert.deepEqual(kinds, ['breaking: required prop "req" removed', 'changed: -optional prop "opt" (informational)']);
});

test("a property type change is breaking; integer widened to number is additive", () => {
  const oldSnap = snap([
    tool("loud-tool", objectSchema({ loud: { type: "boolean" }, count: { type: "integer" } })),
  ]);
  const newSnap = snap([
    tool("loud-tool", objectSchema({ loud: { type: "string" }, count: { type: "number" } })),
  ]);
  const diff = diffSnapshots(oldSnap, newSnap);

  assert.deepEqual(findingsFor(diff, "loud-tool"), [
    { kind: "breaking", reason: 'prop "loud": type boolean → string' },
    { kind: "additive", reason: 'prop "count": type integer → number (widening)' },
  ]);
});

test("the root schema type changing from object to something else is breaking", () => {
  const oldSnap = snap([tool("t", { type: "object", properties: { a: { type: "string" } }, required: ["a"] })]);
  const newSnap = snap([tool("t", { type: "array" })]);
  const diff = diffSnapshots(oldSnap, newSnap);

  assert.deepEqual(findingsFor(diff, "t"), [
    { kind: "breaking", reason: "type object → array" },
    { kind: "breaking", reason: 'required prop "a" removed' },
  ]);
});

test("enum narrowed is breaking, enum widened is additive, reorder alone is nothing", () => {
  const base = { mode: { type: "string", enum: ["fast", "slow"] } };
  const narrowed = { mode: { type: "string", enum: ["fast"] } };
  const widened = { mode: { type: "string", enum: ["fast", "slow", "turbo"] } };
  const reordered = { mode: { type: "string", enum: ["slow", "fast"] } };

  const narrowedDiff = diffSnapshots(snap([tool("t", objectSchema(base))]), snap([tool("t", objectSchema(narrowed))]));
  assert.deepEqual(findingsFor(narrowedDiff, "t"), [{ kind: "breaking", reason: 'prop "mode": enum value "slow" removed' }]);

  const widenedDiff = diffSnapshots(snap([tool("t", objectSchema(base))]), snap([tool("t", objectSchema(widened))]));
  assert.deepEqual(findingsFor(widenedDiff, "t"), [{ kind: "additive", reason: 'prop "mode": enum value "turbo" added' }]);

  const reorderedDiff = diffSnapshots(snap([tool("t", objectSchema(base))]), snap([tool("t", objectSchema(reordered))]));
  assert.deepEqual(reorderedDiff.counts, { breaking: 0, additive: 0, changed: 0, unchanged: 1 });
});

test("adding an enum to an unconstrained property is breaking; removing the enum is additive", () => {
  const unconstrained = { mode: { type: "string" } };
  const constrained = { mode: { type: "string", enum: ["fast", "slow"] } };

  const toConstrained = diffSnapshots(snap([tool("t", objectSchema(unconstrained))]), snap([tool("t", objectSchema(constrained))]));
  assert.deepEqual(findingsFor(toConstrained, "t"), [
    { kind: "breaking", reason: 'prop "mode": enum constraint added ("fast" | "slow"); previously any value was accepted' },
  ]);

  const toUnconstrained = diffSnapshots(snap([tool("t", objectSchema(constrained))]), snap([tool("t", objectSchema(unconstrained))]));
  assert.deepEqual(findingsFor(toUnconstrained, "t"), [
    { kind: "additive", reason: 'prop "mode": enum constraint removed (was "fast" | "slow")' },
  ]);
});

test("description-only changes are CHANGED, never additive or breaking", () => {
  const oldSnap = snap([tool("t", objectSchema({ a: { type: "string", description: "old" } }), "Old description.")]);
  const newSnap = snap([tool("t", objectSchema({ a: { type: "string", description: "new" } }), "New description.")]);
  const diff = diffSnapshots(oldSnap, newSnap);

  const entry = diff.tools.find((x) => x.tool === "t");
  assert.equal(entry?.kind, "changed");
  assert.deepEqual(entry?.findings, [
    { kind: "changed", reason: "description changed" },
    { kind: "changed", reason: 'prop "a": description changed' },
  ]);
  assert.equal(diff.counts.breaking, 0);
  assert.equal(diff.counts.additive, 0);
  assert.equal(diff.counts.changed, 2);
});

test("nested properties are compared recursively with dotted paths", () => {
  const oldSnap = snap([
    tool("search", objectSchema({ opts: { type: "object", properties: { q: { type: "string" } } } })),
  ]);
  const newSnap = snap([
    tool("search", objectSchema({ opts: { type: "object", properties: { q: { type: "string" }, tag: { type: "string" } }, required: ["tag"] } })),
  ]);
  const diff = diffSnapshots(oldSnap, newSnap);

  assert.deepEqual(findingsFor(diff, "search"), [
    { kind: "breaking", reason: '+required prop "tag" (under "opts")' },
  ]);
});

test("a tool's worst finding determines its kind, findings are ordered most-severe-first", () => {
  const oldSnap = snap([tool("t", objectSchema({ a: { type: "string", description: "old" } }), "Old.")]);
  const newSnap = snap([tool("t", objectSchema({ a: { type: "number", description: "new" } }), "New.")]);
  const diff = diffSnapshots(oldSnap, newSnap);

  const entry = diff.tools.find((x) => x.tool === "t");
  assert.equal(entry?.kind, "breaking");
  assert.deepEqual(
    entry?.findings.map((f) => f.kind),
    ["breaking", "changed", "changed"],
  );
});

// ---------------------------------------------------------------------------
// outcome + snapshot normalization
// ---------------------------------------------------------------------------

test("buildDiffOutcome gates on breaking by default and on additive with --fail-on additive", () => {
  const oldSnap = snap([tool("t", objectSchema({}))]);
  const newSnap = snap([tool("t", objectSchema({})), tool("new-tool")]);
  const oldSide: DiffSide = { source: "old.json", kind: "snapshot", serverInfo: {} };
  const newSide: DiffSide = { source: "node server.js", kind: "live", serverInfo: {} };

  const defaultOutcome = buildDiffOutcome(oldSnap, newSnap, oldSide, newSide, { failOn: "breaking" });
  assert.equal(defaultOutcome.exitCode, 0); // additive alone does not gate

  const strictOutcome = buildDiffOutcome(oldSnap, newSnap, oldSide, newSide, { failOn: "additive" });
  assert.equal(strictOutcome.exitCode, 1);

  const breakingOutcome = buildDiffOutcome(oldSnap, snap([tool("other")]), oldSide, newSide, { failOn: "breaking" });
  assert.equal(breakingOutcome.exitCode, 1);
});

test("buildSnapshot sorts tools by name and deep-sorts schema keys for stable output", () => {
  const built = buildSnapshot(
    [
      { name: "zeta", inputSchema: { type: "object", properties: { b: { type: "string" }, a: { type: "string" } } } },
      { name: "alpha", description: "first" },
    ],
    { serverInfo: { name: "srv", version: "9.9.9" }, protocolVersion: "2025-06-18", command: "node srv.js" },
  );

  assert.deepEqual(built.tools.map((t) => t.name), ["alpha", "zeta"]);
  assert.deepEqual(Object.keys(built.tools[1].inputSchema as object), ["properties", "type"]);
  assert.deepEqual(Object.keys((built.tools[1].inputSchema as { properties: object }).properties), ["a", "b"]);
  assert.equal(built.version, SNAPSHOT_VERSION);
  assert.equal(built.protocolVersion, "2025-06-18");
  assert.match(built.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("deepSortKeys leaves arrays' contents sorted recursively but not reordered", () => {
  assert.deepEqual(deepSortKeys({ b: [2, 1], a: { d: 1, c: 2 } }), { a: { c: 2, d: 1 }, b: [2, 1] });
  assert.deepEqual(deepSortKeys([{ y: 1, x: 2 }]), [{ x: 2, y: 1 }]);
});
