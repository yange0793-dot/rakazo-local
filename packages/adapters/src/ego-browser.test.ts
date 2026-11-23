import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterContext, BrowserActStep, ComputerRef } from "@rakazo/adapter-kit";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createBrowserProvider, resolveBrowserProviderKind } from "./browser-provider-factory.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import type { EgoBrowserProviderOptions, EgoInvocation, EgoRunner } from "./ego-browser.js";
import { EgoBrowserProvider } from "./ego-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const workspace = path.join(tmpdir(), "rakazo-ego-workspace");
const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "desktop",
  providerRef: workspace,
};

const NONCE = "1a2b3c4d5e6f7081";
const NEXT_NONCE = "1122334455667788";
const REF_1 = `s${NONCE}-1`;
const REF_2 = `s${NONCE}-2`;
const STALE_NONCE_REF = "s9f8e7d6c5b4a3928-1";

function element(ref: string, role: string, name: string, loc?: string, occurrence = 0) {
  const selector = loc ? `loc=${loc}` : `loc=role:${role}[name='${name}']`;
  return { ref, role, name, ...(loc ? { loc } : {}), occurrence, selector };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    nonce: NONCE,
    spaceId: 7,
    pageLabel: "p1",
    url: "https://example.test/form",
    title: "Signup",
    snapshot: `root\n  textbox "Email" [${REF_1}]\n  button "Continue" [${REF_2}]`,
    elements: [
      element(REF_1, "textbox", "Email", 'css:input[name="email"]'),
      element(REF_2, "button", "Continue"),
    ],
    ...overrides,
  };
}

/** A page after an action: a new nonce, so refs from the earlier snapshot are no longer valid. */
function nextPage(overrides: Record<string, unknown> = {}) {
  const ref1 = `s${NEXT_NONCE}-1`;
  const ref2 = `s${NEXT_NONCE}-2`;
  return page({
    nonce: NEXT_NONCE,
    snapshot: `root\n  textbox "Email" [${ref1}]\n  button "Continue" [${ref2}]`,
    elements: [
      element(ref1, "textbox", "Email", 'css:input[name="email"]'),
      element(ref2, "button", "Continue"),
    ],
    ...overrides,
  });
}

type Seen = {
  input: Record<string, unknown>;
  invocation: EgoInvocation;
  result: Record<string, unknown>;
};

