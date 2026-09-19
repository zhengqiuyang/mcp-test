#!/usr/bin/env node
import { DEFAULT_CONFIG_PATH, ConfigError, loadConfig, type LoadedConfig } from "./config.js";
import {
  SnapshotError,
  buildDiffOutcome,
  captureLiveSnapshot,
  formatRefFailure,
  parseSnapshotFile,
  renderDiffConsole,
  renderDiffJson,
  writeSnapshotFile,
  type DiffSide,
  type Snapshot,
} from "./diff.js";
import { RefError } from "./refparse.js";
import { renderConsole, renderGithub, renderJson, renderStatusLine } from "./report.js";
import { runAll } from "./runner.js";
import { errMsg } from "./util.js";

const VERSION = "0.2.0";

const SNAPSHOT_USAGE = `mcp-test snapshot ${VERSION} — capture a server's tool surface as versioned JSON

Usage:
  mcp-test snapshot --command "<ref>" [-o <snap.json>]

A ref is a full server spec string, exactly what you would paste into a client
config:  npx -y pkg@1.2.3 · pnpm dlx pkg@2.0.0 · uvx mcp-server-git ·
bunx pkg@latest · docker run -i --rm mcp/server:1.4 · node ./server.js
Refs inherit this process's environment (env: FOO=1 mcp-test diff … works).

Options:
  --command <ref>       Server spec to connect to (required)
  -o, --output <path>   Write the snapshot here (default: stdout)
  --timeout <ms>        Per-request timeout in ms (default: 15000)
  -h, --help            Show this help

The snapshot ({"$schema": …, "version": 1, tools sorted by name}) is the
interchange format for \`mcp-test diff\` — store it in git or your lockfile at
pin time, then diff it against a candidate before upgrading.`;

const DIFF_USAGE = `mcp-test diff ${VERSION} — schema-drift upgrade gate (old vs new tool surface)

Usage:
  mcp-test diff --old "<ref>" --new "<ref>"
  mcp-test diff --snapshot <old.json> --new "<ref>"

Connects to both sides over stdio (or reads the stored snapshot), diffs
tools/list, and classifies every change:

  ✗ BREAKING  tool removed · +required prop · required prop removed ·
              property type changed · enum narrowed
  + ADDITIVE  tool added · +optional prop · enum widened
  ~ CHANGED   description-only differences (cosmetic, never gates)

Options:
  --old <ref>           Old server spec (live), e.g. "npx -y pkg@1.2.3"
  --snapshot <path>     Old side from a snapshot file (alternative to --old)
  --new <ref>           New/candidate server spec (live)
  --format <fmt>        Output format: console (default) or json
  --fail-on additive    Also exit 1 when additive changes are present
  --timeout <ms>        Per-request timeout in ms (default: 15000)
  -h, --help            Show this help

Exit codes:
  0   no breaking changes (and, with --fail-on additive, no additive changes)
  1   breaking changes present (or additive, with --fail-on additive)
  2   bad usage, unreadable snapshot, or a side that cannot be connected to`;

const USAGE = `mcp-test ${VERSION} — functional + security testing for MCP servers

Usage:
  mcp-test [-c <config.yaml>] [--format console|json|github] [--only functional|security] [--timeout <ms>]
  mcp-test snapshot --command "<ref>" [-o <snap.json>]     capture a tool surface
  mcp-test diff (--old "<ref>" | --snapshot <old.json>) --new "<ref>"
                                                            schema-drift upgrade gate

Options:
  -c, --config <path>   Config file (default: ./${DEFAULT_CONFIG_PATH})
  --format <fmt>        Output format: console (default), json, github
  --only <phase>        Run only one phase: functional or security
  --timeout <ms>        Per-request timeout in ms (overrides defaults.timeoutMs)
  -V, --version         Print version
  -h, --help            Show this help

Exit codes:
  0   all tests passed, no leaks found / diff found no breaking changes
  1   at least one test failed/errored, a leak was detected, or breaking changes
  2   configuration or harness error

Examples:
  mcp-test                                  # run ./mcp-test.yaml, human output
  mcp-test -c mcp-test.yaml --format github # GitHub Actions annotations on stdout
  mcp-test --only functional --format json  # just the functional phase, machine-readable
  mcp-test snapshot --command "npx -y pkg@1.2.3" -o pinned.json
  mcp-test diff --snapshot pinned.json --new "npx -y pkg@1.3.0"`;

