import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptApiKey, encryptApiKey } from "../encryption";

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes

describe("encryption", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.LLM_API_KEY_ENCRYPTION_KEY;
    process.env.LLM_API_KEY_ENCRYPTION_KEY = VALID_KEY;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_API_KEY_ENCRYPTION_KEY;
    } else {
      process.env.LLM_API_KEY_ENCRYPTION_KEY = original;
    }
  });

  it("round-trips a plaintext value", () => {
    const encrypted = encryptApiKey("sk-secret-123");
    expect(encrypted).not.toContain("sk-secret-123");
    expect(encrypted.split(":")).toHaveLength(3);
    expect(decryptApiKey(encrypted)).toBe("sk-secret-123");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptApiKey("same")).not.toBe(encryptApiKey("same"));
  });

  it("throws on a malformed encrypted value", () => {
    expect(() => decryptApiKey("not-valid")).toThrow("Invalid encrypted API key format");
  });

  it("throws when the master key is missing", () => {
    delete process.env.LLM_API_KEY_ENCRYPTION_KEY;
    expect(() => encryptApiKey("x")).toThrow(
      "LLM_API_KEY_ENCRYPTION_KEY environment variable is required"
    );
  });

  it("throws when the master key is the wrong length", () => {
    process.env.LLM_API_KEY_ENCRYPTION_KEY = "abc123";
    expect(() => encryptApiKey("x")).toThrow(
      "LLM_API_KEY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  });

  it("fails authentication when decrypted with a different key", () => {
    const encrypted = encryptApiKey("sk-secret-123");
    process.env.LLM_API_KEY_ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptApiKey(encrypted)).toThrow();
  });
});