function fakeRunner(
  respond: (
    input: Record<string, unknown>,
    invocation: EgoInvocation,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  const seen: Seen[] = [];
  const run: EgoRunner = async (invocation) => {
    const input = JSON.parse(await readFile(invocation.inputPath, "utf8")) as Record<
      string,
      unknown
    >;
    const result = await respond(input, invocation);
    seen.push({ input, invocation, result });
    await writeFile(invocation.resultPath, JSON.stringify(result));
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, seen };
}

/**
 * Offline provider with a fake ego process. Unless a test supplies origins or an environment,
 * the ambient self-app origins are left out so the test does not depend on the developer's env.
 */
function ego(respond: Parameters<typeof fakeRunner>[0], options: EgoBrowserProviderOptions = {}) {
  const fake = fakeRunner(respond);
  const defaults = options.blockedOrigins || options.env ? {} : { blockedOrigins: [] };
  const browser = new EgoBrowserProvider({
    command: "/opt/ego-browser",
    run: fake.run,
    ...defaults,
    ...options,
  });
  return { browser, fake };
}

describe("ego browser provider", () => {
  it("advertises the native page contract without a purchase check", () => {
    const browser = new EgoBrowserProvider({
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      blockedOrigins: [],
    });
    expect(browser.describe()).toMatchObject({
      id: "ego",
      contractVersion: "1",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
        requiresGraphicalComputer: false,
        requiresActionApproval: true,
      },
    });
    expect("purchaseCheck" in browser).toBe(false);
  });

  it("is selected only by an explicit BROWSER_PROVIDER=ego", () => {
    expect(resolveBrowserProviderKind({ BROWSER_PROVIDER: "ego" } as NodeJS.ProcessEnv)).toBe(
      "ego",
    );
    expect(resolveBrowserProviderKind({} as NodeJS.ProcessEnv)).toBe("computer");
    expect(createBrowserProvider("ego")).toBeInstanceOf(EgoBrowserProvider);
    expect(createBrowserProvider("computer")).toBeInstanceOf(ComputerBrowserProvider);
    expect(createBrowserProvider("fake")).toBeInstanceOf(FakeBrowserProvider);
  });

  it("navigates through a structured result file and cleans up its own temp folder", async () => {
    const { browser, fake } = ego(() => page());
    const result = await browser.navigate(computer, { url: "https://example.test/form" }, context);

    expect(result).toMatchObject({ url: "https://example.test/form", title: "Signup" });
    expect(result.fallback).toBeUndefined();
    expect(result.elements?.map((item) => item.ref)).toEqual([REF_1, REF_2]);

    const seen = fake.seen[0]!;
    expect(seen.input).toMatchObject({
      action: "navigate",
      url: "https://example.test/form",
      maxSnapshotChars: 12_000,
    });
    expect(seen.invocation.command).toBe("/opt/ego-browser");
    expect(seen.invocation.script).toContain(JSON.stringify(seen.invocation.inputPath));
    expect(seen.invocation.script).not.toContain("__EGO_INPUT__");
    // Neither the workspace id nor the bot id is shown in the browser's space list.
    expect(seen.input.spaceName).toMatch(/^Rakazo bot [0-9a-f]{16}$/);
    expect(seen.input.spaceName).not.toContain("space-1");
    expect(seen.input.spaceName).not.toContain("bot-1");

    await expect(access(path.dirname(seen.invocation.inputPath))).rejects.toThrow();
  });

  it("reports a missing binary instead of launching anything", async () => {
    const browser = new EgoBrowserProvider({
      command: "/missing/ego-browser",
      blockedOrigins: [],
      run: async () => {
        throw Object.assign(new Error("spawn ego-browser ENOENT"), { code: "ENOENT" });
      },
    });
    const result = await browser.navigate(computer, { url: "https://example.test/" }, context);
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/not installed/);
  });

  it("refuses every page call on a non-desktop computer without spawning", async () => {
    const cloud: ComputerRef = { ...computer, kind: "fake" };
    const { browser, fake } = ego(() => page());

    const navigated = await browser.navigate(cloud, { url: "https://example.test/" }, context);
    expect(navigated.error).toMatch(/native desktop/);
    expect(navigated.fallback).toBeUndefined();

    const snapshot = await browser.snapshot(cloud, {}, context);
    expect(snapshot.error).toMatch(/native desktop/);
    expect(snapshot.fallback).toBeUndefined();

    const acted = await browser.act(cloud, { actions: [{ kind: "click", ref: REF_1 }] }, context);
    expect(acted).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(acted.fallback).toBeUndefined();
    expect(fake.seen).toHaveLength(0);
  });

  it("refuses a space the agent does not own without falling back to desktop control", async () => {
    const { browser } = ego(() => ({
      ok: false,
      code: "space-not-owned",
      error: "The ego TaskSpace is held by a user-owned space.",
      uncertain: false,
      completed: 0,
    }));
    const result = await browser.navigate(computer, { url: "https://example.test/" }, context);
    expect(result.fallback).toBeUndefined();
    expect(result.error).toMatch(/user-owned/);
  });

  it("requires a bound snapshot before acting, and sends its binding", async () => {
    const { browser, fake } = ego((input) =>
      input.action === "act" ? nextPage({ completed: 1, uncertain: false }) : page(),
    );

    const withoutSnapshot = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: REF_1 }] },
      context,
    );
    expect(withoutSnapshot.ok).toBe(false);
    expect(withoutSnapshot.uncertain).toBe(false);
    expect(withoutSnapshot.error).toMatch(/No bound page snapshot/);
    expect(fake.seen).toHaveLength(0);

    const snapshot = await browser.snapshot(computer, {}, context);
    expect(snapshot.elements?.map((item) => item.ref)).toEqual([REF_1, REF_2]);

    // Brackets a model may copy from the tree are stripped; the binding goes with the action.
    const clicked = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: `[${REF_1}]` }] },
      context,
    );
    expect(clicked.ok).toBe(true);
    const act = fake.seen.find((item) => item.input.action === "act")!;
    expect(act.input.actions).toEqual([{ kind: "click", ref: REF_1 }]);
    expect(act.input.expected).toMatchObject({
      nonce: NONCE,
      spaceId: "7",
      pageLabel: "p1",
      url: "https://example.test/form",
      elements: {
        [REF_1]: {
          role: "textbox",
          name: "Email",
          loc: 'css:input[name="email"]',
          occurrence: 0,
        },
      },
    });

    // The act returned a new nonce: the old ref is no longer part of the held snapshot.
    const before = fake.seen.length;
    const oldRef = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: REF_1 }] },
      context,
    );
    expect(oldRef.ok).toBe(false);
    expect(oldRef.uncertain).toBe(false);
    expect(oldRef.error).toMatch(/latest bound snapshot/);
    expect(fake.seen).toHaveLength(before);
  });

  it("rejects refs from another snapshot or another format before spawning", async () => {
    const { browser, fake } = ego(() => page());
    await browser.snapshot(computer, {}, context);
    const before = fake.seen.length;
    for (const ref of [
      "1",
      "@1",
      "ref=1",
      "css:input[name=email]",
      STALE_NONCE_REF,
      `s${NONCE}-99`,
    ]) {
      const refused = await browser.act(computer, { actions: [{ kind: "click", ref }] }, context);
      expect(refused.ok).toBe(false);
      expect(refused.uncertain).toBe(false);
      expect(refused.error).toMatch(/latest bound snapshot/);
    }
    expect(fake.seen).toHaveLength(before);
  });

  it("maps a helper stale-ref refusal to a settled result with the new page snapshot", async () => {
    const { browser } = ego((input) =>
      input.action === "act"
        ? nextPage({
            ok: false,
            code: "stale-ref",
            error: "The page changed since that snapshot.",
            uncertain: false,
            completed: 0,
          })
        : page(),
    );
    await browser.snapshot(computer, {}, context);
    const result = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: REF_1 }] },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.uncertain).toBe(false);
    expect(result.fallback).toBeUndefined();
    expect(result.error).toMatch(/changed since that snapshot/);
    expect(result.tree).toContain(`s${NEXT_NONCE}-2`);
  });

  it("treats a blocked self-origin stop as a policy denial with no fallback", async () => {
    const { browser } = ego((input) =>
      input.action === "act"
        ? nextPage({
            ok: false,
            code: "blocked-origin",
            error:
              "Blocked by policy: this page is the app's own origin. Browser tools may not operate it.",
            uncertain: false,
            completed: 1,
          })
        : page(),
    );
    await browser.snapshot(computer, {}, context);
    const result = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: REF_1 }] },
      context,
    );
    expect(result).toMatchObject({ ok: false, completed: 1, uncertain: false });
    expect(result.fallback).toBeUndefined();
    expect(result.error).toMatch(/Blocked by policy/);
  });

  it("refuses incomplete protected bindings, card details, pay tokens and approved purchases", async () => {
    const { browser, fake } = ego(() => page());
    await browser.snapshot(computer, {}, context);
    const protectedSteps: BrowserActStep[] = [
      { kind: "fill", ref: REF_1, text: "ada@example.test", origin: "https://example.test" },
      { kind: "fill", ref: REF_1, text: "hunter2", field: "password" },
      { kind: "fill", ref: REF_1, text: "123456", field: "code" },
      {
        kind: "pay_token",
        text: "tok",
        origin: "https://example.test",
        merchantAccountId: "acct_test",
      },
      {
        kind: "click",
        ref: REF_2,
        approved: true,
        site: "example.test",
        label: "Buy",
        amount: "1.00",
      },
    ];
    for (const step of protectedSteps) {
      const result = await browser.act(computer, { actions: [step] }, context);
      expect(result.ok).toBe(false);
      expect(result.uncertain).toBe(false);
      expect(result.error).toMatch(/not supported|field binding/);
    }
    expect(fake.seen.filter((item) => item.input.action === "act")).toHaveLength(0);
  });

  it("resolves upload roots and files through realpath so a symlink cannot escape", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-ego-upload-")));
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-ego-outside-")));
    try {
      await writeFile(path.join(root, "report.pdf"), "pdf");
      await writeFile(path.join(outside, "outside.txt"), "secret");
      await symlink(path.join(outside, "outside.txt"), path.join(root, "link.pdf"));
      const uploadComputer: ComputerRef = { ...computer, providerRef: root };
      const { browser, fake } = ego((input) =>
        input.action === "act" ? page({ completed: 1, uncertain: false }) : page(),
      );
      await browser.snapshot(uploadComputer, {}, context);

      const linked = await browser.act(
        uploadComputer,
        { actions: [{ kind: "upload", ref: REF_1, paths: ["link.pdf"] }] },
        context,
      );
      expect(linked.ok).toBe(false);
      expect(linked.uncertain).toBe(false);
      expect(linked.error).toMatch(/inside this bot's workspace/);

      const outsideFile = await browser.act(
        uploadComputer,
        {
          actions: [{ kind: "upload", ref: REF_1, paths: [path.join(outside, "outside.txt")] }],
        },
        context,
      );
      expect(outsideFile.ok).toBe(false);
      expect(outsideFile.error).toMatch(/inside this bot's workspace/);
      expect(fake.seen.filter((item) => item.input.action === "act")).toHaveLength(0);

      const inside = await browser.act(
        uploadComputer,
        { actions: [{ kind: "upload", ref: REF_1, paths: ["report.pdf"] }] },
        context,
      );
      expect(inside.ok).toBe(true);
      const act = fake.seen.find((item) => item.input.action === "act")!;
      expect(act.input.actions).toEqual([
        { kind: "upload", ref: REF_1, paths: [path.join(root, "report.pdf")] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("marks a runtime action failure uncertain, clears refs and never retries it", async () => {
    const { browser, fake } = ego((input) =>
      input.action === "act"
        ? {
            ok: false,
            code: "action-failed",
            error: "click timed out",
            uncertain: true,
            completed: 1,
            url: "https://example.test/form",
            title: "Signup",
          }
        : page(),
    );
    await browser.snapshot(computer, {}, context);
    const result = await browser.act(
      computer,
      {
        actions: [
          { kind: "fill", ref: REF_1, text: "ada@example.test" },
          { kind: "click", ref: REF_2 },
        ],
      },
      context,
    );
    expect(result).toMatchObject({ ok: false, completed: 1, uncertain: true });
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/timed out/);
    expect(fake.seen.filter((item) => item.input.action === "act")).toHaveLength(1);

    // The failed act returned no page, so the held refs are gone until a new snapshot.
    const next = await browser.act(computer, { actions: [{ kind: "click", ref: REF_1 }] }, context);
    expect(next.error).toMatch(/No bound page snapshot/);
  });

  it("blocks the app's own origin before starting a browser process", async () => {
    const { browser, fake } = ego(() => page(), {
      blockedOrigins: ["https://app.example"],
    });
    const result = await browser.navigate(
      computer,
      { url: "https://app.example/settings/approvals" },
      context,
    );
    expect(result.fallback).toBeUndefined();
    expect(result.error).toMatch(/Blocked by policy/);
    expect(fake.seen).toHaveLength(0);
    expect(() => new EgoBrowserProvider({ blockedOrigins: ["not a url"] })).toThrow(
      /Invalid blocked origin/,
    );
    expect(browser.describe().id).toBe("ego");
  });

  it("derives self-app origins from the environment and blocks loopback aliases", async () => {
    const { browser, fake } = ego(() => page(), {
      env: {
        WEB_ORIGIN: "http://localhost:5173",
        API_URL: "http://127.0.0.1:3100",
      },
    });
    for (const url of [
      "http://127.0.0.1:5173/settings/approvals",
      "http://localhost:3100/rpc/me",
    ]) {
      const result = await browser.navigate(computer, { url }, context);
      expect(result.error).toMatch(/Blocked by policy/);
      expect(result.fallback).toBeUndefined();
    }
    expect(fake.seen).toHaveLength(0);

    // Another port on the same loopback host is a different origin and is not blocked.
    const otherPort = await browser.navigate(computer, { url: "http://127.0.0.1:5174/" }, context);
    expect(otherPort.error).toBeUndefined();
    expect(fake.seen).toHaveLength(1);
  });

  it("rejects URLs with embedded credentials before starting a browser process", async () => {
    const { browser, fake } = ego(() => page());
    const result = await browser.navigate(
      computer,
      { url: "https://user:secret@example.test/" },
      context,
    );
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/without embedded credentials/);
    expect(fake.seen).toHaveLength(0);
  });

  it("passes the snapshot query to the browser and aborts before spawning", async () => {
    const { browser, fake } = ego(() => page());
    await browser.snapshot(computer, { query: "Email" }, context);
    expect(fake.seen[0]?.input.query).toBe("Email");

    const controller = new AbortController();
    controller.abort();
    await expect(
      browser.snapshot(computer, {}, { ...context, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(fake.seen).toHaveLength(1);
  });

  it("keeps refs bound to one snapshot, replaces typed text, and never ends a space", async () => {
    const { browser, fake } = ego(() => page());
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const script = fake.seen[0]!.invocation.script;
    expect(script).not.toMatch(/\.finish\s*\(/);
    expect(script).not.toMatch(/\bclaimTaskSpace\b/);
    expect(script).not.toMatch(/\.release\s*\(/);
    expect(script).not.toMatch(/page\.close\s*\(/);
    expect(script).toContain("listTaskSpaces");
    expect(script).toContain('ownership !== "agent"');
    // Refs carry a per-snapshot random nonce and are checked against the held page binding.
    expect(script).toContain("randomBytes");
    expect(script).toContain("identityOf");
    expect(script).toContain("expected.nonce");
    expect(script).toContain("page.label === expected.pageLabel");
    expect(script).toContain("POLICY_DENIED");
    expect(script).not.toContain("tokenFor");
    // Type replaces the field, and fill clears it, rather than appending.
    expect(script).toContain("ControlOrMeta+A");
    expect(script).toContain("clearFirst: true");
  });
});

/** Two identical buttons and two links: only the fresh ego ref can name a duplicate. */
const DUPLICATE_SNAPSHOT = [
  "root",
  "  button [ref=8]",
  '    text "Duplicate action"',
  "  button [ref=9]",
  '    text "Duplicate action"',
  "  anchor [ref=10, loc=href:/#link-a, url=https://example.test/#link-a]",
  '    text "Same link"',
  "  anchor [ref=11, loc=href:/#link-b, url=https://example.test/#link-b]",
  '    text "Same link"',
].join("\n");

const SINGLE_BUTTON_SNAPSHOT = ["root", "  button [ref=8]", '    text "Go"'].join("\n");

type FixtureCall = { method: string; args: unknown[] };

/** A Page the injected helper script drives, recording every call the script makes. */
function fixturePage(
  options: {
    label?: string;
    targetId?: string | null;
    url?: string;
    snapshotText?: () => string;
    click?: (selector: string) => unknown | Promise<unknown>;
    /** Resolve the armed download waiter on this 1-based click with this fake Download. */
    download?: { afterClick: number; name: string; body: string };
    document?: JSDOM;
  } = {},
) {
  const calls: FixtureCall[] = [];
  let url = options.url ?? "https://example.test/form";
  const snapshotText = options.snapshotText ?? (() => SINGLE_BUTTON_SNAPSHOT);
  const downloads: Array<{ saved?: string; deleted: boolean; cancelled: boolean }> = [];
  const stats = { waiters: 0, maxPending: 0, clicks: 0 };
  let pendingCount = 0;
  let pendingWaiter:
    | { resolve: (download: unknown) => void; reject: (error: Error) => void }
    | undefined;
  return {
    label: options.label ?? "p1",
    targetId: options.targetId ?? "target-1",
    spaceId: 7,
    calls,
    downloads,
    stats,
    setUrl(value: string) {
      url = value;
      options.document?.reconfigure({ url: value });
    },
    async info() {
      calls.push({ method: "info", args: [] });
      return { url, title: "Signup" };
    },
    async url() {
      return url;
    },
    async title() {
      return "Signup";
    },
    async snapshot(snapshotOptions?: unknown) {
      calls.push({ method: "snapshot", args: [snapshotOptions] });
      return snapshotText();
    },
    async click(selector: string) {
      calls.push({ method: "click", args: [selector] });
      stats.clicks += 1;
      const receipt = options.click ? await options.click(selector) : {};
      if (options.download && stats.clicks === options.download.afterClick && pendingWaiter) {
        const record = { saved: undefined as string | undefined, deleted: false, cancelled: false };
        const name = options.download.name;
        const body = options.download.body;
        downloads.push(record);
        pendingWaiter.resolve({
          suggestedFilename: () => name,
          async saveAs(target: string) {
            record.saved = target;
            await writeFile(target, body, "utf8");
          },
          async delete() {
            record.deleted = true;
          },
          async cancel() {
            record.cancelled = true;
          },
        });
      }
      return receipt;
    },
    async fill(selector: string, value: string, fillOptions?: unknown) {
      calls.push({ method: "fill", args: [selector, value, fillOptions] });
    },
    async selectOption(selector: string, value: string) {
      calls.push({ method: "selectOption", args: [selector, value] });
    },
    async press(selector: string, key: string) {
      calls.push({ method: "press", args: [selector, key] });
    },
    async setInputFiles(selector: string, paths: string[]) {
      calls.push({ method: "setInputFiles", args: [selector, paths] });
    },
    async goto(target: string) {
      calls.push({ method: "goto", args: [target] });
      url = target;
    },
    async cdp(method: string, params?: { expression?: string }) {
      if (!options.document) throw new Error("No test document");
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        return { result: { value: options.document.window.eval(params?.expression ?? "") } };
      }
      throw new Error(`Unexpected CDP method ${method}`);
    },
    async waitForLoadState(state?: string) {
      calls.push({ method: "waitForLoadState", args: [state] });
    },
    async waitForEvent(event: string, waitOptions?: { timeout?: number }) {
      calls.push({ method: "waitForEvent", args: [event, waitOptions] });
      stats.waiters += 1;
      pendingCount += 1;
      stats.maxPending = Math.max(stats.maxPending, pendingCount);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCount -= 1;
          pendingWaiter = undefined;
          reject(
            new Error(
              `page.waitForEvent("download") timed out after ${waitOptions?.timeout ?? 0}ms`,
            ),
          );
        }, 0);
        pendingWaiter = {
          resolve: (download) => {
            clearTimeout(timer);
            pendingCount -= 1;
            pendingWaiter = undefined;
            resolve(download);
          },
          reject: (error) => {
            clearTimeout(timer);
            pendingCount -= 1;
            pendingWaiter = undefined;
            reject(error);
          },
        };
      });
    },
    keyboard: {
      async type(text: string) {
        calls.push({ method: "keyboard.type", args: [text] });
      },
    },
  };
}

function fixtureTask(pages: ReturnType<typeof fixturePage>[]) {
  let returned: ReturnType<typeof fixturePage> | undefined;
  return {
    spaceId: 7,
    ownership: "agent",
    handoffs: 0,
    takeovers: 0,
    userPage: () => returned,
    returnPage(page: ReturnType<typeof fixturePage>) {
      returned = page;
    },
    async handOff() {
      this.handoffs += 1;
      this.ownership = "agentDelegatedToUser";
    },
    async takeOver() {
      this.takeovers += 1;
      this.ownership = "agent";
      return this;
    },
    async adopt(page: ReturnType<typeof fixturePage>) {
      if (!pages.includes(page)) pages.push(page);
      return page;
    },
    async pages() {
      return pages;
    },
    async newPage() {
      const created = fixturePage({ label: "p9" });
      pages.push(created);
      return created;
    },
    async tabs() {
      return pages.map((item) => ({
        label: item.label,
        targetId: item.targetId,
        title: "Signup",
        url: "https://example.test/form",
        active: false,
        openedBy: "agent",
        page: item,
      }));
    },
  };
}

/** Runs the same helper source the provider sends, against a fixture Page instead of ego. */
async function executeHelper(
  invocation: EgoInvocation,
  task: unknown,
  options: { expired?: boolean; listingError?: boolean } = {},
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-ego-execute-"));
  const file = path.join(dir, "helper.mjs");
  await writeFile(file, invocation.script, "utf8");
  const scope = globalThis as unknown as Record<string, unknown>;
  const previousList = scope.listTaskSpaces;
  const previousTask = scope.taskSpace;
  const previousTakeover = scope.takeOverTaskSpace;
  const input = JSON.parse(await readFile(invocation.inputPath, "utf8"));
  const fixture = task as ReturnType<typeof fixtureTask>;
  scope.listTaskSpaces = async () => {
    if (options.listingError) throw new Error("listing failed");
    return options.expired
      ? []
      : [{ id: fixture.spaceId, name: input.spaceName, ownership: fixture.ownership }];
  };
  scope.taskSpace = async () => task;
  scope.takeOverTaskSpace = async () => fixture.takeOver();
  try {
    await import(pathToFileURL(file).href);
  } finally {
    if (previousList === undefined) delete scope.listTaskSpaces;
    else scope.listTaskSpaces = previousList;
    if (previousTask === undefined) delete scope.taskSpace;
    else scope.taskSpace = previousTask;
    if (previousTakeover === undefined) delete scope.takeOverTaskSpace;
    else scope.takeOverTaskSpace = previousTakeover;
    await rm(dir, { recursive: true, force: true });
  }
}

function executingRunner(
  task: unknown,
  options: { expired?: boolean; listingError?: boolean } = {},
) {
  const seen: EgoInvocation[] = [];
  const run: EgoRunner = async (invocation) => {
    seen.push(invocation);
    await executeHelper(invocation, task, options);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, seen };
}

describe("ego browser helper execution", () => {
  it("binds a snapshot to the URL settled during navigation", async () => {
    const main = fixturePage({
      snapshotText: () => {
        main.setUrl("https://example.test/workspace");
        return 'root\n  textbox "Note" [ref=8]';
      },
    });
    const { run } = executingRunner(fixtureTask([main]));
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    const snap = await browser.snapshot(computer, {}, context);
    expect(snap.url).toBe("https://example.test/workspace");
    const result = await browser.act(
      computer,
      { actions: [{ kind: "fill", ref: snap.elements[0]!.ref, text: "Saved note" }] },
      context,
    );
    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(main.calls).toContainEqual({
      method: "fill",
      args: ["@8", "Saved note", { clearFirst: true }],
    });
  });

  it("does not expose a snapshot that settles on a blocked origin", async () => {
    const main = fixturePage({
      snapshotText: () => {
        main.setUrl("https://private.example.test/settings");
        return 'root\n  textbox "Private value" [ref=8]';
      },
    });
    const { run } = executingRunner(fixtureTask([main]));
    const browser = new EgoBrowserProvider({
      run,
      blockedOrigins: ["https://private.example.test"],
    });
    const snap = await browser.snapshot(computer, {}, context);
    expect(snap).toMatchObject({
      error: expect.stringContaining("Blocked by policy"),
      tree: "",
      elements: [],
    });
    expect(JSON.stringify(snap)).not.toContain("Private value");
  });

  it("keeps unnamed inputs actionable and resolves their fresh Ego refs", async () => {
    let rawRef = 8;
    const main = fixturePage({
      snapshotText: () => `root\n  textbox [ref=${rawRef}]\n  button "Save" [ref=99]`,
    });
    const { run } = executingRunner(fixtureTask([main]));
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    const snap = await browser.snapshot(computer, {}, context);
    expect(snap.elements[0]).toMatchObject({ role: "textbox", name: "" });
    rawRef = 42;
    const result = await browser.act(
      computer,
      { actions: [{ kind: "fill", ref: snap.elements[0]!.ref, text: "Project note" }] },
      context,
    );
    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(main.calls).toContainEqual({
      method: "fill",
      args: ["@42", "Project note", { clearFirst: true }],
    });
    expect(main.calls.some((call) => call.method === "fill" && call.args[0] === "@8")).toBe(false);
  });

  it("selects a stable page and restores its binding after restart and tab reordering", async () => {
    const main = fixturePage();
    const popup = fixturePage({ label: "p2", url: "https://example.test/popup" });
    const pages = [main, popup];
    const { run } = executingRunner(fixtureTask(pages));
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    const snap = await browser.snapshot(computer, { pageId: "7:p2" }, context);
    expect(snap.pageId).toBe("7:p2");
    expect(snap.pages).toEqual([
      { id: "7:p1", url: "https://example.test/form", title: "Signup" },
      { id: "7:p2", url: "https://example.test/popup", title: "Signup", selected: true },
    ]);
    const stored = JSON.parse(JSON.stringify(browser.checkpoint(computer, context)));
    expect(JSON.stringify(stored)).not.toContain("target-1");
    pages.reverse();
    const restarted = new EgoBrowserProvider({ run, blockedOrigins: [] });
    restarted.restore(computer, stored, context);
    const acted = await restarted.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements[0]!.ref }] },
      context,
    );
    expect(acted).toMatchObject({ ok: true, completed: 1, pageId: "7:p2" });
    expect(main.stats.clicks).toBe(0);
    expect(popup.stats.clicks).toBe(1);
    for (const changed of [
      { computer: { ...computer, id: "other-computer" }, context },
      { computer: { ...computer, providerRef: "/another/workspace" }, context },
      { computer, context: { ...context, userId: "other-user" } },
    ]) {
      restarted.restore(changed.computer, stored, changed.context);
      expect(restarted.checkpoint(changed.computer, changed.context)).toBeNull();
    }
    pages.reverse();
    expect((await restarted.snapshot(computer, {}, context)).pageId).toBe("7:p2");
    const otherBot = { ...context, botId: "another-bot" };
    restarted.restore(computer, stored, otherBot);
    expect(
      (
        await restarted.act(
          computer,
          { actions: [{ kind: "click", ref: snap.elements[0]!.ref }] },
          otherBot,
        )
      ).ok,
    ).toBe(false);
    expect(popup.stats.clicks).toBe(1);
  });

  it("refuses a restored action when the page changed or its session expired", async () => {
    const main = fixturePage();
    const options = { expired: false };
    const { run } = executingRunner(fixtureTask([main]), options);
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    const snap = await browser.snapshot(computer, {}, context);
    const stored = browser.checkpoint(computer, context);
    const restarted = new EgoBrowserProvider({ run, blockedOrigins: [] });
    restarted.restore(computer, stored, context);
    main.setUrl("https://example.test/another");
    const changed = await restarted.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements[0]!.ref }] },
      context,
    );
    expect(changed).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(changed.error).toMatch(/changed since that snapshot/);
    restarted.restore(computer, stored, context);
    options.expired = true;
    const expired = await restarted.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements[0]!.ref }] },
      context,
    );
    expect(expired).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(expired.error).toMatch(/expired/);
    expect(expired.fallback).toBeUndefined();
    expect(main.stats.clicks).toBe(0);
  });

  it("does not silently switch to the first page when the selected page closes", async () => {
    const main = fixturePage();
    const pages = [main, fixturePage({ label: "p2" })];
    const { run } = executingRunner(fixtureTask(pages));
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    const snap = await browser.snapshot(computer, { pageId: "7:p2" }, context);
    pages.pop();
    const result = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements[0]!.ref }] },
      context,
    );
    expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(result.error).toMatch(/selected page is no longer available/);
    expect(result.pages).toEqual([
      { id: "7:p1", url: "https://example.test/form", title: "Signup" },
    ]);
    expect(main.stats.clicks).toBe(0);
  });

  it("hands off, waits for an explicit return and resumes the user's page after restart", async () => {
    const main = fixturePage();
    const returned = fixturePage({ label: "p2", url: "https://example.test/signed-in" });
    const task = fixtureTask([main]);
    const { run } = executingRunner(task);
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    await browser.snapshot(computer, {}, context);
    expect(await browser.control(computer, { action: "hand_off" }, context)).toMatchObject({
      ok: true,
      control: "user",
      pageId: "7:p1",
    });
    const stored = browser.checkpoint(computer, context);
    expect(task.handoffs).toBe(1);
    expect((await browser.snapshot(computer, {}, context)).fallback).toBeUndefined();
    expect(task.takeovers).toBe(0);
    const restarted = new EgoBrowserProvider({ run, blockedOrigins: [] });
    restarted.restore(computer, stored, context);
    expect((await restarted.control(computer, { action: "resume" }, context)).ok).toBe(false);
    expect(task.takeovers).toBe(0);
    task.returnPage(returned);
    const resumed = await restarted.control(
      computer,
      { action: "resume", userConfirmed: true },
      context,
    );
    expect(resumed).toMatchObject({ ok: true, control: "agent", pageId: "7:p2" });
    expect(task.takeovers).toBe(1);
    const after = await restarted.snapshot(computer, {}, context);
    expect(after).toMatchObject({ pageId: "7:p2", url: "https://example.test/signed-in" });
    expect(main.stats.clicks).toBe(0);
    expect(returned.stats.clicks).toBe(0);
  });

  it("never claims a user-owned space or creates another space after a listing failure", async () => {
    const main = fixturePage();
    const task = fixtureTask([main]);
    const options = { listingError: false };
    const { run } = executingRunner(task, options);
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    await browser.snapshot(computer, {}, context);
    await browser.control(computer, { action: "hand_off" }, context);
    task.ownership = "user";
    expect(
      (await browser.control(computer, { action: "resume", userConfirmed: true }, context)).ok,
    ).toBe(false);
    expect(task.takeovers).toBe(0);
    options.listingError = true;
    const failed = await browser.navigate(computer, { url: "https://example.test/next" }, context);
    expect(failed.error).toContain("listing failed");
    expect(main.calls.some((call) => call.method === "goto")).toBe(false);
  });

  it("stops an action batch when the control check cannot list the spaces", async () => {
    const options: { listingError?: boolean } = {};
    const main = fixturePage({
      snapshotText: () => DUPLICATE_SNAPSHOT,
      // The listing starts failing mid-batch, as it might when the user takes over.
      click: () => {
        options.listingError = true;
        return {};
      },
    });
    const task = fixtureTask([main]);
    const { run } = executingRunner(task, options);
    const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
    const snap = await browser.snapshot(computer, {}, context);
    const result = await browser.act(
      computer,
      {
        actions: [
          { kind: "click", ref: snap.elements[0]!.ref },
          { kind: "click", ref: snap.elements[1]!.ref },
        ],
      },
      context,
    );
    // A listing that fails may be a takeover, so the batch stops before the next click.
    expect(result).toMatchObject({ ok: false, completed: 1 });
    expect(result.error).toContain("Browser control is with the user");
    expect(main.stats.clicks).toBe(1);
  });

  it.each([false, true])(
    "stops a batch when the user takes control, including a lost receipt (%s)",
    async (lostReceipt) => {
      const pages: ReturnType<typeof fixturePage>[] = [];
      const task = fixtureTask(pages);
      const main = fixturePage({
        snapshotText: () => DUPLICATE_SNAPSHOT,
        click: () => {
          task.ownership = "agentDelegatedToUser";
          if (lostReceipt) throw new Error("Control changed before the receipt arrived");
          return {};
        },
      });
      pages.push(main);
      const { run } = executingRunner(task);
      const browser = new EgoBrowserProvider({ run, blockedOrigins: [] });
      const snap = await browser.snapshot(computer, {}, context);
      const result = await browser.act(
        computer,
        {
          actions: [
            { kind: "click", ref: snap.elements[0]!.ref },
            { kind: "click", ref: snap.elements[1]!.ref },
          ],
        },
        context,
      );
      expect(result).toMatchObject({
        ok: false,
        completed: lostReceipt ? 0 : 1,
        uncertain: lostReceipt,
      });
      expect(result.fallback).toBeUndefined();
      expect(main.stats.clicks).toBe(1);
      expect(task.takeovers).toBe(0);
    },
  );

  it("clicks duplicate elements by the fresh ego ref, not a rebuilt locator", async () => {
    const page = fixturePage({ snapshotText: () => DUPLICATE_SNAPSHOT });
    const { run } = executingRunner(fixtureTask([page]));
    const browser = new EgoBrowserProvider({
      command: "/opt/ego-browser",
      run,
      blockedOrigins: [],
    });

    const snap = await browser.snapshot(computer, {}, context);
    const refs = (snap.elements ?? []).map((item) => item.ref);
    expect(refs).toHaveLength(4);

    const acted = await browser.act(
      computer,
      {
        actions: [
          { kind: "click", ref: refs[0]! },
          { kind: "click", ref: refs[1]! },
        ],
      },
      context,
    );
    expect(acted).toMatchObject({ ok: true, completed: 2 });
    // Success may omit the optional uncertain field; it must never claim uncertainty.
    expect(acted.uncertain).not.toBe(true);
    expect(
      page.calls.filter((call) => call.method === "click").map((call) => call.args[0]),
    ).toEqual(["@8", "@9"]);
  });

  it("settles an ElementResolutionError because no click was dispatched", async () => {
    const page = fixturePage({
      snapshotText: () => SINGLE_BUTTON_SNAPSHOT,
      click: () => {
        throw new Error(
          "ElementResolutionError: Locator loc=role:button[name='Go'] matched 2 elements (2 visible, 0 hidden)",
        );
      },
    });
    const { run } = executingRunner(fixtureTask([page]));
    const browser = new EgoBrowserProvider({
      command: "/opt/ego-browser",
      run,
      blockedOrigins: [],
    });

    const snap = await browser.snapshot(computer, {}, context);
    const acted = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements![0]!.ref }] },
      context,
    );
    expect(acted).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(acted.error).toMatch(/ElementResolutionError/);
    expect(acted.tree).toContain("root");
  });

  it("keeps a potentially dispatched action error uncertain", async () => {
    const page = fixturePage({
      snapshotText: () => SINGLE_BUTTON_SNAPSHOT,
      click: () => {
        throw new Error("EGO_PAGE_UNRESPONSIVE");
      },
    });
    const { run } = executingRunner(fixtureTask([page]));
    const browser = new EgoBrowserProvider({
      command: "/opt/ego-browser",
      run,
      blockedOrigins: [],
    });

    const snap = await browser.snapshot(computer, {}, context);
    const acted = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements![0]!.ref }] },
      context,
    );
    expect(acted).toMatchObject({ ok: false, uncertain: true });
  });

  it("names a popup by label and URL and stays on the bound page", async () => {
    const main = fixturePage({
      label: "p1",
      click: () => ({ popups: [{ label: "p2", targetId: "target-2" }] }),
    });
    const popup = fixturePage({
      label: "p2",
      targetId: "target-2",
      url: "https://example.test/popup",
    });
    const { run } = executingRunner(fixtureTask([main, popup]));
    const browser = new EgoBrowserProvider({
      command: "/opt/ego-browser",
      run,
      blockedOrigins: [],
    });

    const snap = await browser.snapshot(computer, {}, context);
    const acted = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements![0]!.ref }] },
      context,
    );
    expect(acted.ok).toBe(true);
    expect(acted.note).toContain("p2");
    expect(acted.note).toContain("https://example.test/popup");
    expect(acted.note).toContain("stay on this page");

    // Still bound to p1: the next action runs there, never on the popup.
    const again = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: acted.elements![0]!.ref }] },
      context,
    );
    expect(again.ok).toBe(true);
    expect(main.calls.filter((call) => call.method === "click")).toHaveLength(2);
    expect(popup.calls.filter((call) => call.method === "click")).toHaveLength(0);
  });

  it("does not echo a popup URL on a blocked origin", async () => {
    const main = fixturePage({
      label: "p1",
      click: () => ({ popups: [{ label: "p2", targetId: "target-2" }] }),
    });
    const popup = fixturePage({
      label: "p2",
      targetId: "target-2",
      url: "http://127.0.0.1:55432/rakazo",
    });
    const { run } = executingRunner(fixtureTask([main, popup]));
    const browser = new EgoBrowserProvider({
      command: "/opt/ego-browser",
      run,
      blockedOrigins: ["http://127.0.0.1:55432"],
    });

    const snap = await browser.snapshot(computer, {}, context);
    const acted = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: snap.elements![0]!.ref }] },
      context,
    );
    expect(acted.ok).toBe(true);
    expect(acted.note).toBeDefined();
    expect(acted.note).not.toContain("127.0.0.1");
    expect(acted.note).toContain("blocked by policy");
  });
});

