import { spawn, type ChildProcess } from "node:child_process";
import { errMsg } from "./util.js";

/** How a request failed. The runner uses the kind to decide whether to restart a dead server. */
export type McpErrorKind = "spawn" | "exited" | "timeout" | "jsonrpc" | "closed" | "protocol";

export class McpClientError extends Error {
  public readonly kind: McpErrorKind;
  public readonly jsonRpcCode?: number;
  public readonly stderrTail?: string;

  constructor(init: { kind: McpErrorKind; message: string; jsonRpcCode?: number; stderrTail?: string }) {
    super(init.message);
    this.name = "McpClientError";
    this.kind = init.kind;
    this.jsonRpcCode = init.jsonRpcCode;
    this.stderrTail = init.stderrTail;
  }
}

/** Where and how to start an MCP server under test. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Normalized result of one `tools/call` round-trip. */
export interface CallToolResult {
  /** All `type: "text"` content items, concatenated with newlines. */
  text: string;
  /** `structuredContent` from the result, when the server sent one. */
  structured: unknown;
  isError: boolean;
  /** The raw JSON-RPC `result` object. */
  raw: unknown;
  latencyMs: number;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcp-test", version: "0.1.0" };
const HANDSHAKE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_CHARS = 4_000;
/** Guard against a server that streams endless bytes with no newline. */
const MAX_LINE_BUFFER_CHARS = 10_000_000;
const MAX_TOOLS_LIST_PAGES = 1_000;

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: McpClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Minimal MCP client for the stdio transport.
 *
 * The protocol is newline-delimited JSON-RPC 2.0 on the child's stdin/stdout;
 * stderr is captured (tail kept) for diagnostics. Server-initiated notifications
 * (messages with a method but no id) are ignored, responses are correlated by
 * request id, and every request has a timeout that rejects cleanly.
 */
export class McpStdioClient {
  private readonly server: McpServerConfig;
  private readonly requestTimeoutMs: number;
  private readonly spawnCwd?: string;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private connected = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  public serverInfo: { name?: string; version?: string } | null = null;
  public protocolVersion: string | null = null;

  constructor(server: McpServerConfig, options?: { requestTimeoutMs?: number; cwd?: string }) {
    this.server = server;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 15_000;
    this.spawnCwd = options?.cwd;
  }

  /** True once the child process has exited (for any reason). */
  get exited(): boolean {
    return this.exitInfo !== null;
  }

  /** Spawn the server and perform the MCP initialize handshake. */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new McpClientError({ kind: "protocol", message: "connect() was called twice on the same client." });
    }
    if (this.closed || this.exitInfo) {
      throw new McpClientError({ kind: "closed", message: "Client was closed; create a new client to reconnect." });
    }

    let proc: ChildProcess;
    try {
      proc = spawn(this.server.command, this.server.args, {
        shell: false,
        cwd: this.spawnCwd,
        env: { ...process.env, ...this.server.env },
        stdio: "pipe",
      });
    } catch (err) {
      throw new McpClientError({
        kind: "spawn",
        message: `Failed to spawn server command "${this.server.command}": ${errMsg(err)}`,
      });
    }
    this.proc = proc;

    const { stdout, stderr } = proc;
    if (!stdout || !stderr) {
      throw new McpClientError({ kind: "spawn", message: "spawn did not create stdio pipes for the server process." });
    }
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    stderr.on("data", (chunk: string) => {
      // Keep only the last few KB around for error reports.
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    proc.on("error", (err) => {
      this.failAllPending(
        new McpClientError({ kind: "spawn", message: `Server process error: ${errMsg(err)}`, stderrTail: this.stderrTail }),
      );
    });
    proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      const how = signal !== null ? `signal ${signal}` : `exit code ${code}`;
      this.failAllPending(
        new McpClientError({
          kind: "exited",
          message: `Server exited unexpectedly (${how}) while a request was in flight.`,
          stderrTail: this.stderrTail,
        }),
      );
    });

