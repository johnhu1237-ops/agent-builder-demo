import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redaction";

describe("redactSecrets", () => {
  it("replaces runtime secrets directly", () => {
    expect(redactSecrets("token sk-live-secret-value", ["sk-live-secret-value"])).toBe(
      "token [REDACTED]"
    );
  });

  it("redacts common secret key patterns", () => {
    const input = `OPENAI_API_KEY=sk-secret-value
apiKey: sk-another-secret
api_key="sk-third-secret"`;

    const redacted = redactSecrets(input);

    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("apiKey: [REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).not.toContain("sk-secret-value");
    expect(redacted).not.toContain("sk-another-secret");
    expect(redacted).not.toContain("sk-third-secret");
  });
});