describe("ego protected fields", () => {
  function protectedPage(
    html: string,
    snapshotText = 'root\n  textbox "Credential" [ref=8, loc=css:#credential]',
  ) {
    const document = new JSDOM(html, {
      url: "https://example.test/form",
      runScripts: "outside-only",
    });
    Object.defineProperty(document.window.HTMLInputElement.prototype, "getClientRects", {
      value: () => [{ width: 120, height: 24 }],
    });
    const page = fixturePage({ document, snapshotText: () => snapshotText });
    const { run } = executingRunner(fixtureTask([page]));
    return { browser: new EgoBrowserProvider({ run, blockedOrigins: [] }), document, page };
  }

  it.each([
    ["username", '<input id="credential" type="email">', "ada@example.test"],
    ["password", '<input id="credential" type="password">', "protected-password"],
    ["code", '<input id="credential" autocomplete="one-time-code">', "123456"],
  ] as const)(
    "fills a bound %s without exposing its value in the result or checkpoint",
    async (field, html, text) => {
      const { browser, document } = protectedPage(html);
      try {
        const snap = await browser.snapshot(computer, {}, context);
        const result = await browser.act(
          computer,
          {
            actions: [
              {
                kind: "fill",
                ref: snap.elements[0]!.ref,
                field,
                origin: "https://example.test",
                text,
              },
            ],
          },
          context,
        );
        expect(result).toMatchObject({ ok: true, completed: 1 });
        expect(document.window.document.querySelector("input")?.value).toBe(text);
        expect(JSON.stringify(result)).not.toContain(text);
        expect(JSON.stringify(browser.checkpoint(computer, context))).not.toContain(text);
      } finally {
        document.window.close();
      }
    },
  );

  it.each([
    ["password", '<input id="credential" type="text">', "https://example.test"],
    ["username", '<input id="credential" type="password">', "https://example.test"],
    ["code", '<input id="credential" type="text">', "https://example.test"],
    ["password", '<input id="credential" type="password" disabled>', "https://example.test"],
    ["password", '<input id="credential" type="password">', "https://other.example.test"],
    ["password", '<input id="credential" type="password">', "http://example.test"],
  ] as const)(
    "refuses %s when its type, availability or origin does not match",
    async (field, html, origin) => {
      const { browser, document } = protectedPage(html);
      try {
        const snap = await browser.snapshot(computer, {}, context);
        const result = await browser.act(
          computer,
          {
            actions: [
              { kind: "fill", ref: snap.elements[0]!.ref, field, origin, text: "secret-value" },
            ],
          },
          context,
        );
        expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
        expect(result.fallback).toBeUndefined();
        expect(document.window.document.querySelector("input")?.value).toBe("");
      } finally {
        document.window.close();
      }
    },
  );

  it("refuses a field inside an iframe even when a top-level field uses the same selector", async () => {
    const { browser, document } = protectedPage(
      '<input id="credential" type="password">',
      'root\n  iframe "Login"\n    textbox "Credential" [ref=8, loc=css:#credential]',
    );
    try {
      const snap = await browser.snapshot(computer, {}, context);
      const result = await browser.act(
        computer,
        {
          actions: [
            {
              kind: "fill",
              ref: snap.elements[0]!.ref,
              field: "password",
              origin: "https://example.test",
              text: "secret-value",
            },
          ],
        },
        context,
      );
      expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(document.window.document.querySelector("input")?.value).toBe("");
    } finally {
      document.window.close();
    }
  });

  it("checks the document's origin again at fill time", async () => {
    const { browser, document } = protectedPage('<input id="credential" type="password">');
    try {
      const snap = await browser.snapshot(computer, {}, context);
      document.reconfigure({ url: "https://other.example.test/form" });
      const result = await browser.act(
        computer,
        {
          actions: [
            {
              kind: "fill",
              ref: snap.elements[0]!.ref,
              field: "password",
              origin: "https://example.test",
              text: "secret-value",
            },
          ],
        },
        context,
      );
      expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(document.window.document.querySelector("input")?.value).toBe("");
    } finally {
      document.window.close();
    }
  });
});

