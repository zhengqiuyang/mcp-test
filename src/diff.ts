/**
 * Schema-drift upgrade gate: snapshots and diffs of an MCP server's tool
 * surface (`tools/list`), classified as breaking / additive / changed.
 *
 * The snapshot is the interchange format — a small, versioned JSON file that
 * anyone can store (in git, in apm.lock.yaml, alongside mcp-lock.json, or via
 * a ToolPin-style pinner). `mcp-test diff` compares:
 *
 *   - a snapshot vs a live server (`--snapshot old.json --new "<ref>"`)
 *   - two live servers           (`--old "<ref>" --new "<ref>"`)
 *
 * A ref is a full server spec string (see src/refparse.ts); both sides are
 * spoken to over real stdio with the same McpStdioClient the test suites use.
 *
 * Classification (JSON Schema subset: type / properties / required / enum,
 * compared recursively through `properties`):
 *
 *   BREAKING  tool removed · required property added · required property
 *             removed · property type changed · enum narrowed (a previously
 *             valid value removed, or a new enum constraint on an
 *             unconstrained property) · schema type object → non-object
 *   ADDITIVE  tool added · optional property added · enum widened · integer
 *             type widened to number · a previously required property made
 *             optional
 *   CHANGED   description-only differences (cosmetic, never gates)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { McpClientError, McpStdioClient, type ToolInfo } from "./client.js";
import { parseRef, runnerHint, type ParsedRef } from "./refparse.js";
import { errMsg } from "./util.js";

// ---------------------------------------------------------------------------
// Snapshot interchange format (version 1)
// ---------------------------------------------------------------------------

/** Bump on any incompatible change to the snapshot shape; old files keep working within a version. */
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_SCHEMA_URI = "https://raw.githubusercontent.com/mcp-test/mcp-test/main/schemas/snapshot-v1.json";

export interface SnapshotTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface Snapshot {
  $schema: string;
  version: number;
  capturedAt: string;
  serverInfo: { name?: string; version?: string };
  /** The ref string the snapshot was captured from — informational, never parsed back. */
  command?: string;
  protocolVersion?: string;
  /** Sorted by tool name for stable diffs. */
  tools: SnapshotTool[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively sort object keys so two runs against the same server produce byte-identical snapshots. */
export function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSortKeys(value[key]);
    return out;
  }
  return value;
}

function normalizeTool(tool: ToolInfo): SnapshotTool {
  const out: SnapshotTool = { name: tool.name };
  if (tool.description !== undefined) out.description = tool.description;
  if (tool.inputSchema !== undefined) out.inputSchema = deepSortKeys(tool.inputSchema) as Record<string, unknown>;
  return out;
}

