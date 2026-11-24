import { describe, expect, it } from "vitest";
import {
  evaluateFileDeliveryContent,
  MAX_FILE_DELIVERY_CONTENT_BYTES,
  readFileDeliveryContent,
} from "./file-delivery-content.js";

const read = (text: string, mimeType: string) =>
  readFileDeliveryContent({ bytes: Buffer.from(text), mimeType });

describe("file-delivery content constraints", () => {
  it("parses actual CSV columns with escaped delimiters and multiline cells", () => {
    const content = read(
      '\ufeff"customer,name",amount,notes\r\n"Ada, Inc",12,"two\nlines"\r\n',
      "text/csv; charset=utf-8",
    );
    expect(content).toMatchObject({
      status: "read",
      format: "csv",
      rows: [
        ["customer,name", "amount", "notes"],
        ["Ada, Inc", "12", "two\nlines"],
      ],
    });
    expect(
      evaluateFileDeliveryContent(content, [
        { kind: "csv_columns", columns: ["customer,name", "amount"], minRows: 1 },
      ]),
    ).toMatchObject({ status: "verified" });
  });

  it("does not confuse a field name in a cell with a real column", () => {
    expect(
      evaluateFileDeliveryContent(read("notes\ncustomer,amount", "text/csv"), [
        { kind: "csv_columns", columns: ["customer"] },
      ]).status,
    ).toBe("unknown");
    expect(
      evaluateFileDeliveryContent(read('notes\n"customer,amount"', "text/csv"), [
        { kind: "csv_columns", columns: ["customer"] },
      ]).status,
    ).toBe("issue");
  });

  it("enforces the row count and every constraint", () => {
    expect(
      evaluateFileDeliveryContent(read("customer,amount", "text/csv"), [
        { kind: "text_nonempty" },
        { kind: "csv_columns", columns: ["customer"], minRows: 1 },
      ]).status,
    ).toBe("issue");
  });

  it.each(["a,a\n1,2", "a,b\n1", "a,b\n1,2,3"])(
    "leaves ambiguous CSV content unknown: %s",
    (text) => {
      expect(read(text, "text/csv")).toEqual({
        status: "unknown",
        reason: "content_unreadable",
      });
    },
  );

  it("checks literal JSON own fields, including null values", () => {
    expect(
      evaluateFileDeliveryContent(read('{"a.b":null,"count":0}', "application/json"), [
        { kind: "json_fields", fields: ["a.b", "count"] },
      ]).status,
    ).toBe("verified");
    expect(
      evaluateFileDeliveryContent(read('{"nested":{"count":2}}', "application/json"), [
        { kind: "json_fields", fields: ["count", "toString"] },
      ]).status,
    ).toBe("issue");
    expect(
      evaluateFileDeliveryContent(read('[{"count":2}]', "application/json"), [
        { kind: "json_fields", fields: ["count"] },
      ]).status,
    ).toBe("issue");
  });

  it("never repairs malformed JSON into verified evidence", () => {
    expect(read('{"count":2,}', "application/json")).toEqual({
      status: "unknown",
      reason: "content_unreadable",
    });
  });

  it.each(["", "  \r\n\t"])("rejects empty text content", (text) => {
    expect(
      evaluateFileDeliveryContent(read(text, "text/plain"), [{ kind: "text_nonempty" }]),
    ).toEqual({ status: "issue", reason: "content_constraint_mismatch" });
  });

  it("does not infer text, CSV or JSON from unsupported binary formats or metadata", () => {
    for (const mime of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
      "text/html",
    ]) {
      expect(read("count\n1", mime)).toMatchObject({
        status: "unknown",
        reason: "content_unsupported",
      });
    }
    expect(
      evaluateFileDeliveryContent(read('{"count":1}', "text/plain"), [
        { kind: "json_fields", fields: ["count"] },
      ]),
    ).toMatchObject({ status: "unknown", reason: "content_unsupported" });
  });

  it("rejects invalid UTF-8 and whole inputs above the limit instead of sampling", () => {
    expect(
      readFileDeliveryContent({ bytes: Uint8Array.of(0xc3, 0x28), mimeType: "text/plain" }),
    ).toEqual({ status: "unknown", reason: "content_unreadable" });
    expect(read("valid\0binary", "text/plain").status).toBe("unknown");
    expect(
      readFileDeliveryContent({
        bytes: new Uint8Array(MAX_FILE_DELIVERY_CONTENT_BYTES + 1),
        mimeType: "text/plain",
      }),
    ).toEqual({ status: "unknown", reason: "content_too_large" });
  });
});
