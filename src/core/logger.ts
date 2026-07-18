export function redact(message: string, loadedSecrets: readonly string[] = []): string {
  const structural = message
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, "$1[REDACTED]@")
    .replace(/(Authorization:\s*)(?:Bearer\s+)?\S+/gi, "$1[REDACTED]")
    .replace(/((?:Set-)?Cookie:\s*)\S+/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );

  return loadedSecrets
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), structural);
}

export function log(
  level: "info" | "warn" | "error",
  message: string,
  loadedSecrets: readonly string[] = [],
): void {
  process.stderr.write(
    `${JSON.stringify({ level, message: redact(message, loadedSecrets) })}\n`,
  );
}
