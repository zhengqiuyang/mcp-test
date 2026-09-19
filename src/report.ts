import type { RunResult, SecurityProbeOutcome } from "./runner.js";
import { toSingleLine, truncate } from "./util.js";

const COLORS_ENABLED = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: string, text: string): string {
  return COLORS_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const BOLD = "1";
const DIM = "2";
const RED = "31";
const GREEN = "32";
const YELLOW = "33";
const CYAN = "36";

/** Human-oriented console report (ANSI colors when stdout is a TTY). */
export function renderConsole(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`${paint(BOLD, `mcp-test ${result.version}`)} ${paint(DIM, `— ${result.configPath}`)}`);
  lines.push("");

  if (result.functional.length > 0) {
    lines.push(paint(BOLD, "FUNCTIONAL TESTS"));
    for (const test of result.functional) {
      const mark = test.status === "pass" ? paint(GREEN, "✓") : paint(RED, "✗");
      const parts = [test.server, test.kind === "list" ? "tools/list" : test.tool];
      if (test.latencyMs !== undefined) parts.push(`${test.latencyMs}ms`);
      lines.push(`  ${mark} ${test.name} ${paint(DIM, `(${parts.filter(Boolean).join(" · ")})`)}`);
      if (test.error !== undefined) {
        for (const line of test.error.split("\n")) lines.push(`      ${paint(RED, line)}`);
      }
      for (const assertion of test.assertions) {
        if (assertion.pass) continue;
        lines.push(`      ${paint(RED, assertion.label)}: expected ${toSingleLine(assertion.expected ?? "")}`);
        if (assertion.actual !== undefined) {
          lines.push(`        ${paint(DIM, "actual:")} ${paint(YELLOW, truncate(toSingleLine(assertion.actual), 500))}`);
        }
      }
    }
    lines.push("");
  }

  if (result.security.length > 0) {
    lines.push(paint(BOLD, "SECURITY PROBES"));
    const suites = new Map<string, SecurityProbeOutcome[]>();
    for (const outcome of result.security) {
      const key = `${outcome.server}/${outcome.tool}`;
      const list = suites.get(key) ?? [];
      list.push(outcome);
      suites.set(key, list);
    }
    for (const [key, outcomes] of suites) {
      lines.push(paint(CYAN, `  ${key.replace("/", " / ")}`));
      for (const outcome of outcomes) {
        let mark: string;
        if (outcome.verdict === "leak") mark = paint(RED, "✗ LEAK      ");
        else if (outcome.verdict === "suspicious") mark = paint(YELLOW, "! SUSPICIOUS");
        else if (outcome.verdict === "error") mark = paint(RED, "⚠ ERROR     ");
        else mark = paint(GREEN, "✓ ok        ");
        lines.push(`    ${mark} ${outcome.probeId} ${paint(DIM, `— ${outcome.title}`)}`);
        if (outcome.detector !== undefined && outcome.verdict !== "ok") {
          lines.push(`        ${paint(DIM, "detector:")} ${outcome.detector}`);
        }
        if (outcome.evidence !== undefined && outcome.verdict !== "ok") {
          const color = outcome.verdict === "leak" ? RED : YELLOW;
          lines.push(`        ${paint(DIM, "evidence:")} ${paint(color, truncate(toSingleLine(outcome.evidence), 200))}`);
        }
        if (outcome.error !== undefined) {
          lines.push(`        ${paint(RED, truncate(toSingleLine(outcome.error), 300))}`);
        }
      }
    }
    lines.push("");
  }

  const summary = result.summary;
  lines.push(paint(BOLD, "SUMMARY"));
  lines.push(
    `  functional: ${summary.functionalPassed}/${summary.functionalTotal} passed` +
      ` · ${summary.functionalFailed} failed · ${summary.functionalErrored} errored`,
  );
  lines.push(
    `  security:   ${summary.probesTotal} probes · ${summary.leaks} leaks` +
      ` · ${summary.suspicious} suspicious · ${summary.probesOk} ok · ${summary.probeErrors} errored`,
  );
  lines.push(`  exit code: ${summary.exitCode === 0 ? paint(GREEN, "0") : paint(RED, String(summary.exitCode))}`);
  lines.push("");
  return lines.join("\n");
}

/** Full structured results, valid JSON, the only thing written to stdout in --format json mode. */
export function renderJson(result: RunResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// GitHub Actions annotations
// ---------------------------------------------------------------------------

function escapePropertyValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/,/g, "%2C").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeMessage(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function findYamlLine(configText: string, needle: string): number | undefined {
  const lines = configText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return undefined;
}

/**
 * GitHub Actions workflow commands (`::error …` / `::warning …`) for functional
 * failures, security leaks and probe errors. Intended for stdout in CI.
 */
export function renderGithub(result: RunResult, ctx: { configPath: string; configText: string }): string {
  const out: string[] = [];
  const file = escapePropertyValue(ctx.configPath.replace(/\\/g, "/"));

  for (const test of result.functional) {
    if (test.status === "pass") continue;
    const line =
      findYamlLine(ctx.configText, `- name: ${test.name}`) ?? findYamlLine(ctx.configText, test.name);
    const details =
      test.error !== undefined
        ? [toSingleLine(test.error)]
        : test.assertions
            .filter((assertion) => !assertion.pass)
            .map((assertion) => `${assertion.label}: expected ${toSingleLine(assertion.expected ?? "")}, actual ${toSingleLine(assertion.actual ?? "")}`);
    out.push(
      `::error file=${file}${line !== undefined ? `,line=${line}` : ""},title=${escapePropertyValue(`mcp-test: ${test.name} (${test.status})`)}::${escapeMessage(
        `[${test.server}] ${details.join(" | ") || "test failed"}`,
      )}`,
    );
  }

  for (const probe of result.security) {
    if (probe.verdict === "ok" || probe.verdict === "suspicious") {
      if (probe.verdict === "ok") continue;
      const line = findYamlLine(ctx.configText, `tool: ${probe.tool}`);
      out.push(
        `::warning file=${file}${line !== undefined ? `,line=${line}` : ""},title=${escapePropertyValue(`mcp-test: suspicious ${probe.probeId} (${probe.tool})`)}::${escapeMessage(
          `${probe.detector ? `detector ${probe.detector}: ` : ""}${toSingleLine(probe.evidence ?? "suspicious response")}`,
        )}`,
      );
      continue;
    }
    const line = findYamlLine(ctx.configText, `tool: ${probe.tool}`);
    const body =
      probe.verdict === "error"
        ? toSingleLine(probe.error ?? "probe failed to run")
        : `${probe.detector ? `detector ${probe.detector}: ` : ""}${toSingleLine(probe.evidence ?? "leaky response")}`;
    out.push(
      `::error file=${file}${line !== undefined ? `,line=${line}` : ""},title=${escapePropertyValue(`mcp-test: LEAK ${probe.probeId} (${probe.tool})`)}::${escapeMessage(body)}`,
    );
  }

  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/** One-line status for stderr when stdout is machine-formatted (github/json modes). */
export function renderStatusLine(result: RunResult): string {
  const s = result.summary;
  return `mcp-test: functional ${s.functionalPassed}/${s.functionalTotal} passed, ${s.functionalFailed} failed, ${s.functionalErrored} errored; security: ${s.leaks} leaks, ${s.suspicious} suspicious, ${s.probeErrors} errored; exit code ${s.exitCode}`;
}
