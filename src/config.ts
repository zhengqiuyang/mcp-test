import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { McpServerConfig } from "./client.js";
import { PROBES } from "./probes.js";
import { errMsg } from "./util.js";

export const DEFAULT_CONFIG_PATH = "mcp-test.yaml";

/** Subset of JSON Schema understood by mcp-test: `type`, `properties`, `required` only. */
export interface JsonSchemaSubset {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchemaSubset>;
  required?: string[];
}

export interface AssertSpec {
  /** Substring that must appear in the concatenated text content. */
  contains?: string;
  /** At least one of these substrings must appear. */
  containsAny?: string[];
  /** All of these substrings must appear. */
  containsAll?: string[];
  /** Regex source matched against the concatenated text content. */
  regex?: string;
  /** Expected value of the result's `isError` flag. */
  isError?: boolean;
  /** Upper bound for the tools/call round-trip latency. */
  maxLatencyMs?: number;
  /** Subset schema validated against `structuredContent`. */
  jsonSchema?: JsonSchemaSubset;
  /** listTools tests only: tool names that must appear in tools/list. */
  toolsContain?: string[];
}

export interface FunctionalSpec {
  name: string;
  server: string;
  /** tools/call target. Mutually exclusive with `listTools`. */
  tool?: string;
  /** When true this is a tools/list test. */
  listTools?: boolean;
  arguments: Record<string, unknown>;
  assert: AssertSpec;
}

export interface SecuritySpec {
  server: string;
  tool: string;
  /** Tool argument that receives the probe payload. Auto-detected from inputSchema when omitted. */
  argument?: string;
  probes: "all" | string[];
}

export interface McpTestConfig {
  servers: Record<string, McpServerConfig>;
  defaults: { timeoutMs: number };
  tests: FunctionalSpec[];
  security: SecuritySpec[];
}

export interface LoadedConfig {
  config: McpTestConfig;
  path: string;
  /** Raw YAML text (used for best-effort line numbers in GitHub annotations). */
  text: string;
}

