import { McpClientError, McpStdioClient, type CallToolResult, type McpServerConfig, type ToolInfo } from "./client.js";
import { checkSubsetSchema, type FunctionalSpec, type McpTestConfig, type SecuritySpec } from "./config.js";
import { PROBES, getProbe, type Verdict } from "./probes.js";
import { errMsg, toSingleLine, truncate } from "./util.js";

export interface AssertionOutcome {
  label: string;
  pass: boolean;
  expected?: string;
  actual?: string;
}

export interface FunctionalTestOutcome {
  name: string;
  server: string;
  kind: "call" | "list";
  tool?: string;
  status: "pass" | "fail" | "error";
  latencyMs?: number;
  assertions: AssertionOutcome[];
  /** Set when the harness itself failed (server exited, timeout, JSON-RPC error, ...). */
  error?: string;
}

export interface SecurityProbeOutcome {
  server: string;
  tool: string;
  probeId: string;
  title: string;
  verdict: Verdict | "error";
  detector?: string;
  evidence?: string;
  latencyMs?: number;
  /** Set when the probe could not run (server died, timeout, ...). */
  error?: string;
}

export interface RunSummary {
  functionalTotal: number;
  functionalPassed: number;
  functionalFailed: number;
  functionalErrored: number;
  probesTotal: number;
  leaks: number;
  suspicious: number;
  probesOk: number;
  probeErrors: number;
  exitCode: 0 | 1;
}

export interface RunResult {
  version: string;
  configPath: string;
  startedAt: string;
  durationMs: number;
  functional: FunctionalTestOutcome[];
  security: SecurityProbeOutcome[];
  summary: RunSummary;
}

export interface RunnerOptions {
  configPath: string;
  only?: "all" | "functional" | "security";
  /** Overrides defaults.timeoutMs from the config. */
  timeoutMs?: number;
}

const VERSION = "0.1.0";

/** Preview of a text value for expected/actual reporting. */
function preview(text: string): string {
  return truncate(text, 500);
}

function describeError(err: unknown): string {
  if (err instanceof McpClientError) {
    let message = err.message;
    if (err.stderrTail && err.stderrTail.trim() !== "") {
      message += `\n  server stderr (tail):\n    ${toSingleLine(truncate(err.stderrTail, 600))}`;
    }
    return message;
  }
  return errMsg(err);
}

/**
 * One client per named server, reused across that server's tests. If the
 * process died, the next `obtain()` starts a fresh one.
 */
class ServerPool {
  private readonly clients = new Map<string, McpStdioClient>();

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly timeoutMs: number,
    private readonly cwd?: string,
  ) {}

  async obtain(name: string): Promise<McpStdioClient> {
    const existing = this.clients.get(name);
    if (existing && !existing.exited) return existing;
    if (existing) {
      await existing.close().catch(() => undefined);
      this.clients.delete(name);
    }
    const server = this.servers[name];
    if (!server) throw new Error(`unknown server "${name}"`);
    const client = new McpStdioClient(server, { requestTimeoutMs: this.timeoutMs, cwd: this.cwd });
    await client.connect();
    this.clients.set(name, client);
    return client;
  }

  async invalidate(name: string): Promise<void> {
    const client = this.clients.get(name);
    this.clients.delete(name);
    if (client) await client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const client of clients) await client.close().catch(() => undefined);
  }
}

function evaluateCallAssertions(test: FunctionalSpec, result: CallToolResult): AssertionOutcome[] {
  const a = test.assert;
  const outcomes: AssertionOutcome[] = [];

  if (a.contains !== undefined) {
    outcomes.push({
      label: "contains",
      pass: result.text.includes(a.contains),
      expected: `text content contains ${JSON.stringify(a.contains)}`,
      actual: preview(result.text),
    });
  }
  if (a.containsAny !== undefined) {
    const hits = a.containsAny.filter((needle) => result.text.includes(needle));
    outcomes.push({
      label: "containsAny",
      pass: hits.length > 0,
      expected: `text content contains any of ${JSON.stringify(a.containsAny)}`,
      actual: hits.length > 0 ? `matched ${JSON.stringify(hits)}` : preview(result.text),
    });
  }
  if (a.containsAll !== undefined) {
    const missing = a.containsAll.filter((needle) => !result.text.includes(needle));
    outcomes.push({
      label: "containsAll",
      pass: missing.length === 0,
      expected: `text content contains all of ${JSON.stringify(a.containsAll)}`,
      actual: missing.length === 0 ? "all present" : `missing ${JSON.stringify(missing)} — ${preview(result.text)}`,
    });
  }
  if (a.regex !== undefined) {
    const re = new RegExp(a.regex);
    outcomes.push({
      label: "regex",
      pass: re.test(result.text),
      expected: `text content matches /${a.regex}/`,
      actual: preview(result.text),
    });
  }
  if (a.isError !== undefined) {
    outcomes.push({
      label: "isError",
      pass: result.isError === a.isError,
      expected: `isError === ${a.isError}`,
      actual: `isError === ${result.isError}`,
    });
  }
  if (a.maxLatencyMs !== undefined) {
    outcomes.push({
      label: "maxLatencyMs",
      pass: result.latencyMs <= a.maxLatencyMs,
      expected: `round-trip latency <= ${a.maxLatencyMs}ms`,
      actual: `round-trip latency was ${result.latencyMs}ms`,
    });
  }
  if (a.jsonSchema !== undefined) {
    const problems =
      result.structured === undefined
        ? ["structuredContent is missing from the response"]
        : checkSubsetSchema(result.structured, a.jsonSchema);
    outcomes.push({
      label: "jsonSchema",
      pass: problems.length === 0,
      expected: `structuredContent validates against ${JSON.stringify(a.jsonSchema)}`,
      actual: problems.length === 0 ? "valid" : problems.join("; "),
    });
  }
  return outcomes;
}

