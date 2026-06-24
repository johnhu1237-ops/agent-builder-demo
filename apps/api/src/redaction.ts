const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /OPENAI_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi
];

const SECRET_JSON_KEYS = new Set([
  "apikey",
  "openaiapikey",
  "authorization",
  "token",
  "secret"
]);

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

function isSecretJsonKey(key: string): boolean {
  return SECRET_JSON_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export function redactUnknownJson(value: unknown, key?: string, runtimeSecrets?: string[]): unknown {
  if (key != null && isSecretJsonKey(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactSecrets(value, runtimeSecrets ?? []);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknownJson(entry, undefined, runtimeSecrets));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        redactUnknownJson(nestedValue, nestedKey, runtimeSecrets)
      ])
    );
  }

  return value;
}
