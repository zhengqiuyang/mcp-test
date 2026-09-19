/**
 * Ref parsing for `mcp-test diff` / `mcp-test snapshot`.
 *
 * A "ref" is a full server spec string — exactly what you would paste into a
 * client config — for example:
 *
 *   npx -y @modelcontextprotocol/server-filesystem@2025.1.14 /srv/data
 *   pnpm dlx pkg@2.0.0
 *   uvx mcp-server-git --repo path/to/repo
 *   bunx pkg@latest
 *   docker run -i --rm mcp/server:1.4
 *   node ./server.js
 *
 * The parser splits the string into {command, args} the way a POSIX-ish shell
 * would (double and single quotes group arguments; backslash escapes inside
 * double quotes), so refs survive paths with spaces. Nothing is ever run
 * through a shell: the result feeds straight into McpStdioClient's
 * shell:false spawn, exactly like a configured server.
 *
 * Runner forms (`npx`, `pnpm dlx`, `uvx`, `bunx`, `docker`) are recognized
 * only so failure messages can be more helpful (first-run downloads, image
 * pulls) — any other command parses and spawns just as generically.
 */

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

/** A package-runner form we recognize for clearer error hints (never for behavior). */
export type RunnerForm = "npx" | "pnpm dlx" | "uvx" | "bunx" | "docker";

export interface ParsedRef {
  /** Executable to spawn (passed to child_process.spawn with shell: false). */
  command: string;
  /** Arguments for the executable. */
  args: string[];
  /** Recognized runner form, when the ref starts with one; null otherwise. */
  form: RunnerForm | null;
}

const DOUBLE_QUOTE = '"';
const SINGLE_QUOTE = "'";
const BACKSLASH = "\\";

/**
 * Split a command string into tokens, honoring double quotes, single quotes
 * and backslash handling appropriate to the platform:
 *
 *  - Windows (`windowsBackslash: true`, the default on win32): a backslash is
 *    a path separator, never an escape — `node "C:\Program Files\s.js"` and
 *    even unquoted `C:\path\to\s.js` keep every backslash.
 *  - POSIX (`windowsBackslash: false`): outside quotes a backslash protects
 *    the next character; inside double quotes it escapes only `\` and `"`.
 *
 * Empty refs and unterminated quotes throw RefError.
 */
export function splitCommandTokens(ref: string, options?: { windowsBackslash?: boolean }): string[] {
  const windowsBackslash = options?.windowsBackslash ?? process.platform === "win32";
  const tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  let i = 0;

  const pushToken = (): void => {
    if (hasCurrent) tokens.push(current);
    current = "";
    hasCurrent = false;
  };

  while (i < ref.length) {
    const char = ref[i];
    if (char === " " || char === "\t") {
      pushToken();
      i += 1;
      continue;
    }
    if (char === DOUBLE_QUOTE || char === SINGLE_QUOTE) {
      const quote = char;
      hasCurrent = true; // `"foo" bar` style: explicit empty string token when ""
      i += 1;
      let closed = false;
      while (i < ref.length) {
        const inner = ref[i];
        if (!windowsBackslash && inner === BACKSLASH && quote === DOUBLE_QUOTE && (ref[i + 1] === DOUBLE_QUOTE || ref[i + 1] === BACKSLASH)) {
          // POSIX double quotes: a backslash escapes quotes and itself only.
          current += ref[i + 1];
          i += 2;
          continue;
        }
        if (inner === quote) {
          closed = true;
          i += 1;
          break;
        }
        current += inner;
        i += 1;
      }
      if (!closed) throw new RefError(`unterminated ${quote === DOUBLE_QUOTE ? "double" : "single"} quote in server spec: ${ref}`);
      continue;
    }
    if (!windowsBackslash && char === BACKSLASH && i + 1 < ref.length) {
      // POSIX outside quotes: a backslash protects the next character.
      current += ref[i + 1];
      hasCurrent = true;
      i += 2;
      continue;
    }
    current += char;
    hasCurrent = true;
    i += 1;
  }
  pushToken();
  return tokens;
}

/**
 * Parse a server spec string into a spawnable {command, args}.
 * Throws RefError with a human-readable message on unusable input.
 */
export function parseRef(ref: string): ParsedRef {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new RefError("server spec is empty (expected something like: npx -y pkg@1.2.3, or node ./server.js)");
  }

  const tokens = splitCommandTokens(ref);
  if (tokens.length === 0) {
    throw new RefError(`server spec "${ref}" contains no command`);
  }
  const [command, ...args] = tokens;

  let form: RunnerForm | null = null;
  if (command === "npx" || command === "uvx" || command === "bunx" || command === "docker") {
    form = command;
  } else if (command === "pnpm" && args[0] === "dlx") {
    form = "pnpm dlx";
  }

  if (form !== null) {
    // Where the package/image token sits: directly after the runner, or after `dlx`.
    const targetIndex = form === "pnpm dlx" ? 1 : 0;
    if (args.length <= targetIndex) {
      const needs = form === "docker" ? "an image (e.g. docker run -i --rm mcp/server:1.4)" : `a package (e.g. ${form} pkg@1.2.3)`;
      throw new RefError(`"${form}" server spec needs ${needs}`);
    }
  }

  return { command, args, form };
}

/** Extra context for failure messages when a recognized runner form is involved. */
export function runnerHint(form: RunnerForm | null): string {
  switch (form) {
    case "npx":
    case "pnpm dlx":
    case "uvx":
    case "bunx":
      return `${form} downloads the package on first use — that time counts against the handshake timeout; retry, or pass a longer --timeout. Pinning an exact version (pkg@1.2.3) also makes the ref reproducible.`;
    case "docker":
      return "docker pulls the image on first use — that time counts against the handshake timeout; retry, or pass a longer --timeout.";
    default:
      return "";
  }
}
