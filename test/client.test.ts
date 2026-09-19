import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpClientError, McpStdioClient } from "../src/client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../../example/server.js");

function makeClient(options?: { requestTimeoutMs?: number }): McpStdioClient {
  return new McpStdioClient({ command: process.execPath, args: [SERVER], env: {} }, options);
}

test("handshake, tools/list pagination, and tools/call over real stdio", async () => {
  const client = makeClient({ requestTimeoutMs: 8000 });
  try {
    await client.connect();
    // The example server paginates one tool per page and pushes notifications
    // before its responses — both must be handled transparently here.
    assert.equal(client.serverInfo?.name, "example-notes");
    assert.equal(client.protocolVersion, "2025-06-18");

    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["echo", "read_notes"]);

    const result = await client.callTool("echo", { message: "hello world" });
    assert.equal(result.isError, false);
    assert.match(result.text, /hello world/);
    assert.deepEqual(result.structured, { reply: "hello world" });
    assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
  } finally {
    await client.close();
  }
  assert.equal(client.exited, true, "close() should terminate the server process");
});

test("requests time out cleanly when the server never responds", async () => {
  const client = makeClient({ requestTimeoutMs: 400 });
  try {
    await client.connect();
    await assert.rejects(
      client.callTool("echo", { message: "__hang__" }),
      (err: unknown) => err instanceof McpClientError && err.kind === "timeout",
    );
    // The pending request was cleaned up: the connection is still usable.
    const result = await client.callTool("echo", { message: "still alive" });
    assert.match(result.text, /still alive/);
  } finally {
    await client.close();
  }
});

test("JSON-RPC errors surface code and message", async () => {
  const client = makeClient();
  try {
    await client.connect();
    await assert.rejects(
      client.callTool("no-such-tool", {}),
      (err: unknown) =>
        err instanceof McpClientError && err.kind === "jsonrpc" && err.jsonRpcCode === -32602 && /Unknown tool/.test(err.message),
    );
  } finally {
    await client.close();
  }
});

test("server exiting during the handshake is reported with its exit code", async () => {
  const client = new McpStdioClient({ command: process.execPath, args: ["-e", "process.exit(3)"], env: {} });
  await assert.rejects(
    client.connect(),
    (err: unknown) => err instanceof McpClientError && err.kind === "exited" && /exit code 3/.test(err.message),
  );
});

test("an unspawnable command fails with a clear spawn error", async () => {
  const client = new McpStdioClient({ command: "mcp-test-no-such-command-xyz", args: [], env: {} });
  await assert.rejects(
    client.connect(),
    (err: unknown) => err instanceof McpClientError && (err.kind === "spawn" || err.kind === "exited"),
  );
});
