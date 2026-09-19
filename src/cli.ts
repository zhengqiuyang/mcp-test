#!/usr/bin/env node
import { DEFAULT_CONFIG_PATH, ConfigError, loadConfig, type LoadedConfig } from "./config.js";
import { renderConsole, renderGithub, renderJson, renderStatusLine } from "./report.js";
import { runAll } from "./runner.js";
import { errMsg } from "./util.js";

const VERSION = "0.1.0";

const USAGE = `mcp-test ${VERSION} — functional + security testing for MCP servers

Usage:
  mcp-test [-c <config.yaml>] [--format console|json|github] [--only functional|security] [--timeout <ms>]

Options:
  -c, --config <path>   Config file (default: ./${DEFAULT_CONFIG_PATH})
  --format <fmt>        Output format: console (default), json, github
  --only <phase>        Run only one phase: functional or security
  --timeout <ms>        Per-request timeout in ms (overrides defaults.timeoutMs)
  -V, --version         Print version
  -h, --help            Show this help

Exit codes:
  0   all tests passed, no leaks found
  1   at least one test failed/errored, or a leak was detected
  2   configuration or harness error

Examples:
  mcp-test                                  # run ./mcp-test.yaml, human output
  mcp-test -c mcp-test.yaml --format github # GitHub Actions annotations on stdout
  mcp-test --only functional --format json  # just the functional phase, machine-readable`;

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

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
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
