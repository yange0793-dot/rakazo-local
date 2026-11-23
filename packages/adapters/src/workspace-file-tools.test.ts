import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { readFileFromTool } from "./workspace-file-tools.js";

function fileWorkspace(content: string | Uint8Array, runSecrets: string[] = []) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const computer: ComputerRef = {
    id: "computer-1",
    botId: "bot-1",
    kind: "fake",
    providerRef: "test-sandbox",
  };
  const readFile = vi.fn(async () => bytes);
  const sandbox = { readFile } as unknown as SandboxProvider;
  const workspace: RunWorkspace = {
    botId: "bot-1",
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => {},
    context: {} as AdapterContext,
    runSecrets,
  };
  return { sandbox, workspace, readFile };
}

type ReadFileResult = {
  path?: string;
  content?: string;
  sha256?: string | null;
  sizeBytes?: number;
  error?: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  nextOffset?: number;
  note?: string;
};

/** Walk a file chunk by chunk the way the model would, following nextOffset. */
async function readFileInChunks(content: string, runSecrets: string[] = []) {
  const { sandbox, workspace } = fileWorkspace(content, runSecrets);
  const chunks: ReadFileResult[] = [];
  let offset: number | undefined;
  for (let call = 0; call < 60; call += 1) {
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      ...(offset === undefined ? {} : { offset }),
    })) as ReadFileResult;
    // No read_file result may reach the generic tool-result truncation.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(result.error).toBeUndefined();
    chunks.push(result);
    if (result.nextOffset === undefined) return chunks;
    expect(result.note).toContain(`offset: ${result.nextOffset}`);
    offset = result.nextOffset;
  }
  throw new Error("read_file never reached the end of the file");
}

