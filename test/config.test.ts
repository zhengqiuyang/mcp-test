import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigError, checkSubsetSchema, loadConfig, validateConfig } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONFIG = path.resolve(HERE, "../../example/mcp-test.yaml");

test("the example config loads and validates", () => {
  const loaded = loadConfig(EXAMPLE_CONFIG);
  assert.ok(loaded.config.servers.notes);
  assert.equal(loaded.config.servers.notes.args[0], "example/server.js");
  assert.equal(loaded.config.defaults.timeoutMs, 15000);
  assert.equal(loaded.config.tests.length, 3);
  assert.equal(loaded.config.security.length, 1);
  assert.equal(loaded.config.security[0]?.probes, "all");
});

test("unknown server references are rejected", () => {
  assert.throws(
    () =>
      validateConfig({
        servers: { notes: { command: "node" } },
        tests: [{ name: "t", server: "ghost", tool: "echo" }],
      }),
    (err: unknown) => err instanceof ConfigError && err.errors.some((e) => /unknown server "ghost"/.test(e)),
  );
});

test("unknown assert keys are rejected", () => {
  assert.throws(
    () =>
      validateConfig({
        servers: { notes: { command: "node" } },
        tests: [{ name: "t", server: "notes", tool: "echo", assert: { contians: "typo" } }],
      }),
    (err: unknown) => err instanceof ConfigError && err.errors.some((e) => /unknown assert key/.test(e)),
  );
});

test("bad probe ids are rejected", () => {
  assert.throws(
    () =>
      validateConfig({
        servers: { notes: { command: "node" } },
        security: [{ server: "notes", tool: "read_notes", probes: ["not-a-probe"] }],
      }),
    (err: unknown) => err instanceof ConfigError && err.errors.some((e) => /unknown probe id "not-a-probe"/.test(e)),
  );
});

test("validation problems accumulate into one ConfigError", () => {
  assert.throws(
    () =>
      validateConfig({
        servers: { notes: { command: "node", bogus: 1 } },
        tests: [
          { name: "a", server: "missing", tool: "echo", assert: { nope: 1 } },
          { name: "b", server: "notes" },
        ],
        security: [{ server: "nope", tool: "t", probes: "all" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.errors.length >= 5, `expected several accumulated problems, got: ${err.errors.join(" | ")}`);
      return true;
    },
  );
});

test("tool and listTools are mutually exclusive and one is required", () => {
  assert.throws(
    () =>
      validateConfig({
        servers: { n: { command: "node" } },
        tests: [{ name: "a", server: "n", tool: "echo", listTools: true }],
      }),
    (err: unknown) => err instanceof ConfigError && err.errors.some((e) => /mutually exclusive/.test(e)),
  );
  assert.throws(
    () =>
      validateConfig({
        servers: { n: { command: "node" } },
        tests: [{ name: "a", server: "n" }],
      }),
    (err: unknown) => err instanceof ConfigError && err.errors.some((e) => /either "tool: <toolName>"/.test(e)),
  );
});

test("missing config file is a friendly ConfigError", () => {
  assert.throws(
    () => loadConfig("no/such/file.yaml"),
    (err: unknown) => err instanceof ConfigError && /Cannot read config file/.test(err.message),
  );
});

test("subset schema validator accepts valid structured content", () => {
  const schema = { type: "object" as const, required: ["reply"], properties: { reply: { type: "string" as const } } };
  assert.deepEqual(checkSubsetSchema({ reply: "hello" }, schema), []);
});

test("subset schema validator reports type, required and nested problems", () => {
  const schema = {
    type: "object" as const,
    required: ["reply", "count"],
    properties: { reply: { type: "string" as const }, count: { type: "integer" as const } },
  };
  const problems = checkSubsetSchema({ reply: 42, count: 1.5 }, schema);
  assert.ok(problems.some((p) => /expected string, got integer/.test(p)));
  assert.ok(problems.some((p) => /missing required property "count"|expected integer, got number/.test(p)));
  const missing = checkSubsetSchema({}, schema);
  assert.ok(missing.some((p) => /missing required property "reply"/.test(p)));
  const wrongRoot = checkSubsetSchema("nope", schema);
  assert.ok(wrongRoot.some((p) => /expected object, got string/.test(p)));
});
