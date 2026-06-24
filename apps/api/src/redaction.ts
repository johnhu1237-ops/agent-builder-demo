const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /OPENAI_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi
];

export function redactSecrets(input: string, runtimeSecrets: string[] = []): string {
  let redacted = input;
  for (const secret of runtimeSecrets.filter(Boolean)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.includes("=")) {
        return match.replace(/=.*/, "=[REDACTED]");
      }
      if (match.includes(":")) {
        return match.replace(/:.*/, ": [REDACTED]");
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}