describe("readFileFromTool ranges", () => {
  const referenceLines = Array.from(
    { length: 700 },
    (_, index) => `Entry ${String(index + 1).padStart(4, "0")} of the packaging reference guide.`,
  );
  const referenceText = referenceLines.join("\n");

  it.each([
    {
      name: "empty file",
      raw: "",
      content: "",
      sizeBytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      name: "one-byte file",
      raw: "a",
      content: "a",
      sizeBytes: 1,
      sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    },
    {
      name: "LF and a trailing newline",
      raw: "alpha\nbeta\n",
      content: "alpha\nbeta\n",
      sizeBytes: 11,
      sha256: "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee",
    },
    {
      name: "CRLF and a trailing newline",
      raw: "alpha\r\nbeta\r\n",
      content: "alpha\r\nbeta\r\n",
      sizeBytes: 13,
      sha256: "98ab4d3aeab1e120560e942e2df6a0db1147bf94bafcf1590000ffb3c2b6fc80",
    },
    {
      name: "no trailing newline",
      raw: "alpha\nbeta",
      content: "alpha\nbeta",
      sizeBytes: 10,
      sha256: "bbfb79e82216bd2db1ad2c507d44ddf80aeb12f64f9562056afe93aad43154d9",
    },
    {
      name: "multibyte UTF-8",
      raw: "中文😀\n",
      content: "中文😀\n",
      sizeBytes: 11,
      sha256: "ce87939749215576f653756eaccb2d2e1a4a8a8fea128af59b19adc3f614ef4f",
    },
    {
      name: "UTF-8 BOM",
      raw: "\uFEFFalpha\r\nbeta\r\n",
      content: "alpha\r\nbeta\r\n",
      sizeBytes: 16,
      sha256: "c3660080e3eee0ef1c03dd97ef4bb91bb952cf45f1ac2d52b2360e05fb201968",
    },
    {
      name: "byte view with a nonzero offset",
      raw: new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]).subarray(1, 4),
      content: "abc",
      sizeBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
  ])("returns full raw-byte metadata for $name", async ({ raw, content, sizeBytes, sha256 }) => {
    const { sandbox, workspace, readFile } = fileWorkspace(raw);
    const result = await readFileFromTool(sandbox, workspace, { path: "notes/raw.txt" });
    expect(result).toEqual({
      path: "notes/raw.txt",
      content,
      sha256,
      sizeBytes,
      totalLines: content.split("\n").length,
      startLine: 1,
      endLine: content.split("\n").length,
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(
      await workspace.computer(),
      "notes/raw.txt",
      workspace.context,
      { maxBytes: 250_000 },
    );
  });

  it("returns a 30 kB file in chunks that reassemble the exact original text", async () => {
    expect(new TextEncoder().encode(referenceText).byteLength).toBeGreaterThan(30_000);
    const chunks = await readFileInChunks(referenceText);
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.totalLines).toBe(referenceLines.length);
    expect(first.nextOffset).toBeGreaterThan(1);

    let expectedStart = 1;
    for (const chunk of chunks) {
      expect(chunk.sha256).toBe(createHash("sha256").update(referenceText).digest("hex"));
      expect(chunk.sizeBytes).toBe(new TextEncoder().encode(referenceText).byteLength);
      expect(chunk.startLine).toBe(expectedStart);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine!);
      expectedStart = chunk.endLine! + 1;
    }
    const last = chunks.at(-1)!;
    expect(last.endLine).toBe(referenceLines.length);
    expect(last.nextOffset).toBeUndefined();
    expect(chunks.map((chunk) => chunk.content).join("\n")).toBe(referenceText);
  });

  it("returns exactly the requested offset and limit lines", async () => {
    const { sandbox, workspace } = fileWorkspace(referenceText);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      offset: 20,
      limit: 5,
    })) as ReadFileResult;
    expect(result.content).toBe(referenceLines.slice(19, 24).join("\n"));
    expect(result.startLine).toBe(20);
    expect(result.endLine).toBe(24);
    expect(result.totalLines).toBe(referenceLines.length);
    expect(result.nextOffset).toBe(25);
    expect(result.sha256).toBe(createHash("sha256").update(referenceText).digest("hex"));
    expect(result.sizeBytes).toBe(new TextEncoder().encode(referenceText).byteLength);
  });

  it("clamps a requested range to the end of the file", async () => {
    const { sandbox, workspace } = fileWorkspace(referenceText);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      offset: referenceLines.length - 1,
      limit: 50,
    })) as ReadFileResult;
    expect(result.content).toBe(referenceLines.slice(-2).join("\n"));
    expect(result.endLine).toBe(referenceLines.length);
    expect(result.nextOffset).toBeUndefined();
  });

  it("returns a small file whole when no range is given", async () => {
    const text = "alpha\nbeta\ngamma";
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
    })) as ReadFileResult;
    expect(result).toEqual({
      path: "notes/short.txt",
      content: text,
      sha256: createHash("sha256").update(text).digest("hex"),
      sizeBytes: new TextEncoder().encode(text).byteLength,
      totalLines: 3,
      startLine: 1,
      endLine: 3,
    });
  });

  it("ignores range arguments that are not positive integers", async () => {
    const text = "alpha\nbeta\ngamma";
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
      offset: -2,
      limit: 1.5,
    })) as ReadFileResult;
    expect(result.content).toBe(text);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
  });

  it("redacts a secret that straddles a chunk boundary before the file is split", async () => {
    // Discover where the first chunk boundary falls, then put a secret across it.
    const plainChunks = await readFileInChunks(referenceText);
    const boundary = plainChunks[0]!.endLine!;
    const secret = "tok-live-boundary\nstraddle-secret";
    const lines = [...referenceLines];
    lines[boundary - 1] = `token: tok-live-boundary`;
    lines[boundary] = `straddle-secret ends the entry.`;
    const text = lines.join("\n");

    const chunks = await readFileInChunks(text, [secret]);
    const joined = chunks.map((chunk) => chunk.content).join("\n");
    expect(joined).not.toContain("tok-live-boundary");
    expect(joined).not.toContain("straddle-secret");
    expect(joined).toContain("[redacted]");
    expect(joined).toBe(redactSecrets(text, [secret]));
    for (const chunk of chunks) {
      expect(chunk.sha256).toBeNull();
      expect(chunk.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
      expect(chunk.note).toContain("sha256 omitted because secret redaction changed content");
    }
  });

  it("omits the raw digest even when the redacted secret is outside the requested page", async () => {
    const text = "public line\nprivate token: fixture-secret-value";
    const { sandbox, workspace } = fileWorkspace(text, ["fixture-secret-value"]);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/secret.txt",
      limit: 1,
    })) as ReadFileResult;
    expect(result.content).toBe("public line");
    expect(result.sha256).toBeNull();
    expect(result.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(result.note).toContain("sha256 omitted because secret redaction changed content");
    expect(result.nextOffset).toBe(2);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
  });

  it("keeps the raw digest when configured secrets do not change the content", async () => {
    const text = "public line\n";
    const { sandbox, workspace } = fileWorkspace(text, ["fixture-secret-value"]);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/public.txt",
    })) as ReadFileResult;
    expect(result.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(result.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(result.note).toBeUndefined();
  });

  it("returns a short redacted file with a null digest and its original byte count", async () => {
    const text = "token: fixture-secret-value\n";
    const { sandbox, workspace } = fileWorkspace(text, ["fixture-secret-value"]);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/secret.txt",
    })) as ReadFileResult;
    expect(result.content).toBe("token: [redacted]\n");
    expect(result.sha256).toBeNull();
    expect(result.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(result.note).toBe("sha256 omitted because secret redaction changed content");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
  });

  it("cuts a single line that alone exceeds the result limit and points past it", async () => {
    const text = `${"a".repeat(20_000)}\nshort tail line`;
    const chunks = await readFileInChunks(text);
    expect(chunks).toHaveLength(2);

    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(1);
    expect(first.totalLines).toBe(2);
    expect(first.content!.length).toBeLessThan(20_000);
    expect(first.note).toContain("longer than the result limit");
    expect(first.nextOffset).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.sha256).toBe(createHash("sha256").update(text).digest("hex"));
      expect(chunk.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
    }

    expect(chunks[1]!.content).toBe("short tail line");
    expect(chunks[1]!.startLine).toBe(2);
    expect(chunks[1]!.endLine).toBe(2);
    expect(chunks[1]!.nextOffset).toBeUndefined();
  });

  it("never exposes a secret that crosses the cut inside one oversized line", async () => {
    const secret = "tok-live-cutpoint-secret-000111222333444";
    // Find where the line is cut without redaction, then put the secret across that point:
    // cutting before redacting would leak the part of the secret in front of the cut.
    const unredacted = fileWorkspace("x".repeat(20_000));
    const probe = (await readFileFromTool(unredacted.sandbox, unredacted.workspace, {
      path: "logs/one-line.log",
    })) as ReadFileResult;
    const cut = probe.content!.length;
    const text = `${"x".repeat(cut - 20)}${secret}${"y".repeat(8_000)}`;
    const { sandbox, workspace } = fileWorkspace(text, [secret]);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "logs/one-line.log",
    })) as ReadFileResult;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(result.content).not.toContain(secret.slice(0, 6));
    expect(result.content).toContain("[redacted]");
    expect(result.sha256).toBeNull();
    expect(result.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(result.note).toContain("sha256 omitted because secret redaction changed content");
    expect(result.note).toContain("longer than the result limit");
    expect(result.nextOffset).toBeUndefined();
  });

  it("counts full-file metadata when a single line almost fits the result limit", async () => {
    const text = "x".repeat(TOOL_RESULT_TEXT_LIMIT - 150);
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/almost.txt",
    })) as ReadFileResult;
    expect(result.content!.length).toBeLessThan(text.length);
    expect(result.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(result.sizeBytes).toBe(text.length);
    expect(result.note).toContain("longer than the result limit");
    expect(JSON.stringify(result).length).toBe(TOOL_RESULT_TEXT_LIMIT);
  });

  it("budgets JSON escaping and a longer path when cutting a line", async () => {
    const text = '"\\\r\t\u0000😀'.repeat(3_000);
    const { sandbox, workspace } = fileWorkspace(text);
    const path = `${"folder/".repeat(80)}escaped.txt`;
    const result = (await readFileFromTool(sandbox, workspace, { path })) as ReadFileResult;
    expect(result.path).toBe(path);
    expect(result.content!.length).toBeLessThan(text.length);
    expect(text.startsWith(result.content!)).toBe(true);
    expect(result.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(result.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(JSON.stringify(result).length).toBeGreaterThan(TOOL_RESULT_TEXT_LIMIT - 6);
  });

  it("reports a clear error when offset is past the end of the file", async () => {
    const { sandbox, workspace } = fileWorkspace("alpha\nbeta\ngamma");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
      offset: 500,
    })) as ReadFileResult;
    expect(result.error).toContain("past the end");
    expect(result.totalLines).toBe(3);
  });
});