    const result: unknown = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      HANDSHAKE_TIMEOUT_MS,
    );

    if (isRecord(result)) {
      if (typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
      const info = result.serverInfo;
      if (isRecord(info)) {
        this.serverInfo = {
          name: typeof info.name === "string" ? info.name : undefined,
          version: typeof info.version === "string" ? info.version : undefined,
        };
      }
    }
    this.sendNotification("notifications/initialized");
    this.connected = true;
  }

  /** `tools/list`, following `nextCursor` pagination until the server stops offering one. */
  async listTools(): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
      const result: unknown = await this.request("tools/list", params);
      if (!isRecord(result)) {
        throw new McpClientError({ kind: "protocol", message: `tools/list result is not an object: ${JSON.stringify(result)}` });
      }
      const batch = Array.isArray(result.tools) ? result.tools : [];
      for (const tool of batch) {
        if (isRecord(tool) && typeof tool.name === "string") {
          tools.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : undefined,
            inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
          });
        }
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new McpClientError({ kind: "protocol", message: `tools/list pagination loop: server repeated cursor "${cursor}".` });
        }
        seenCursors.add(cursor);
      }
      pages += 1;
      if (pages > MAX_TOOLS_LIST_PAGES) {
        throw new McpClientError({ kind: "protocol", message: `tools/list paginated for more than ${MAX_TOOLS_LIST_PAGES} pages; giving up.` });
      }
    } while (cursor !== undefined);

    return tools;
  }

  /** `tools/call`, returning a normalized result with round-trip latency. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const startedAt = Date.now();
    const result: unknown = await this.request("tools/call", { name, arguments: args ?? {} });
    const latencyMs = Date.now() - startedAt;

    if (!isRecord(result)) {
      throw new McpClientError({ kind: "protocol", message: `tools/call result for "${name}" is not an object: ${JSON.stringify(result)}` });
    }
    const content = Array.isArray(result.content) ? result.content : [];
    let text = "";
    for (const item of content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        text = text === "" ? item.text : `${text}\n${item.text}`;
      }
    }
    return {
      text,
      structured: result.structuredContent,
      isError: result.isError === true,
      raw: result,
      latencyMs,
    };
  }

  /** End stdin and kill the whole server process tree. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    this.failAllPending(new McpClientError({ kind: "closed", message: "Client closed before a response arrived." }));
    const child = this.proc;
    if (!child || this.exitInfo || child.pid === undefined) return;

    try {
      child.stdin?.end();
    } catch {
      /* already destroyed */
    }

    if (process.platform === "win32") {
      // taskkill walks the whole process tree (servers may have grandchildren).
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.once("close", () => resolve());
        killer.once("error", () => resolve());
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      await new Promise<void>((resolve) => {
        const escalate = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 2_500);
        child.once("exit", () => {
          clearTimeout(escalate);
          resolve();
        });
      });
    }

    // Wait briefly for the exit event so callers can rely on `exited` right after close().
    await new Promise<void>((resolve) => {
      if (this.exitInfo) return resolve();
      const giveUp = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(giveUp);
        resolve();
      });
    });
  }

  // ----- internals ---------------------------------------------------------

  private request(method: string, params: unknown, timeoutMs: number = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(
          new McpClientError({
            kind: "timeout",
            message: `Timed out after ${timeoutMs}ms waiting for the response to "${method}" (request id ${id}).`,
            stderrTail: this.stderrTail,
          }),
        );
      }, timeoutMs);

      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.writeLine({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(err instanceof McpClientError ? err : new McpClientError({ kind: "closed", message: errMsg(err) }));
      }
    });
  }

  private sendNotification(method: string): void {
    this.writeLine({ jsonrpc: "2.0", method });
  }

  private writeLine(msg: unknown): void {
    const child = this.proc;
    const stdin = child?.stdin;
    if (!child || this.exitInfo || !stdin || stdin.destroyed) {
      throw new McpClientError({
        kind: "closed",
        message: "Cannot write to the server: the process is not running.",
        stderrTail: this.stderrTail,
      });
    }
    stdin.write(`${JSON.stringify(msg)}\n`, (err) => {
      if (err) {
        this.failAllPending(
          new McpClientError({
            kind: "closed",
            message: `Failed writing to the server's stdin: ${errMsg(err)}`,
            stderrTail: this.stderrTail,
          }),
        );
      }
    });
  }

  /** Buffer partial lines across stdout chunks; emit one handler call per complete line. */
  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    if (this.stdoutBuffer.length > MAX_LINE_BUFFER_CHARS) {
      this.failAllPending(
        new McpClientError({
          kind: "protocol",
          message: `Server wrote more than ${MAX_LINE_BUFFER_CHARS} characters without a newline; aborting to avoid unbounded buffering.`,
        }),
      );
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[mcp-test] server sent a non-JSON line on stdout; skipping: ${trimmed.slice(0, 200)}\n`);
      return;
    }
    if (!isRecord(msg) || msg.jsonrpc !== "2.0") {
      process.stderr.write(`[mcp-test] server sent a non-JSON-RPC message on stdout; skipping: ${trimmed.slice(0, 200)}\n`);
      return;
    }

    // Server push notification (method, no id): never a response to anything we asked.
    if (msg.method !== undefined && msg.id === undefined) return;

    // Server -> client request (method + id): we support none; politely decline per JSON-RPC.
    if (msg.method !== undefined && msg.id !== undefined) {
      try {
        this.writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `mcp-test client does not support server-initiated requests (${String(msg.method)})` },
        });
      } catch {
        /* process already gone */
      }
      return;
    }

    // A response. Correlate by id.
    if (msg.id === undefined) {
      process.stderr.write(`[mcp-test] server sent a response-shaped message with no id; skipping.\n`);
      return;
    }
    const entry = this.pending.get(String(msg.id));
    if (!entry) {
      process.stderr.write(`[mcp-test] server sent a response for unknown request id ${JSON.stringify(msg.id)}; skipping.\n`);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(String(msg.id));

    if (isRecord(msg.error)) {
      const code = typeof msg.error.code === "number" ? msg.error.code : undefined;
      const message = typeof msg.error.message === "string" ? msg.error.message : JSON.stringify(msg.error);
      entry.reject(
        new McpClientError({
          kind: "jsonrpc",
          message: `JSON-RPC error for "${entry.method}" (request id ${String(msg.id)}): ${message}${code !== undefined ? ` [code ${code}]` : ""}`,
          jsonRpcCode: code,
          stderrTail: this.stderrTail,
        }),
      );
      return;
    }
    entry.resolve(msg.result);
  }

  private failAllPending(err: McpClientError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}