/** Thrown when the config file cannot be read/parsed, or validation fails. `errors` holds every problem found. */
export class ConfigError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid configuration (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n  - ${errors.join("\n  - ")}`);
    this.name = "ConfigError";
    this.errors = errors;
  }
}

export function loadConfig(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError([`Cannot read config file "${path}": ${errMsg(err)}${(err as NodeJS.ErrnoException).code === "ENOENT" ? " (pass --config <path> to point mcp-test at your YAML file)" : ""}`]);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError([`YAML parse error in "${path}": ${errMsg(err)}`]);
  }
  const config = validateConfig(raw);
  return { config, path, text };
}

// ---------------------------------------------------------------------------
// Validation (accumulates every problem, then fails once with all of them)
// ---------------------------------------------------------------------------

const CALL_ONLY_ASSERT_KEYS: readonly string[] = ["contains", "containsAny", "containsAll", "isError", "jsonSchema"];
const LIST_ONLY_ASSERT_KEYS: readonly string[] = ["toolsContain"];
const SHARED_ASSERT_KEYS: readonly string[] = ["regex", "maxLatencyMs"];
const ALL_ASSERT_KEYS: readonly string[] = [...CALL_ONLY_ASSERT_KEYS, ...LIST_ONLY_ASSERT_KEYS, ...SHARED_ASSERT_KEYS];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Accepts a string or a non-empty array of strings; returns null when invalid. */
function normalizeStringList(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return v;
  return null;
}

function parseSchemaSubset(v: unknown, path: string, errors: string[]): JsonSchemaSubset | undefined {
  if (!isObject(v)) {
    errors.push(`${path}: must be a mapping (allowed keys: type, properties, required)`);
    return undefined;
  }
  const out: JsonSchemaSubset = {};
  for (const key of Object.keys(v)) {
    if (!["type", "properties", "required"].includes(key)) {
      errors.push(`${path}.${key}: unsupported schema key (the subset supports only: type, properties, required)`);
    }
  }
  if (v.type !== undefined) {
    const types = ["object", "array", "string", "number", "integer", "boolean", "null"];
    if (!types.includes(v.type as string)) {
      errors.push(`${path}.type: must be one of ${types.join(" | ")}`);
    } else {
      out.type = v.type as JsonSchemaSubset["type"];
    }
  }
  if (v.required !== undefined) {
    const list = normalizeStringList(v.required);
    if (!list) errors.push(`${path}.required: must be an array of property names`);
    else out.required = list;
  }
  if (v.properties !== undefined) {
    if (!isObject(v.properties)) {
      errors.push(`${path}.properties: must be a mapping of property name -> schema`);
    } else {
      const properties: Record<string, JsonSchemaSubset> = {};
      for (const [propKey, propValue] of Object.entries(v.properties)) {
        const sub = parseSchemaSubset(propValue, `${path}.properties.${propKey}`, errors);
        if (sub) properties[propKey] = sub;
      }
      out.properties = properties;
    }
  }
  return Object.keys(out).length > 0 || Object.keys(v).length === 0 ? out : undefined;
}

function parseAssert(entry: Record<string, unknown>, path: string, mode: "call" | "list", errors: string[]): AssertSpec {
  const out: AssertSpec = {};
  for (const key of Object.keys(entry)) {
    if (!ALL_ASSERT_KEYS.includes(key)) {
      errors.push(`${path}.${key}: unknown assert key (allowed: ${ALL_ASSERT_KEYS.join(", ")})`);
      continue;
    }
    if (mode === "list" && CALL_ONLY_ASSERT_KEYS.includes(key)) {
      errors.push(`${path}.${key}: only valid on tools/call tests (this test uses listTools)`);
      continue;
    }
    if (mode === "call" && LIST_ONLY_ASSERT_KEYS.includes(key)) {
      errors.push(`${path}.${key}: only valid on listTools tests`);
      continue;
    }
    const value = entry[key];
    switch (key) {
      case "contains":
        if (!isNonEmptyString(value)) errors.push(`${path}.contains: must be a non-empty string`);
        else out.contains = value;
        break;
      case "containsAny":
      case "containsAll": {
        const list = normalizeStringList(value);
        if (!list || list.length === 0) errors.push(`${path}.${key}: must be a string or a non-empty array of strings`);
        else out[key] = list;
        break;
      }
      case "toolsContain": {
        const list = normalizeStringList(value);
        if (!list) errors.push(`${path}.toolsContain: must be a string or a non-empty array of tool names`);
        else out.toolsContain = list;
        break;
      }
      case "regex":
        if (!isNonEmptyString(value)) {
          errors.push(`${path}.regex: must be a non-empty string (regex source)`);
        } else {
          try {
            new RegExp(value);
            out.regex = value;
          } catch (err) {
            errors.push(`${path}.regex: invalid regular expression: ${errMsg(err)}`);
          }
        }
        break;
      case "isError":
        if (typeof value !== "boolean") errors.push(`${path}.isError: must be a boolean`);
        else out.isError = value;
        break;
      case "maxLatencyMs":
        if (typeof value !== "number" || value <= 0) errors.push(`${path}.maxLatencyMs: must be a positive number`);
        else out.maxLatencyMs = value;
        break;
      case "jsonSchema": {
        const sub = parseSchemaSubset(value, `${path}.jsonSchema`, errors);
        if (sub) out.jsonSchema = sub;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function validateConfig(raw: unknown): McpTestConfig {
  const errors: string[] = [];
  if (!isObject(raw)) {
    throw new ConfigError(["config root must be a YAML mapping (servers:, tests:, security:, …)"]);
  }

  for (const key of Object.keys(raw)) {
    if (!["servers", "defaults", "tests", "security"].includes(key)) {
      errors.push(`"${key}": unknown top-level key (allowed: servers, defaults, tests, security)`);
    }
  }

  // --- servers ---
  const servers: Record<string, McpServerConfig> = {};
  const serversRaw = raw.servers;
  if (!isObject(serversRaw) || Object.keys(serversRaw).length === 0) {
    errors.push(`"servers" must be a non-empty mapping of server name -> {command, args, env}`);
  } else {
    for (const [name, entry] of Object.entries(serversRaw)) {
      const path = `servers.${name}`;
      if (!isObject(entry)) {
        errors.push(`${path}: must be a mapping with at least a "command" string`);
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!["command", "args", "env"].includes(key)) errors.push(`${path}.${key}: unknown key (allowed: command, args, env)`);
      }
      const command = entry.command;
      const commandOk = isNonEmptyString(command);
      if (!commandOk) errors.push(`${path}.command: required non-empty string`);

      let args: string[] = [];
      if (entry.args !== undefined) {
        if (!Array.isArray(entry.args) || entry.args.some((x) => typeof x !== "string")) {
          errors.push(`${path}.args: must be an array of strings`);
        } else {
          args = entry.args as string[];
        }
      }
      let env: Record<string, string> = {};
      if (entry.env !== undefined) {
        if (!isObject(entry.env) || Object.values(entry.env).some((v) => typeof v !== "string")) {
          errors.push(`${path}.env: must be a mapping of string -> string`);
        } else {
          env = entry.env as Record<string, string>;
        }
      }
      if (commandOk) servers[name] = { command, args, env };
    }
  }

  // --- defaults ---
  let timeoutMs = 15_000;
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) {
      errors.push(`"defaults" must be a mapping`);
    } else {
      for (const key of Object.keys(raw.defaults)) {
        if (key !== "timeoutMs") errors.push(`defaults.${key}: unknown key (allowed: timeoutMs)`);
      }
      const value = raw.defaults.timeoutMs;
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          errors.push(`defaults.timeoutMs: must be a positive integer`);
        } else {
          timeoutMs = value;
        }
      }
    }
  }

  // --- tests ---
  const tests: FunctionalSpec[] = [];
  if (raw.tests !== undefined && !Array.isArray(raw.tests)) {
    errors.push(`"tests" must be a list of test mappings`);
  } else if (Array.isArray(raw.tests)) {
    const seenNames = new Set<string>();
    (raw.tests as unknown[]).forEach((entry, index) => {
      const path = `tests[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${path}: must be a mapping`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!["name", "server", "tool", "listTools", "arguments", "assert"].includes(key)) {
          errors.push(`${path}.${key}: unknown key (allowed: name, server, tool, listTools, arguments, assert)`);
        }
      }
      const name = entry.name;
      if (!isNonEmptyString(name)) {
        errors.push(`${path}.name: required non-empty string`);
        return;
      }
      if (seenNames.has(name)) errors.push(`${path}.name: duplicate test name "${name}"`);
      seenNames.add(name);

      const server = entry.server;
      const serverKnown = isNonEmptyString(server) && server in servers;
      if (!isNonEmptyString(server)) errors.push(`${path}.server: required string`);
      else if (!serverKnown) errors.push(`${path}.server: unknown server "${server}" (defined: ${Object.keys(servers).join(", ") || "none"})`);

      const hasTool = entry.tool !== undefined;
      const isList = entry.listTools === true;
      if (hasTool && isList) errors.push(`${path}: "tool" and "listTools" are mutually exclusive`);
      if (!hasTool && !isList) errors.push(`${path}: either "tool: <toolName>" or "listTools: true" is required`);
      if (entry.listTools !== undefined && entry.listTools !== true) errors.push(`${path}.listTools: must be true (or omitted)`);
      if (hasTool && !isNonEmptyString(entry.tool)) errors.push(`${path}.tool: must be a non-empty string`);

      let args: Record<string, unknown> = {};
      if (entry.arguments !== undefined) {
        if (!isObject(entry.arguments)) errors.push(`${path}.arguments: must be a mapping of argument name -> value`);
        else args = entry.arguments;
      }

      let assert: AssertSpec = {};
      if (entry.assert !== undefined) {
        if (!isObject(entry.assert)) errors.push(`${path}.assert: must be a mapping`);
        else assert = parseAssert(entry.assert, `${path}.assert`, isList ? "list" : "call", errors);
      }

      if (serverKnown) {
        tests.push({
          name,
          server,
          tool: isNonEmptyString(entry.tool) ? entry.tool : undefined,
          listTools: isList || undefined,
          arguments: args,
          assert,
        });
      }
    });
  }

  // --- security ---
  const security: SecuritySpec[] = [];
  if (raw.security !== undefined && !Array.isArray(raw.security)) {
    errors.push(`"security" must be a list of security suite mappings`);
  } else if (Array.isArray(raw.security)) {
    const knownProbeIds = new Set(PROBES.map((probe) => probe.id));
    (raw.security as unknown[]).forEach((entry, index) => {
      const path = `security[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${path}: must be a mapping`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!["server", "tool", "argument", "probes"].includes(key)) {
          errors.push(`${path}.${key}: unknown key (allowed: server, tool, argument, probes)`);
        }
      }
      const server = entry.server;
      const serverKnown = isNonEmptyString(server) && server in servers;
      if (!isNonEmptyString(server)) errors.push(`${path}.server: required string`);
      else if (!serverKnown) errors.push(`${path}.server: unknown server "${server}" (defined: ${Object.keys(servers).join(", ") || "none"})`);
      if (!isNonEmptyString(entry.tool)) errors.push(`${path}.tool: required non-empty string`);
      if (entry.argument !== undefined && !isNonEmptyString(entry.argument)) errors.push(`${path}.argument: must be a non-empty string`);

      const probes = entry.probes;
      let probesValue: SecuritySpec["probes"] = [];
      if (probes === undefined) {
        errors.push(`${path}.probes: required ("all" or a list of probe ids)`);
      } else if (probes === "all") {
        probesValue = "all";
      } else if (!Array.isArray(probes) || probes.length === 0 || probes.some((x) => typeof x !== "string")) {
        errors.push(`${path}.probes: must be "all" or a non-empty array of probe ids`);
      } else {
        for (const id of probes as unknown[]) {
          if (!knownProbeIds.has(id as string)) {
            errors.push(`${path}.probes: unknown probe id "${String(id)}" (available: ${[...knownProbeIds].join(", ")})`);
          }
        }
        probesValue = probes as string[];
      }

      if (serverKnown && isNonEmptyString(entry.tool)) {
        security.push({
          server,
          tool: entry.tool,
          argument: isNonEmptyString(entry.argument) ? entry.argument : undefined,
          probes: probesValue,
        });
      }
    });
  }

  if (tests.length === 0 && security.length === 0) {
    errors.push(`config defines no work: add a "tests" list and/or a "security" list`);
  }

  if (errors.length > 0) throw new ConfigError(errors);

  return { servers, defaults: { timeoutMs }, tests, security };
}

// ---------------------------------------------------------------------------
// Subset schema evaluation (used by the runner for assert.jsonSchema)
// ---------------------------------------------------------------------------

function jsonTypeOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object": return "object";
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isInteger(value) ? "integer" : "number";
    default: return null;
  }
}

function typeMatches(actual: string, expected: JsonSchemaSubset["type"]): boolean {
  if (expected === undefined) return true;
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate `value` against the subset schema; returns a list of human-readable problems (empty = valid). */
export function checkSubsetSchema(value: unknown, schema: JsonSchemaSubset, path = "structuredContent"): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const actual = jsonTypeOf(value);
    if (actual === null) {
      errors.push(`${path}: expected ${schema.type}, got ${value === undefined ? "undefined (missing structuredContent)" : String(value)}`);
    } else if (!typeMatches(actual, schema.type)) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
    }
  }
  if (!isPlainObjectValue(value)) return errors.concat(
    schema.required?.length ? [`${path}: required properties only apply to objects`] : [],
  );
  if (schema.required !== undefined) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
  }
  if (schema.properties !== undefined) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) {
        errors.push(...checkSubsetSchema(value[key], sub, `${path}.${key}`));
      }
    }
  }
  return errors;
}