interface CliArgs {
  configPath?: string;
  format: "console" | "json" | "github";
  only: "all" | "functional" | "security";
  timeoutMs?: number;
  showVersion?: boolean;
  showHelp?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { format: "console", only: "all" };
  const needValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-c":
      case "--config":
        args.configPath = needValue(i, arg);
        i += 1;
        break;
      case "--format": {
        const value = needValue(i, arg);
        if (value !== "console" && value !== "json" && value !== "github") {
          throw new Error(`--format must be console, json or github (got "${value}")`);
        }
        args.format = value;
        i += 1;
        break;
      }
      case "--only": {
        const value = needValue(i, arg);
        if (value !== "functional" && value !== "security") {
          throw new Error(`--only must be functional or security (got "${value}")`);
        }
        args.only = value;
        i += 1;
        break;
      }
      case "--timeout": {
        const raw = needValue(i, arg);
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`--timeout must be a positive number of ms (got "${raw}")`);
        args.timeoutMs = value;
        i += 1;
        break;
      }
      case "-V":
      case "--version":
        args.showVersion = true;
        break;
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }
  return args;
}

function reportConfigError(err: ConfigError): void {
  process.stderr.write(`mcp-test: configuration is invalid:\n`);
  for (const problem of err.errors) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write(`\n`);
}

// ---------------------------------------------------------------------------
// `mcp-test snapshot`
// ---------------------------------------------------------------------------

interface SnapshotArgs {
  ref?: string;
  output?: string;
  timeoutMs?: number;
  showHelp?: boolean;
}

function parseSnapshotArgs(argv: string[]): SnapshotArgs {
  const args: SnapshotArgs = {};
  const needValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--command":
        args.ref = needValue(i, arg);
        i += 1;
        break;
      case "-o":
      case "--output":
        args.output = needValue(i, arg);
        i += 1;
        break;
      case "--timeout": {
        const raw = needValue(i, arg);
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`--timeout must be a positive number of ms (got "${raw}")`);
        args.timeoutMs = value;
        i += 1;
        break;
      }
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      default:
        throw new Error(`unknown snapshot argument "${arg}"\n\n${SNAPSHOT_USAGE}`);
    }
  }
  if (args.ref === undefined && args.showHelp !== true) {
    throw new Error(`--command <ref> is required (e.g. --command "npx -y pkg@1.2.3")\n\n${SNAPSHOT_USAGE}`);
  }
  return args;
}

async function runSnapshotCommand(argv: string[]): Promise<void> {
  let args: SnapshotArgs;
  try {
    args = parseSnapshotArgs(argv);
  } catch (err) {
    process.stderr.write(`mcp-test snapshot: ${errMsg(err)}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.showHelp === true) {
    process.stdout.write(`${SNAPSHOT_USAGE}\n`);
    return;
  }

  let captured: Awaited<ReturnType<typeof captureLiveSnapshot>>;
  try {
    captured = await captureLiveSnapshot(args.ref as string, { timeoutMs: args.timeoutMs });
  } catch (err) {
    const message = err instanceof RefError ? `invalid server spec: ${errMsg(err)}` : formatRefFailure("target", args.ref as string, err);
    process.stderr.write(`mcp-test snapshot: ${message}\n`);
    process.exitCode = 2;
    return;
  }

  const snapshot = captured.snapshot;
  if (args.output !== undefined) {
    try {
      writeSnapshotFile(args.output, snapshot);
    } catch (err) {
      process.stderr.write(`mcp-test snapshot: cannot write "${args.output}": ${errMsg(err)}\n`);
      process.exitCode = 2;
      return;
    }
    const who = [snapshot.serverInfo.name, snapshot.serverInfo.version].filter(Boolean).join(" ");
    process.stderr.write(`snapshot written to ${args.output} — ${snapshot.tools.length} tool${snapshot.tools.length === 1 ? "" : "s"}${who !== "" ? ` from ${who}` : ""}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// `mcp-test diff`
// ---------------------------------------------------------------------------

interface DiffArgs {
  oldRef?: string;
  snapshotPath?: string;
  newRef?: string;
  format: "console" | "json";
  failOn: "breaking" | "additive";
  timeoutMs?: number;
  showHelp?: boolean;
}

function parseDiffArgs(argv: string[]): DiffArgs {
  const args: DiffArgs = { format: "console", failOn: "breaking" };
  const needValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--old":
        args.oldRef = needValue(i, arg);
        i += 1;
        break;
      case "--snapshot":
        args.snapshotPath = needValue(i, arg);
        i += 1;
        break;
      case "--new":
        args.newRef = needValue(i, arg);
        i += 1;
        break;
      case "--format": {
        const value = needValue(i, arg);
        if (value !== "console" && value !== "json") {
          throw new Error(`--format must be console or json for diff (got "${value}")`);
        }
        args.format = value;
        i += 1;
        break;
      }
      case "--fail-on": {
        const value = needValue(i, arg);
        if (value !== "additive") throw new Error(`--fail-on must be "additive" (got "${value}")`);
        args.failOn = value;
        i += 1;
        break;
      }
      case "--timeout": {
        const raw = needValue(i, arg);
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`--timeout must be a positive number of ms (got "${raw}")`);
        args.timeoutMs = value;
        i += 1;
        break;
      }
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      default:
        throw new Error(`unknown diff argument "${arg}"\n\n${DIFF_USAGE}`);
    }
  }
  if (args.showHelp !== true) {
    if (args.oldRef === undefined && args.snapshotPath === undefined) {
      throw new Error(`exactly one of --old <ref> or --snapshot <path> is required\n\n${DIFF_USAGE}`);
    }
    if (args.oldRef !== undefined && args.snapshotPath !== undefined) {
      throw new Error(`--old and --snapshot are mutually exclusive (pick one for the old side)\n\n${DIFF_USAGE}`);
    }
    if (args.newRef === undefined) {
      throw new Error(`--new <ref> is required (e.g. --new "npx -y pkg@2.0.0")\n\n${DIFF_USAGE}`);
    }
  }
  return args;
}

