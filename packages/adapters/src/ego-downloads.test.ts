import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EGO_DOWNLOAD_HELPERS } from "./ego-downloads.js";

type SavedEntry = {
  name?: string;
  path?: string;
  size?: number;
  error?: string;
};

type StartWatch = (
  page: unknown,
  root: unknown,
  directory: unknown,
) => Promise<{ collect: (wait?: boolean) => Promise<SavedEntry[]> }>;

/**
 * Loads the helper source the way the ego Node script runs it: a real ES module, so its own
 * `import("node:path")` works. The source reads `fs`, `input` and `message` from the surrounding
 * script, so it is wrapped in a factory that provides them.
 */
async function startHelpers(
  overrides: { rm?: (target: string) => Promise<void> } = {},
): Promise<StartWatch> {
  const real = await import("node:fs/promises");
  const fs = { ...real, ...overrides };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-ego-downloads-helper-"));
  const file = path.join(dir, "helper.mjs");
  await writeFile(
    file,
    `export default (fs, input, message) => {\n${EGO_DOWNLOAD_HELPERS}\nreturn startDownloadWatch;\n};\n`,
    "utf8",
  );
  try {
    const loaded = (await import(pathToFileURL(file).href)) as {
      default: (fs: unknown, input: unknown, message: unknown) => StartWatch;
    };
    return loaded.default(fs, {}, message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type FakeDownloadOptions = {
  name?: string;
  content?: string;
  saveError?: Error;
  deleteError?: Error;
  cancelError?: Error;
};

class FakeDownload {
  fileName: string;
  content: string;
  saveError: Error | undefined;
  deleteError: Error | undefined;
  cancelError: Error | undefined;
  savedPath: string | undefined;
  deleted = false;
  canceled = false;
  deleteCalls = 0;
  cancelCalls = 0;

  constructor(options: FakeDownloadOptions = {}) {
    this.fileName = options.name ?? "file.txt";
    this.content = options.content ?? "downloaded";
    this.saveError = options.saveError;
    this.deleteError = options.deleteError;
    this.cancelError = options.cancelError;
  }

  suggestedFilename() {
    return this.fileName;
  }

  async saveAs(target: string) {
    // A failed save can still leave a partial file, as a browser download can.
    await writeFile(target, this.content);
    this.savedPath = target;
    if (this.saveError) throw this.saveError;
  }

  async delete() {
    this.deleteCalls += 1;
    if (this.deleteError) throw this.deleteError;
    this.deleted = true;
  }

  async cancel() {
    this.cancelCalls += 1;
    if (this.cancelError) throw this.cancelError;
    this.canceled = true;
  }
}

/** The two page members the helper uses: its one event waiter, plus the outcomes this call sees. */
function fakePage(outcome: { download?: FakeDownload; error?: Error } = {}) {
  const armed: Array<{ event: string; timeout: number | undefined }> = [];
  const page = {
    waitForEvent(event: string, options: { timeout?: number } = {}) {
      armed.push({ event, timeout: options.timeout });
      if (outcome.error) return Promise.reject(outcome.error);
      if (outcome.download) return Promise.resolve(outcome.download);
      return Promise.reject(
        new Error(`page.waitForEvent("${event}") timed out after ${options.timeout}ms`),
      );
    },
  };
  return { page, armed };
}

describe("ego download helpers", () => {
  let root: string;
  let start: StartWatch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-ego-downloads-"));
    start = await startHelpers();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not wait for an unobserved download during an ordinary action", async () => {
    let settle!: (download: FakeDownload) => void;
    const page = {
      waitForEvent: () =>
        new Promise<FakeDownload>((resolve) => {
          settle = resolve;
        }),
    };
    const watch = await start(page, root, "Downloads");
    await expect(watch.collect(false)).resolves.toEqual([]);
    // Explicit download calls keep waiting for the pre-armed event.
    const waiting = watch.collect(true);
    settle(new FakeDownload({ name: "later.txt" }));
    expect((await waiting)[0]?.name).toBe("later.txt");
  });

  it("saves the download in a new folder under the call's folder and removes the browser copy", async () => {
    const download = new FakeDownload({ name: "statement.pdf", content: "net total" });
    const { page, armed } = fakePage({ download });
    const watch = await start(page, root, "Downloads");

    // One waiter, armed and the folder prepared before the action that may download.
    expect(armed).toEqual([{ event: "download", timeout: 3000 }]);
    expect((await stat(path.join(root, "Downloads"))).isDirectory()).toBe(true);

    const saved = await watch.collect();
    expect(saved).toEqual([
      {
        name: "statement.pdf",
        path: expect.stringMatching(/^Downloads\/download-[^/]+\/statement\.pdf$/),
        size: 9,
      },
    ]);
    expect(await readFile(path.join(root, String(saved[0]?.path)), "utf8")).toBe("net total");
    expect(download.deleted).toBe(true);
    expect(download.canceled).toBe(false);
  });

  it("saves into a bot's relative folder and reports the path the bot can open", async () => {
    const { page } = fakePage({ download: new FakeDownload({ name: "a.txt" }) });
    const watch = await start(page, root, "bots/b1/Downloads");
    const [entry] = await watch.collect();
    expect(entry?.path).toMatch(/^bots\/b1\/Downloads\/download-[^/]+\/a\.txt$/);
    expect(await readFile(path.join(root, String(entry?.path)), "utf8")).toBe("downloaded");
  });

  it("takes the workspace root through a symlink but refuses a linked folder beneath it", async () => {
    const real = path.join(root, "real");
    await mkdir(real);
    const link = path.join(root, "home-link");
    await symlink(real, link);

    const { page } = fakePage({ download: new FakeDownload({ name: "ok.txt" }) });
    const watch = await start(page, link, "Downloads");
    const [entry] = await watch.collect();
    expect(await readFile(path.join(real, String(entry?.path)), "utf8")).toBe("downloaded");

    const outside = path.join(root, "outside");
    await mkdir(outside);
    await mkdir(path.join(real, "bots"));
    await symlink(outside, path.join(real, "bots", "b1"));
    const linked = fakePage({ download: new FakeDownload() });
    await expect(start(linked.page, real, "bots/b1/Downloads")).rejects.toMatchObject({
      code: "invalid-download-path",
    });
    expect(linked.armed).toHaveLength(0);
    expect(await readdir(outside)).toEqual([]);

    // The download folder itself being a link is refused too.
    await symlink(outside, path.join(real, "linked"));
    const final = fakePage({ download: new FakeDownload() });
    await expect(start(final.page, real, "linked")).rejects.toMatchObject({
      code: "invalid-download-path",
    });
    expect(final.armed).toHaveLength(0);
  });

  it("refuses absolute, escaping and malformed destinations before arming a waiter", async () => {
    for (const directory of [
      ".",
      "..",
      "../outside",
      "Downloads/..",
      "Downloads/../../outside",
      "/tmp/rakazo-ego-outside",
      "Dow\0nloads",
    ]) {
      const { page, armed } = fakePage({ download: new FakeDownload() });
      await expect(start(page, root, directory)).rejects.toMatchObject({
        code: "invalid-download-path",
      });
      expect(armed).toHaveLength(0);
    }
    // A workspace root that is not absolute cannot anchor a save at all.
    const relativeRoot = fakePage({ download: new FakeDownload() });
    await expect(start(relativeRoot.page, "workspace", "Downloads")).rejects.toMatchObject({
      code: "invalid-download-path",
    });
    expect(relativeRoot.armed).toHaveLength(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a destination that exists as a file", async () => {
    await writeFile(path.join(root, "Downloads"), "not a folder");
    const { page, armed } = fakePage({ download: new FakeDownload() });
    await expect(start(page, root, "Downloads")).rejects.toMatchObject({
      code: "invalid-download-path",
    });
    expect(armed).toHaveLength(0);
  });

  it("keeps both downloads when a site sends one name twice and never replaces an existing file", async () => {
    const folder = path.join(root, "Downloads");
    await mkdir(folder);
    await writeFile(path.join(folder, "statement.pdf"), "older");

    const firstWatch = await start(
      fakePage({ download: new FakeDownload({ name: "statement.pdf", content: "first" }) }).page,
      root,
      "Downloads",
    );
    const [first] = await firstWatch.collect();
    const secondWatch = await start(
      fakePage({ download: new FakeDownload({ name: "statement.pdf", content: "second" }) }).page,
      root,
      "Downloads",
    );
    const [second] = await secondWatch.collect();

    expect(first?.path).not.toBe(second?.path);
    expect(await readFile(path.join(root, String(first?.path)), "utf8")).toBe("first");
    expect(await readFile(path.join(root, String(second?.path)), "utf8")).toBe("second");
    expect(await readFile(path.join(folder, "statement.pdf"), "utf8")).toBe("older");
  });

  it("turns a site's file name into one short, plain segment", async () => {
    const cases: Array<[string, string]> = [
      ["report$;`.pdf", "report___.pdf"],
      ["C:\\temp\\evil.exe", "C:_temp_evil.exe"],
      ["a\u0000b.pdf", "a b.pdf"],
      ["...", "download"],
      ["/etc/passwd", "_etc_passwd"],
      [`${"x".repeat(120)}.pdf`, `${"x".repeat(76)}.pdf`],
    ];
    for (const [suggested, expected] of cases) {
      const download = new FakeDownload({ name: suggested, content: "payload" });
      const watch = await start(fakePage({ download }).page, root, "Downloads");
      const [entry] = await watch.collect();
      expect(entry?.name).toBe(expected);
      expect(entry?.path).toMatch(/^Downloads\/download-[^/]+\//);
      expect(await readFile(path.join(root, String(entry?.path)), "utf8")).toBe("payload");
    }
  });

  it("keeps a climbing name inside the call's own folder", async () => {
    const download = new FakeDownload({ name: "../../escape.txt", content: "kept" });
    const watch = await start(fakePage({ download }).page, root, "Downloads");
    const [entry] = await watch.collect();
    expect(String(entry?.path).startsWith("Downloads/")).toBe(true);
    expect(String(entry?.name)).not.toContain("/");
    expect(String(entry?.name)).not.toContain("\\");
    expect(String(entry?.name).startsWith(".")).toBe(false);
    expect(
      path.resolve(root, String(entry?.path)).startsWith(path.join(root, "Downloads") + path.sep),
    ).toBe(true);
    expect(await readFile(path.join(root, String(entry?.path)), "utf8")).toBe("kept");
  });

  it("treats only the download wait's own timeout as no download", async () => {
    const quiet = fakePage();
    const watch = await start(quiet.page, root, "Downloads");
    expect(quiet.armed).toEqual([{ event: "download", timeout: 3000 }]);
    await expect(watch.collect()).resolves.toEqual([]);
    expect(await readdir(path.join(root, "Downloads"))).toEqual([]);

    const closed = new Error("The page was closed while waiting for a download.");
    const failed = await start(fakePage({ error: closed }).page, root, "Downloads");
    await expect(failed.collect()).rejects.toBe(closed);
  });

  it("cancels and removes its own new folder when the browser cannot save", async () => {
    const download = new FakeDownload({
      name: "statement.pdf",
      saveError: new Error("disk full"),
    });
    const watch = await start(fakePage({ download }).page, root, "Downloads");
    const [entry] = await watch.collect();
    expect(entry).toEqual({ name: "statement.pdf", error: "disk full" });
    expect(download.canceled).toBe(true);
    expect(download.deleted).toBe(false);
    expect(await readdir(path.join(root, "Downloads"))).toEqual([]);
  });

  it("keeps the saved file when the browser's temporary copy cannot be removed", async () => {
    const download = new FakeDownload({
      name: "statement.pdf",
      content: "kept",
      deleteError: new Error("permission denied"),
    });
    const watch = await start(fakePage({ download }).page, root, "Downloads");
    const [entry] = await watch.collect();
    // The download did happen: its name, path and size stay, with the cleanup failure beside them.
    expect(entry?.name).toBe("statement.pdf");
    expect(entry?.size).toBe(4);
    expect(entry?.path).toMatch(/^Downloads\/download-[^/]+\/statement\.pdf$/);
    expect(String(entry?.error)).toContain("temporary browser copy");
    expect(String(entry?.error)).toContain("permission denied");
    expect(await readFile(path.join(root, String(entry?.path)), "utf8")).toBe("kept");
    expect(download.deleteCalls).toBe(1);
    expect(download.cancelCalls).toBe(0);
  });

  it("reports a failed cancel beside the save failure", async () => {
    const download = new FakeDownload({
      name: "statement.pdf",
      saveError: new Error("disk full"),
      cancelError: new Error("already finished"),
    });
    const watch = await start(fakePage({ download }).page, root, "Downloads");
    const [entry] = await watch.collect();
    expect(entry?.name).toBe("statement.pdf");
    expect(String(entry?.error)).toContain("disk full");
    expect(String(entry?.error)).toContain("already finished");
    expect(await readdir(path.join(root, "Downloads"))).toEqual([]);
  });

  it("reports a failed removal of its own temporary folder after a failed save", async () => {
    const busy = await startHelpers({
      rm: async () => {
        throw new Error("folder busy");
      },
    });
    const download = new FakeDownload({
      name: "statement.pdf",
      saveError: new Error("disk full"),
    });
    const watch = await busy(fakePage({ download }).page, root, "Downloads");
    const [entry] = await watch.collect();
    expect(String(entry?.error)).toContain("disk full");
    expect(String(entry?.error)).toContain("folder busy");
    expect(download.canceled).toBe(true);
  });

  it("refuses a workspace path that cannot be resolved before arming a waiter", async () => {
    const { page, armed } = fakePage({ download: new FakeDownload() });
    await expect(start(page, path.join(root, "missing"), "Downloads")).rejects.toMatchObject({
      code: "invalid-download-path",
    });
    expect(armed).toHaveLength(0);
  });

  it("arms nothing and saves nothing without a download folder", async () => {
    for (const directory of [undefined, "", null] as const) {
      const { page, armed } = fakePage({ download: new FakeDownload() });
      const watch = await start(page, root, directory);
      await expect(watch.collect()).resolves.toEqual([]);
      expect(armed).toHaveLength(0);
    }
    // Nothing is prepared or inspected when the call cannot save anything, even for a bad root.
    const unrooted = fakePage();
    const watch = await start(unrooted.page, "relative/root", undefined);
    await expect(watch.collect()).resolves.toEqual([]);
    expect(unrooted.armed).toHaveLength(0);
    expect(await readdir(root)).toEqual([]);
  });
});
