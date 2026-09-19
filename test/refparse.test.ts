import test from "node:test";
import assert from "node:assert/strict";
import { RefError, parseRef, runnerHint, splitCommandTokens } from "../src/refparse.js";

test("plain ref splits into command and args with no recognized form", () => {
  const ref = parseRef("node ./server.js --verbose");
  assert.deepEqual(
    { command: ref.command, args: ref.args, form: ref.form },
    { command: "node", args: ["./server.js", "--verbose"], form: null },
  );
});

test("runner forms are recognized: npx, pnpm dlx, uvx, bunx, docker", () => {
  assert.equal(parseRef("npx -y @modelcontextprotocol/server-filesystem@2025.1.14 /srv/data").form, "npx");
  assert.equal(parseRef("pnpm dlx some-mcp-server@2.0.0").form, "pnpm dlx");
  assert.equal(parseRef("uvx mcp-server-git --repo path/to/repo").form, "uvx");
  assert.equal(parseRef("bunx some-server@latest").form, "bunx");
  assert.equal(parseRef("docker run -i --rm mcp/server:1.4").form, "docker");
  assert.equal(parseRef("node ./server.js").form, null);
  // `pnpm dlx` is two tokens: the command stays `pnpm` with `dlx` as first arg.
  const pnpm = parseRef("pnpm dlx pkg@2.0.0 --flag");
  assert.equal(pnpm.command, "pnpm");
  assert.deepEqual(pnpm.args, ["dlx", "pkg@2.0.0", "--flag"]);
});

test("double quotes group arguments; on Windows backslashes stay literal path separators", () => {
  const ref = parseRef('node "C:\\Program Files\\server.js" --greeting "hello world"');
  assert.equal(ref.command, "node");
  assert.deepEqual(ref.args, ["C:\\Program Files\\server.js", "--greeting", "hello world"]);
});

test("single quotes group arguments and never process backslash escapes", () => {
  const ref = parseRef("uvx 'mcp server' 'C:\\path\\to\\data'");
  assert.deepEqual(ref.args, ["mcp server", "C:\\path\\to\\data"]);
});

test("windowsBackslash mode keeps unquoted backslash paths intact", () => {
  assert.deepEqual(splitCommandTokens("node C:\\tools\\server.js", { windowsBackslash: true }), ["node", "C:\\tools\\server.js"]);
});

test("POSIX mode treats backslash as an escape outside quotes and for quotes inside double quotes", () => {
  assert.deepEqual(splitCommandTokens("node my\\ server.js", { windowsBackslash: false }), ["node", "my server.js"]);
  assert.deepEqual(splitCommandTokens('node "my \\"quoted\\" file.js"', { windowsBackslash: false }), ["node", 'my "quoted" file.js']);
  // ...but a backslash before an ordinary character inside double quotes stays literal (POSIX rule).
  assert.deepEqual(splitCommandTokens('node "C:\\Program Files\\s.js"', { windowsBackslash: false }), ["node", "C:\\Program Files\\s.js"]);
});

test("empty and whitespace-only refs are rejected", () => {
  assert.throws(() => parseRef(""), RefError);
  assert.throws(() => parseRef("   "), RefError);
});

test("unterminated quotes are rejected with a clear error", () => {
  assert.throws(() => parseRef('node "server.js'), /unterminated double quote/);
  assert.throws(() => parseRef("node 'server.js"), /unterminated single quote/);
});

test("a bare runner with nothing after it is rejected with guidance", () => {
  assert.throws(() => parseRef("npx"), /"npx" server spec needs a package/);
  assert.throws(() => parseRef("docker"), /"docker" server spec needs an image/);
  assert.throws(() => parseRef("pnpm dlx"), /"pnpm dlx" server spec needs a package/);
});

test("runner hints explain first-use download latency for runner forms only", () => {
  assert.match(runnerHint("npx"), /downloads the package on first use/);
  assert.match(runnerHint("docker"), /pulls the image on first use/);
  assert.equal(runnerHint(null), "");
});