async function runDiffCommand(argv: string[]): Promise<void> {
  let args: DiffArgs;
  try {
    args = parseDiffArgs(argv);
  } catch (err) {
    process.stderr.write(`mcp-test diff: ${errMsg(err)}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.showHelp === true) {
    process.stdout.write(`${DIFF_USAGE}\n`);
    return;
  }

  const failHard = (message: string): void => {
    process.stderr.write(`mcp-test diff: ${message}\n`);
    process.exitCode = 2;
  };

  // Load both sides concurrently: a snapshot file resolves immediately, two
  // live servers (e.g. two npx cold starts) connect in parallel.
  const loadOld = async (): Promise<{ snapshot: Snapshot; side: DiffSide }> => {
    if (args.snapshotPath !== undefined) {
      const snapshot = parseSnapshotFile(args.snapshotPath);
      return {
        snapshot,
        side: {
          source: args.snapshotPath,
          kind: "snapshot",
          serverInfo: snapshot.serverInfo,
          capturedAt: snapshot.capturedAt,
        },
      };
    }
    const captured = await captureLiveSnapshot(args.oldRef as string, { timeoutMs: args.timeoutMs });
    return {
      snapshot: captured.snapshot,
      side: { source: args.oldRef as string, kind: "live", serverInfo: captured.snapshot.serverInfo },
    };
  };
  const loadNew = async (): Promise<{ snapshot: Snapshot; side: DiffSide }> => {
    const captured = await captureLiveSnapshot(args.newRef as string, { timeoutMs: args.timeoutMs });
    return {
      snapshot: captured.snapshot,
      side: { source: args.newRef as string, kind: "live", serverInfo: captured.snapshot.serverInfo },
    };
  };

  const [oldResult, newResult] = await Promise.allSettled([loadOld(), loadNew()]);
  if (oldResult.status !== "fulfilled" || newResult.status !== "fulfilled") {
    const parts: string[] = [];
    const sides: Array<{ label: string; refString: string; result: typeof oldResult | typeof newResult }> = [
      { label: "old", refString: (args.snapshotPath ?? args.oldRef) as string, result: oldResult },
      { label: "new", refString: args.newRef as string, result: newResult },
    ];
    for (const side of sides) {
      if (side.result.status !== "rejected") continue;
      const err: unknown = side.result.reason;
      parts.push(
        err instanceof SnapshotError || err instanceof RefError ? errMsg(err) : formatRefFailure(side.label, side.refString, err),
      );
    }
    failHard(parts.join("\n"));
    return;
  }
  const oldSide = oldResult.value;
  const newSide = newResult.value;

  const outcome = buildDiffOutcome(oldSide.snapshot, newSide.snapshot, oldSide.side, newSide.side, { failOn: args.failOn });
  if (args.format === "json") {
    process.stdout.write(renderDiffJson(outcome));
  } else {
    process.stdout.write(renderDiffConsole(outcome));
  }
  process.exitCode = outcome.exitCode;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "snapshot") {
    await runSnapshotCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "diff") {
    await runDiffCommand(argv.slice(1));
    return;
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`mcp-test: ${errMsg(err)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.showVersion === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.showHelp === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(args.configPath ?? DEFAULT_CONFIG_PATH);
  } catch (err) {
    if (err instanceof ConfigError) {
      reportConfigError(err);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const result = await runAll(loaded.config, {
    configPath: loaded.path,
    only: args.only,
    timeoutMs: args.timeoutMs,
  });

  switch (args.format) {
    case "json":
      process.stdout.write(`${renderJson(result)}\n`);
      process.stderr.write(`${renderStatusLine(result)}\n`);
      break;
    case "github":
      process.stdout.write(renderGithub(result, { configPath: loaded.path, configText: loaded.text }));
      process.stderr.write(`${renderStatusLine(result)}\n`);
      break;
    default:
      process.stdout.write(renderConsole(result));
      break;
  }

  process.exitCode = result.summary.exitCode;
}

main().catch((err: unknown) => {
  process.stderr.write(`mcp-test: internal error: ${errMsg(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 2;
});