/** Build a snapshot (version 1, tools sorted by name) from a live client's tools/list. */
export function buildSnapshot(
  tools: ToolInfo[],
  meta: { serverInfo: { name?: string; version?: string } | null; protocolVersion: string | null; command?: string },
): Snapshot {
  const snapshot: Snapshot = {
    $schema: SNAPSHOT_SCHEMA_URI,
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    serverInfo: meta.serverInfo ?? {},
    tools: tools.map(normalizeTool).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  if (meta.command !== undefined) snapshot.command = meta.command;
  if (meta.protocolVersion !== null) snapshot.protocolVersion = meta.protocolVersion;
  return snapshot;
}

export function parseSnapshotFile(path: string): Snapshot {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new SnapshotError(`cannot read snapshot file "${path}": ${errMsg(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SnapshotError(`snapshot file "${path}" is not valid JSON: ${errMsg(err)}`);
  }
  if (!isRecord(raw)) throw new SnapshotError(`snapshot file "${path}" must contain a JSON object`);
  if (raw.version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `snapshot file "${path}" has version ${JSON.stringify(raw.version)}; this mcp-test reads snapshot version ${SNAPSHOT_VERSION}`,
    );
  }
  if (!Array.isArray(raw.tools)) throw new SnapshotError(`snapshot file "${path}" is missing a "tools" array`);
  const tools: SnapshotTool[] = [];
  for (const entry of raw.tools) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") {
      throw new SnapshotError(`snapshot file "${path}": every tool entry needs a non-empty string "name"`);
    }
    const tool: SnapshotTool = { name: entry.name };
    if (entry.description !== undefined) {
      if (typeof entry.description !== "string") throw new SnapshotError(`snapshot file "${path}": tool "${entry.name}" description must be a string`);
      tool.description = entry.description;
    }
    if (entry.inputSchema !== undefined) {
      if (!isRecord(entry.inputSchema)) throw new SnapshotError(`snapshot file "${path}": tool "${entry.name}" inputSchema must be an object`);
      tool.inputSchema = entry.inputSchema;
    }
    tools.push(tool);
  }
  const serverInfo = isRecord(raw.serverInfo) ? raw.serverInfo : {};
  const snapshot: Snapshot = {
    $schema: SNAPSHOT_SCHEMA_URI,
    version: SNAPSHOT_VERSION,
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "",
    serverInfo: {
      name: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
      version: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
    },
    tools: tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  if (typeof raw.command === "string") snapshot.command = raw.command;
  if (typeof raw.protocolVersion === "string") snapshot.protocolVersion = raw.protocolVersion;
  return snapshot;
}

export function writeSnapshotFile(path: string, snapshot: Snapshot): void {
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Live capture (spawn a server, handshake, paginated tools/list)
// ---------------------------------------------------------------------------

/**
 * Connect to the server named by a ref string and capture its tool surface.
 * Throws RefError (unparseable ref) or McpClientError (spawn/handshake/list
 * failure) — both meant to surface to the CLI as exit code 2.
 */
export async function captureLiveSnapshot(
  refString: string,
  options?: { timeoutMs?: number },
): Promise<{ snapshot: Snapshot; ref: ParsedRef }> {
  const ref = parseRef(refString);
  const client = new McpStdioClient({ command: ref.command, args: ref.args, env: {} }, { requestTimeoutMs: options?.timeoutMs });
  try {
    await client.connect();
    const tools = await client.listTools();
    return {
      snapshot: buildSnapshot(tools, {
        serverInfo: client.serverInfo,
        protocolVersion: client.protocolVersion,
        command: refString,
      }),
      ref,
    };
  } finally {
    await client.close();
  }
}

/** Render a capture/connect failure for the CLI: message + stderr tail + runner-specific hint. */
export function formatRefFailure(side: string, refString: string, err: unknown): string {
  const lines = [`cannot connect to the ${side} server ("${refString}"): ${errMsg(err)}`];
  if (err instanceof McpClientError && err.stderrTail && err.stderrTail.trim() !== "") {
    lines.push(`server stderr (tail):\n${err.stderrTail.trim()}`);
  }
  const hint = runnerHint(parseRefQuiet(refString)?.form ?? null);
  if (hint !== "") lines.push(hint);
  return lines.join("\n");
}

function parseRefQuiet(refString: string): ParsedRef | null {
  try {
    return parseRef(refString);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification (pure: two snapshots in, findings out)
// ---------------------------------------------------------------------------

export type FindingKind = "breaking" | "additive" | "changed";

export interface Finding {
  kind: FindingKind;
  reason: string;
}

export interface ToolChange {
  tool: string;
  /** removed = only in old; added = only in new; modified = in both, with findings. */
  status: "removed" | "added" | "modified";
  /** Worst finding kind for this tool (breaking > additive > changed). */
  kind: FindingKind;
  /** Every finding for this tool, most severe first. */
  findings: Finding[];
}

export interface DiffClassification {
  /** Only tools with at least one finding, sorted by tool name. */
  tools: ToolChange[];
  /** Finding counts by kind, plus tools that did not change at all. */
  counts: { breaking: number; additive: number; changed: number; unchanged: number };
}

const KIND_RANK: Record<FindingKind, number> = { breaking: 0, additive: 1, changed: 2 };

function worstKind(findings: Finding[]): FindingKind {
  let worst: FindingKind = "changed";
  for (const finding of findings) if (KIND_RANK[finding.kind] < KIND_RANK[worst]) worst = finding.kind;
  return worst;
}

function propLabel(propPath: string): string {
  return propPath === "" ? "" : `prop "${propPath}": `;
}

/** Normalize a schema `type` value to a list of accepted type names. */
function typeList(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((t) => typeof t === "string")) return v as string[];
  return null;
}

function describeTypes(types: string[]): string {
  return types.length === 1 ? types[0] : `(${types.join(" | ")})`;
}

/**
 * Compare two schema nodes (objects from inputSchema) of the SAME tool/property
 * position, appending findings. `propPath` is "" for a tool's root schema and
 * a dot path for nested properties.
 */
function compareSchemaNodes(
  oldNode: Record<string, unknown>,
  newNode: Record<string, unknown>,
  propPath: string,
  findings: Finding[],
): void {
  const label = propLabel(propPath);

  // --- type ---
  const oldTypes = typeList(oldNode.type);
  const newTypes = typeList(newNode.type);
  if (oldTypes !== null && newTypes !== null) {
    const dropped = oldTypes.filter((t) => !newTypes.includes(t));
    const added = newTypes.filter((t) => !oldTypes.includes(t));
    if (dropped.length === 1 && dropped[0] === "integer" && newTypes.includes("number") && added.every((t) => t === "number")) {
      // integer -> number is a widening: every previously valid value still is.
      findings.push({ kind: "additive", reason: `${label}type integer → number (widening)` });
    } else if (dropped.length > 0 || added.length > 0) {
      if (oldTypes.length === 1 && newTypes.length === 1) {
        findings.push({ kind: "breaking", reason: `${label}type ${oldTypes[0]} → ${newTypes[0]}` });
      } else {
        for (const t of dropped) findings.push({ kind: "breaking", reason: `${label}type no longer accepts "${t}" (now ${describeTypes(newTypes)})` });
        for (const t of added) findings.push({ kind: "additive", reason: `${label}type now also accepts "${t}"` });
      }
    }
  } else if (oldNode.type !== undefined && newNode.type !== undefined && oldNode.type !== newNode.type) {
    findings.push({ kind: "breaking", reason: `${label}type ${JSON.stringify(oldNode.type)} → ${JSON.stringify(newNode.type)}` });
  }

  // --- properties (extracted early; the required diff needs to know which props exist) ---
  const oldProps = isRecord(oldNode.properties) ? oldNode.properties : {};
  const newProps = isRecord(newNode.properties) ? newNode.properties : {};

  // --- required ---
  const oldRequired = new Set(Array.isArray(oldNode.required) ? (oldNode.required as unknown[]).filter((v): v is string => typeof v === "string") : []);
  const newRequired = new Set(Array.isArray(newNode.required) ? (newNode.required as unknown[]).filter((v): v is string => typeof v === "string") : []);
  for (const name of newRequired) {
    if (!oldRequired.has(name)) findings.push({ kind: "breaking", reason: `+required prop "${name}"${propPath === "" ? "" : ` (under "${propPath}")`}` });
  }
  for (const name of oldRequired) {
    // A name that vanished entirely is handled (as breaking) by the properties
    // diff below; only a still-existing property made optional is additive.
    if (!newRequired.has(name) && name in newProps) {
      findings.push({ kind: "additive", reason: `prop "${propPath === "" ? name : `${propPath}.${name}`}" is no longer required` });
    }
  }

  // --- enum ---
  const oldEnum = Array.isArray(oldNode.enum) ? oldNode.enum : undefined;
  const newEnum = Array.isArray(newNode.enum) ? newNode.enum : undefined;
  if (oldEnum !== undefined && newEnum !== undefined) {
    const oldValues = new Set(oldEnum.map((v) => JSON.stringify(v)));
    const newValues = new Set(newEnum.map((v) => JSON.stringify(v)));
    for (const value of oldValues) {
      if (!newValues.has(value)) findings.push({ kind: "breaking", reason: `${label}enum value ${value} removed` });
    }
    for (const value of newValues) {
      if (!oldValues.has(value)) findings.push({ kind: "additive", reason: `${label}enum value ${value} added` });
    }
  } else if (oldEnum === undefined && newEnum !== undefined) {
    findings.push({ kind: "breaking", reason: `${label}enum constraint added (${newEnum.map((v) => JSON.stringify(v)).join(" | ")}); previously any value was accepted` });
  } else if (oldEnum !== undefined && newEnum === undefined) {
    findings.push({ kind: "additive", reason: `${label}enum constraint removed (was ${oldEnum.map((v) => JSON.stringify(v)).join(" | ")})` });
  }

  // --- description (cosmetic) ---
  if (typeof oldNode.description === "string" && typeof newNode.description === "string") {
    if (oldNode.description !== newNode.description) findings.push({ kind: "changed", reason: `${label}description changed` });
  } else if (oldNode.description !== undefined && newNode.description === undefined) {
    findings.push({ kind: "changed", reason: `${label}description removed` });
  } else if (oldNode.description === undefined && newNode.description !== undefined) {
    findings.push({ kind: "changed", reason: `${label}description added` });
  }

  // --- properties (recurse) ---
  const allNames = [...new Set([...Object.keys(oldProps), ...Object.keys(newProps)])].sort();
  for (const name of allNames) {
    const childPath = propPath === "" ? name : `${propPath}.${name}`;
    const oldProp = oldProps[name];
    const newProp = newProps[name];
    if (oldProp === undefined && newProp === undefined) continue;
    if (oldProp === undefined) {
      // Brand-new property. Required ones were already reported as breaking by
      // the required diff; optional ones are additive.
      if (!newRequired.has(name)) findings.push({ kind: "additive", reason: `+optional prop "${childPath}"` });
      continue;
    }
    if (newProp === undefined) {
      if (oldRequired.has(name)) findings.push({ kind: "breaking", reason: `required prop "${childPath}" removed` });
      else findings.push({ kind: "changed", reason: `-optional prop "${childPath}" (informational)` });
      continue;
    }
    if (isRecord(oldProp) && isRecord(newProp)) {
      compareSchemaNodes(oldProp, newProp, childPath, findings);
    } else if (oldProp !== newProp) {
      findings.push({ kind: "breaking", reason: `prop "${childPath}" schema changed` });
    }
  }
}

/** Compare two snapshots' tool surfaces. Pure: no IO, no clock, deterministic order. */
export function diffSnapshots(oldSnapshot: Snapshot, newSnapshot: Snapshot): DiffClassification {
  const oldTools = new Map(oldSnapshot.tools.map((tool) => [tool.name, tool]));
  const newTools = new Map(newSnapshot.tools.map((tool) => [tool.name, tool]));
  const allNames = [...new Set([...oldTools.keys(), ...newTools.keys()])].sort();

  const tools: ToolChange[] = [];
  const counts = { breaking: 0, additive: 0, changed: 0, unchanged: 0 };

  for (const name of allNames) {
    const oldTool = oldTools.get(name);
    const newTool = newTools.get(name);

    if (oldTool === undefined) {
      tools.push({ tool: name, status: "added", kind: "additive", findings: [{ kind: "additive", reason: "tool added" }] });
      counts.additive += 1;
      continue;
    }
    if (newTool === undefined) {
      tools.push({ tool: name, status: "removed", kind: "breaking", findings: [{ kind: "breaking", reason: "tool removed" }] });
      counts.breaking += 1;
      continue;
    }

    const findings: Finding[] = [];
    if (oldTool.description !== newTool.description) {
      if (oldTool.description === undefined) findings.push({ kind: "changed", reason: "description added" });
      else if (newTool.description === undefined) findings.push({ kind: "changed", reason: "description removed" });
      else findings.push({ kind: "changed", reason: "description changed" });
    }
    const oldSchema = oldTool.inputSchema;
    const newSchema = newTool.inputSchema;
    if (oldSchema !== undefined && newSchema !== undefined) {
      compareSchemaNodes(oldSchema, newSchema, "", findings);
    } else if (oldSchema === undefined && newSchema !== undefined) {
      findings.push({ kind: "additive", reason: "inputSchema added" });
    } else if (oldSchema !== undefined && newSchema === undefined) {
      findings.push({ kind: "breaking", reason: "inputSchema removed" });
    }

    if (findings.length === 0) {
      counts.unchanged += 1;
      continue;
    }
    findings.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    tools.push({ tool: name, status: "modified", kind: worstKind(findings), findings });
    for (const finding of findings) counts[finding.kind] += 1;
  }

  return { tools, counts };
}

// ---------------------------------------------------------------------------
// Diff outcome + renderers
// ---------------------------------------------------------------------------

export interface DiffSide {
  /** Snapshot file path or ref string, as given on the command line. */
  source: string;
  kind: "snapshot" | "live";
  serverInfo: { name?: string; version?: string };
  capturedAt?: string;
}

export interface DiffOptions {
  failOn: "breaking" | "additive";
}

export interface DiffOutcome {
  old: DiffSide;
  new: DiffSide;
  tools: ToolChange[];
  counts: DiffClassification["counts"];
  failOn: DiffOptions["failOn"];
  exitCode: 0 | 1;
}

/** Assemble the full diff outcome from two snapshots and their provenance. */
export function buildDiffOutcome(
  oldSnapshot: Snapshot,
  newSnapshot: Snapshot,
  oldSide: DiffSide,
  newSide: DiffSide,
  options: DiffOptions,
): DiffOutcome {
  const classification = diffSnapshots(oldSnapshot, newSnapshot);
  const exitCode: 0 | 1 =
    classification.counts.breaking > 0 || (options.failOn === "additive" && classification.counts.additive > 0) ? 1 : 0;
  return {
    old: oldSide,
    new: newSide,
    tools: classification.tools,
    counts: classification.counts,
    failOn: options.failOn,
    exitCode,
  };
}

const COLORS = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
function paint(code: string, text: string): string {
  return COLORS ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function describeSide(side: DiffSide): string {
  const info = [side.serverInfo.name, side.serverInfo.version].filter(Boolean).join(" ");
  if (side.kind === "snapshot") {
    const when = side.capturedAt !== "" ? `captured ${side.capturedAt}` : "";
    return [`${paint("2", "snapshot")}`, when, info].filter(Boolean).join(" · ");
  }
  return [paint("2", "live"), info].filter(Boolean).join(" · ");
}

/** Human console table for `mcp-test diff` (ANSI when stdout is a TTY). */
export function renderDiffConsole(outcome: DiffOutcome): string {
  const lines: string[] = [];
  lines.push(paint("1", "mcp-test diff — schema-drift report"));
  lines.push(`old: ${outcome.old.source} (${describeSide(outcome.old)})`);
  lines.push(`new: ${outcome.new.source} (${describeSide(outcome.new)})`);
  lines.push("");

  const sections: Array<{ kind: FindingKind; mark: string; color: string; title: string }> = [
    { kind: "breaking", mark: "✗", color: "31", title: "BREAKING — old callers may fail" },
    { kind: "additive", mark: "+", color: "32", title: "ADDITIVE — new surface, backwards-compatible" },
    { kind: "changed", mark: "~", color: "33", title: "CHANGED — cosmetic only, never gates" },
  ];

  for (const section of sections) {
    const entries = outcome.tools.filter((tool) => tool.findings.some((f) => f.kind === section.kind));
    if (entries.length === 0) continue;
    lines.push(paint(section.color, `${section.mark} ${section.title}`));
    for (const tool of entries) {
      const width = Math.max(...entries.map((t) => t.tool.length));
      for (const finding of tool.findings) {
        if (finding.kind !== section.kind) continue;
        lines.push(`  ${tool.tool.padEnd(width)}  ${finding.reason}`);
      }
    }
    lines.push("");
  }

  const c = outcome.counts;
  lines.push(
    `${c.breaking} breaking · ${c.additive} additive · ${c.changed} changed · ${c.unchanged} unchanged tool${c.unchanged === 1 ? "" : "s"}`,
  );
  if (outcome.exitCode === 0) {
    lines.push(paint("32", `exit code: 0 (no breaking changes${outcome.failOn === "additive" ? ", no additive changes" : ""})`));
  } else {
    const why = c.breaking > 0 ? "breaking changes present" : "additive changes present (--fail-on additive)";
    lines.push(paint("31", `exit code: 1 (${why})`));
  }
  return `${lines.join("\n")}\n`;
}

/** Machine-readable full diff for `--format json`. */
export function renderDiffJson(outcome: DiffOutcome): string {
  return `${JSON.stringify(
    {
      old: outcome.old,
      new: outcome.new,
      tools: outcome.tools,
      counts: outcome.counts,
      failOn: outcome.failOn,
      exitCode: outcome.exitCode,
    },
    null,
    2,
  )}\n`;
}
