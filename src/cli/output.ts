export type CliExitCode = 1 | 2;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  exit(code: CliExitCode): void;
}

export type OutputFormat = "markdown" | "json";

export interface CommandOutput {
  readonly kind?: string;
  readonly renderedMarkdown?: string | null;
  readonly structuredContent?: unknown;
  readonly [key: string]: unknown;
}

export const processIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  exit: (code) => {
    process.exitCode = code;
  },
};

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function writeCommandOutput(
  io: CliIo,
  value: CommandOutput,
  format: OutputFormat,
): void {
  if (value.kind === "ambiguous") {
    io.stdout(stableJson(value));
    io.exit(2);
    return;
  }

  if (format === "markdown" && typeof value.renderedMarkdown === "string") {
    io.stdout(ensureTrailingNewline(value.renderedMarkdown));
    return;
  }

  const machineValue = value.structuredContent === undefined
    ? value
    : value.structuredContent;
  io.stdout(stableJson(machineValue));
}

export async function executeCommand(
  io: CliIo,
  operation: () => Promise<CommandOutput>,
  format: OutputFormat | (() => OutputFormat) = "json",
): Promise<void> {
  try {
    const resolvedFormat = typeof format === "function" ? format() : format;
    writeCommandOutput(io, await operation(), resolvedFormat);
  } catch (error) {
    io.stderr(`${safeErrorCode(error)}\n`);
    io.exit(1);
  }
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)) return code;
  }
  return "command_failed";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