describe("ego browser helper downloads", () => {
  it("saves a click-triggered download through the real helper source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-ego-download-"));
    try {
      const page = fixturePage({
        snapshotText: () => SINGLE_BUTTON_SNAPSHOT,
        download: { afterClick: 1, name: "probe.txt", body: "probe-body" },
      });
      const { run } = executingRunner(fixtureTask([page]));
      const browser = new EgoBrowserProvider({
        command: "/opt/ego-browser",
        run,
        blockedOrigins: [],
      });
      const downloadComputer: ComputerRef = { ...computer, providerRef: root };

      const snap = await browser.snapshot(downloadComputer, {}, context);
      const acted = await browser.act(
        downloadComputer,
        { actions: [{ kind: "click", ref: snap.elements![0]!.ref }], downloads: "Downloads" },
        context,
      );

      expect(acted.ok).toBe(true);
      expect(acted.downloads).toHaveLength(1);
      const saved = acted.downloads![0]!;
      expect(saved.name).toBe("probe.txt");
      expect(saved.path).toMatch(/^Downloads\/download-[^/]+\/probe\.txt$/);
      expect(saved.size).toBe(Buffer.byteLength("probe-body"));
      // ego-downloads resolves the workspace root first, so compare under its real path.
      const onDisk = path.join(await realpath(root), saved.path!);
      await expect(readFile(onDisk, "utf8")).resolves.toBe("probe-body");
      expect(page.downloads).toHaveLength(1);
      expect(page.downloads[0]!.deleted).toBe(true);
      expect(page.downloads[0]!.saved).toBe(onDisk);

      // The waiter is armed before the click it covers.
      const waiterAt = page.calls.findIndex((call) => call.method === "waitForEvent");
      const clickAt = page.calls.findIndex((call) => call.method === "click");
      expect(waiterAt).toBeGreaterThanOrEqual(0);
      expect(waiterAt).toBeLessThan(clickAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares one download watch across an ordinary action batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-ego-download-"));
    try {
      const page = fixturePage({
        snapshotText: () => DUPLICATE_SNAPSHOT,
        download: { afterClick: 2, name: "second.txt", body: "second-body" },
      });
      const { run } = executingRunner(fixtureTask([page]));
      const browser = new EgoBrowserProvider({
        command: "/opt/ego-browser",
        run,
        blockedOrigins: [],
      });
      const downloadComputer: ComputerRef = { ...computer, providerRef: root };

      const snap = await browser.snapshot(downloadComputer, {}, context);
      const refs = (snap.elements ?? []).map((item) => item.ref);
      const acted = await browser.act(
        downloadComputer,
        {
          actions: [
            { kind: "click", ref: refs[0]! },
            { kind: "click", ref: refs[1]! },
          ],
          downloads: "Downloads",
        },
        context,
      );

      expect(acted.ok).toBe(true);
      expect(page.stats.waiters).toBe(1);
      expect(page.stats.maxPending).toBe(1);
      expect(acted.downloads).toHaveLength(1);
      expect(acted.downloads![0]!.name).toBe("second.txt");
      await expect(readFile(path.join(root, acted.downloads![0]!.path!), "utf8")).resolves.toBe(
        "second-body",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an unusable root before dispatching navigate or click", async () => {
    const page = fixturePage({ snapshotText: () => SINGLE_BUTTON_SNAPSHOT });
    const { run } = executingRunner(fixtureTask([page]));
    const browser = new EgoBrowserProvider({
      command: "/opt/ego-browser",
      run,
      blockedOrigins: [],
    });
    const brokenComputer: ComputerRef = { ...computer, providerRef: "relative/home" };

    const navigated = await browser.navigate(
      brokenComputer,
      { url: "https://example.test/form", downloads: "Downloads" },
      context,
    );
    expect(navigated.error).toMatch(/cannot be saved in that folder/i);
    expect(page.calls.filter((call) => call.method === "goto")).toHaveLength(0);

    const snap = await browser.snapshot(brokenComputer, {}, context);
    const acted = await browser.act(
      brokenComputer,
      { actions: [{ kind: "click", ref: snap.elements![0]!.ref }], downloads: "Downloads" },
      context,
    );
    expect(acted).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(acted.error).toMatch(/cannot be saved in that folder/i);
    expect(page.calls.filter((call) => call.method === "click")).toHaveLength(0);
  });
});

describe("ego browser action description", () => {
  it("describes the page and element names without text, paths or a browser process", async () => {
    const { browser, fake } = ego(() => page());
    await browser.snapshot(computer, {}, context);
    const before = fake.seen.length;

    const description = browser.describeAction(
      computer,
      {
        actions: [
          { kind: "click", ref: REF_2 },
          { kind: "fill", ref: REF_1, text: "ada@example.test" },
        ],
      },
      context,
    );
    expect(description).toEqual({
      url: "https://example.test/form",
      steps: [
        { kind: "click", role: "button", name: "Continue" },
        { kind: "fill", role: "textbox", name: "Email" },
      ],
    });
    expect(JSON.stringify(description)).not.toContain("ada@example.test");
    expect(fake.seen).toHaveLength(before);
  });

  it("stays undefined for protected, approved, stale or non-desktop actions", async () => {
    const { browser } = ego(() => page());
    await browser.snapshot(computer, {}, context);

    const protectedSteps: BrowserActStep[] = [
      { kind: "fill", ref: REF_1, text: "hunter2", field: "password" },
      { kind: "fill", ref: REF_1, text: "ada@example.test", origin: "https://example.test" },
      { kind: "fill", ref: REF_1, text: "123456", field: "code" },
      { kind: "pay_token", text: "tok", origin: "https://example.test", merchantAccountId: "acct" },
      {
        kind: "click",
        ref: REF_2,
        approved: true,
        site: "example.test",
        label: "Pay",
        amount: "1.00",
      },
    ];
    for (const step of protectedSteps) {
      expect(browser.describeAction(computer, { actions: [step] }, context)).toBeUndefined();
    }

    expect(
      browser.describeAction(
        computer,
        { actions: [{ kind: "click", ref: STALE_NONCE_REF }] },
        context,
      ),
    ).toBeUndefined();
    expect(
      browser.describeAction(
        { ...computer, kind: "fake" },
        { actions: [{ kind: "click", ref: REF_2 }] },
        context,
      ),
    ).toBeUndefined();
  });
});

describe("ego browser downloads", () => {
  it("passes the download folder and workspace root to navigate and act", async () => {
    const { browser, fake } = ego((input) =>
      input.action === "act" ? nextPage({ completed: 1, uncertain: false }) : page(),
    );

    await browser.navigate(
      computer,
      { url: "https://example.test/form", downloads: "Downloads", waitForDownload: true },
      context,
    );
    expect(fake.seen.at(-1)!.input).toMatchObject({
      downloadRoot: path.resolve(workspace),
      downloads: "Downloads",
      waitForDownload: true,
    });

    const snap = await browser.snapshot(computer, {}, context);
    await browser.act(
      computer,
      {
        actions: [{ kind: "click", ref: snap.elements![0]!.ref }],
        downloads: "Downloads",
        waitForDownload: true,
      },
      context,
    );
    expect(fake.seen.at(-1)!.input).toMatchObject({
      downloadRoot: path.resolve(workspace),
      downloads: "Downloads",
      waitForDownload: true,
    });
  });

  it("passes the folder through even with an unusable root, and skips only a missing folder", async () => {
    const plain = ego(() => page());
    await plain.browser.navigate(computer, { url: "https://example.test/form" }, context);
    expect(plain.fake.seen[0]!.input).not.toHaveProperty("downloads");
    expect(plain.fake.seen[0]!.input).not.toHaveProperty("downloadRoot");

    for (const providerRef of ["relative/home", ""]) {
      const relative = ego(() => page());
      await relative.browser.navigate(
        { ...computer, providerRef },
        { url: "https://example.test/form", downloads: "Downloads" },
        context,
      );
      expect(relative.fake.seen[0]!.input).toMatchObject({
        downloads: "Downloads",
        downloadRoot: providerRef,
      });
    }
  });

  it("forwards saved files and keeps an error entry, dropping unsafe paths", async () => {
    const { browser } = ego(() => ({
      ...page(),
      downloads: [
        { name: "report.pdf", path: "Downloads/download-abc/report.pdf", size: 12 },
        { name: "bad.pdf", error: "Not saved." },
        {
          name: "kept.pdf",
          path: "Downloads/download-abc/kept.pdf",
          size: 4,
          error: "Saved, but its temporary browser copy could not be removed: EBUSY",
        },
        { name: "absolute.pdf", path: "/tmp/absolute.pdf" },
        { name: "parent.pdf", path: "../parent.pdf" },
      ],
    }));
    const result = await browser.navigate(
      computer,
      { url: "https://example.test/form", downloads: "Downloads" },
      context,
    );
    expect(result.downloads).toEqual([
      { name: "report.pdf", path: "Downloads/download-abc/report.pdf", size: 12 },
      { name: "bad.pdf", error: "Not saved." },
      {
        name: "kept.pdf",
        path: "Downloads/download-abc/kept.pdf",
        size: 4,
        error: "Saved, but its temporary browser copy could not be removed: EBUSY",
      },
    ]);
  });
});
