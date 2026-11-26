import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

const context = {
  operationId: "operation",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  signal: new AbortController().signal,
};

describe("EncryptedSecretStore", () => {
  it("accepts complete legacy records and rejects a short authentication tag", async () => {
    const password = "test-only-encryption-key";
    const store = new EncryptedSecretStore(password);
    const iv = Buffer.alloc(12);
    const key = crypto.createHash("sha256").update(password).digest();
    for (const plaintext of ["", "legacy value"]) {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const record = Buffer.concat([iv, tag, encrypted]).toString("base64");
      await expect(store.load(record, "legacy")).resolves.toBe(plaintext);
      if (!plaintext) {
        const truncated = Buffer.concat([iv, tag.subarray(0, 12)]).toString("base64");
        await expect(store.load(truncated, "legacy")).rejects.toThrow(
          "Encrypted secret is malformed",
        );
      }
    }
  });

  it("derives each record's key once however often it is read", async () => {
    const store = new EncryptedSecretStore("test-only-encryption-key");
    const records = await Promise.all(
      ["one", "two", "three"].map((value) => store.put(value, context, { recordId: value })),
    );
    vi.mocked(crypto.scrypt).mockClear();

    // A list reads every item at once, and the next list reads them all again.
    for (let pass = 0; pass < 2; pass++) {
      await expect(
        Promise.all(records.map((record) => store.load(record.ciphertext, record.id))),
      ).resolves.toEqual(["one", "two", "three"]);
    }
    await expect(store.load(records[0]!.ciphertext, records[0]!.id)).resolves.toBe("one");

    expect(crypto.scrypt).toHaveBeenCalledTimes(3);
  });

  it("still authenticates the record a cached key opens", async () => {
    const store = new EncryptedSecretStore("test-only-encryption-key");
    const record = await store.put("value", context, { recordId: "record" });
    await store.load(record.ciphertext, record.id);

    await expect(store.load(record.ciphertext, "another-record")).rejects.toThrow();
  });
});