function evaluateListAssertions(test: FunctionalSpec, tools: ToolInfo[], latencyMs: number): AssertionOutcome[] {
  const a = test.assert;
  const outcomes: AssertionOutcome[] = [];
  const names = tools.map((tool) => tool.name);
  const namesText = names.join("\n");

  if (a.toolsContain !== undefined) {
    const missing = a.toolsContain.filter((name) => !names.includes(name));
    outcomes.push({
      label: "toolsContain",
      pass: missing.length === 0,
      expected: `tools/list contains ${JSON.stringify(a.toolsContain)}`,
      actual: missing.length === 0 ? `tools: ${JSON.stringify(names)}` : `missing ${JSON.stringify(missing)} — tools: ${JSON.stringify(names)}`,
    });
  }
  if (a.regex !== undefined) {
    const re = new RegExp(a.regex);
    outcomes.push({
      label: "regex",
      pass: re.test(namesText),
      expected: `tool names match /${a.regex}/`,
      actual: `tool names: ${preview(namesText)}`,
    });
  }
  if (a.maxLatencyMs !== undefined) {
    outcomes.push({
      label: "maxLatencyMs",
      pass: latencyMs <= a.maxLatencyMs,
      expected: `tools/list latency <= ${a.maxLatencyMs}ms`,
      actual: `tools/list latency was ${latencyMs}ms`,
    });
  }
  return outcomes;
}

async function runFunctionalTest(pool: ServerPool, test: FunctionalSpec): Promise<FunctionalTestOutcome> {
  const base = {
    name: test.name,
    server: test.server,
    kind: (test.listTools === true ? "list" : "call") as "list" | "call",
    tool: test.tool,
    assertions: [] as AssertionOutcome[],
  };

  const attempt = async (): Promise<FunctionalTestOutcome> => {
    const client = await pool.obtain(test.server);
    if (test.listTools === true) {
      const startedAt = Date.now();
      const tools = await client.listTools();
      const latencyMs = Date.now() - startedAt;
      const assertions = evaluateListAssertions(test, tools, latencyMs);
      return {
        ...base,
        status: assertions.every((outcome) => outcome.pass) ? "pass" : "fail",
        latencyMs,
        assertions,
      };
    }
    const result = await client.callTool(test.tool!, test.arguments);
    const assertions = evaluateCallAssertions(test, result);
    return {
      ...base,
      status: assertions.every((outcome) => outcome.pass) ? "pass" : "fail",
      latencyMs: result.latencyMs,
      assertions,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    // The server process died under us (crash, OOM, early exit): restart it once and retry.
    if (err instanceof McpClientError && (err.kind === "exited" || err.kind === "closed")) {
      await pool.invalidate(test.server);
      try {
        return await attempt();
      } catch (retryErr) {
        return { ...base, status: "error", error: describeError(retryErr) };
      }
    }
    return { ...base, status: "error", error: describeError(err) };
  }
}

function topLevelStringProperties(schema: Record<string, unknown> | undefined): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  const names: string[] = [];
  for (const [name, def] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof def === "object" && def !== null && (def as Record<string, unknown>).type === "string") {
      names.push(name);
    }
  }
  return names;
}

function probeErrorOutcome(suite: SecuritySpec, probeId: string, title: string, error: string): SecurityProbeOutcome {
  return { server: suite.server, tool: suite.tool, probeId, title, verdict: "error", error };
}

async function runSecuritySuite(
  config: McpTestConfig,
  suite: SecuritySpec,
  timeoutMs: number,
  cwd: string | undefined,
  outcomes: SecurityProbeOutcome[],
): Promise<void> {
  const probeIds = suite.probes === "all" ? PROBES.map((probe) => probe.id) : suite.probes;

  let client: McpStdioClient | null = null;
  let reconnects = 0;
  const ensureClient = async (): Promise<McpStdioClient> => {
    if (client && !client.exited) return client;
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    reconnects += 1;
    if (reconnects > 3) {
      throw new McpClientError({ kind: "closed", message: "Giving up: the server kept exiting during security probes." });
    }
    client = new McpStdioClient(config.servers[suite.server]!, { requestTimeoutMs: timeoutMs, cwd });
    await client.connect();
    return client;
  };

  // Resolve where the payload goes: an explicit `argument`, else every top-level
  // string property of the tool's inputSchema, else no argument at all.
  let payloadTargets: string[] | null = null;
  try {
    const connected = await ensureClient();
    if (!suite.argument) {
      const tools = await connected.listTools();
      const tool = tools.find((candidate) => candidate.name === suite.tool);
      if (!tool) {
        throw new Error(`tool "${suite.tool}" is not listed by server "${suite.server}" (available: ${tools.map((t) => t.name).join(", ") || "none"})`);
      }
      payloadTargets = topLevelStringProperties(tool.inputSchema);
    }
  } catch (err) {
    for (const id of probeIds) {
      const probe = getProbe(id);
      outcomes.push(probeErrorOutcome(suite, id, probe?.title ?? id, describeError(err)));
    }
    return;
  }

  for (const id of probeIds) {
    const probe = getProbe(id);
    if (!probe) {
      outcomes.push(probeErrorOutcome(suite, id, id, `unknown probe id "${id}"`));
      continue;
    }
    try {
      const connected = await ensureClient();
      const args: Record<string, unknown> = {};
      if (suite.argument) {
        args[suite.argument] = probe.payload;
      } else {
        for (const target of payloadTargets ?? []) args[target] = probe.payload;
      }
      const result = await connected.callTool(suite.tool, args);
      const finding = probe.check(result);
      outcomes.push({
        server: suite.server,
        tool: suite.tool,
        probeId: probe.id,
        title: probe.title,
        verdict: finding.verdict,
        detector: finding.detector,
        evidence: finding.evidence,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      outcomes.push(probeErrorOutcome(suite, probe.id, probe.title, describeError(err)));
    }
  }

  const activeClient = client as McpStdioClient | null;
  if (activeClient !== null) await activeClient.close().catch(() => undefined);
}

/**
 * Run the configured functional tests (one reused client per server) and the
 * security probes (a fresh client per suite), and return the full results.
 * Never throws for per-test failures — only for harness-level breakage.
 */
export async function runAll(config: McpTestConfig, options: RunnerOptions): Promise<RunResult> {
  const startedAtIso = new Date().toISOString();
  const wallStart = Date.now();
  const timeoutMs = options.timeoutMs ?? config.defaults.timeoutMs;
  const only = options.only ?? "all";
  // Servers are spawned with the current working directory, so relative paths in
  // the config (like `args: [example/server.js]`) resolve exactly as they would
  // when run by hand from the same directory mcp-test is invoked from.
  const cwd: string | undefined = undefined;

  const functional: FunctionalTestOutcome[] = [];
  const security: SecurityProbeOutcome[] = [];
  const pool = new ServerPool(config.servers, timeoutMs, cwd);

  try {
    if (only !== "security" && config.tests.length > 0) {
      for (const test of config.tests) {
        functional.push(await runFunctionalTest(pool, test));
      }
    }
    if (only !== "functional" && config.security.length > 0) {
      for (const suite of config.security) {
        await runSecuritySuite(config, suite, timeoutMs, cwd, security);
      }
    }
  } finally {
    await pool.closeAll();
  }

  const functionalPassed = functional.filter((t) => t.status === "pass").length;
  const functionalFailed = functional.filter((t) => t.status === "fail").length;
  const functionalErrored = functional.filter((t) => t.status === "error").length;
  const leaks = security.filter((s) => s.verdict === "leak").length;
  const suspicious = security.filter((s) => s.verdict === "suspicious").length;
  const probesOk = security.filter((s) => s.verdict === "ok").length;
  const probeErrors = security.filter((s) => s.verdict === "error").length;
  const anyBad = functionalFailed + functionalErrored + leaks + probeErrors > 0;

  return {
    version: VERSION,
    configPath: options.configPath,
    startedAt: startedAtIso,
    durationMs: Date.now() - wallStart,
    functional,
    security,
    summary: {
      functionalTotal: functional.length,
      functionalPassed,
      functionalFailed,
      functionalErrored,
      probesTotal: security.length,
      leaks,
      suspicious,
      probesOk,
      probeErrors,
      exitCode: anyBad ? 1 : 0,
    },
  };
}
