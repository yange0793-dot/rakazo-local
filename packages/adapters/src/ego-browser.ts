import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  BrowserActionDescription,
  BrowserActRequest,
  BrowserActResult,
  BrowserActStep,
  BrowserControlRequest,
  BrowserControlResult,
  BrowserDownload,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserPage,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import { EGO_DOWNLOAD_HELPERS } from "./ego-downloads.js";

/** A snapshot stops growing here; a larger page is cut at a line and says how much was left. */
const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_PROCESS_OUTPUT = 64_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const BLOCKED_ORIGIN_ERROR =
  "Blocked by policy: this page is the app's own origin. Browser tools may not operate it.";

const PROTECTED_FILL_ERROR =
  "This protected fill needs a snapshot ref, an HTTPS origin and a supported field binding.";

const NO_SNAPSHOT_ERROR =
  "No bound page snapshot is available for this bot. Call browser_snapshot or browser_navigate first.";

export type EgoBrowserProviderOptions = {
  /** The ego-browser executable. Defaults to `~/.local/bin/ego-browser`. */
  command?: string;
  /**
   * Origins the page tools may never navigate to or act on, such as this app's own approval UI.
   * An origin matches exactly: scheme, host and port. Defaults to the app's own origins from
   * WEB_ORIGIN, BETTER_AUTH_URL and RAKAZO_EXTRA_AUTH_ORIGINS.
   */
  blockedOrigins?: string[];
  /** Environment for the default blocked origins. Tests inject their own. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: runs the ego-browser process. The default spawns it. */
  run?: EgoRunner;
  /** One ego-browser invocation may take this long. */
  timeoutMs?: number;
};

/** One `ego-browser nodejs` process. `script` goes to its stdin; paths are absolute. */
export type EgoInvocation = {
  command: string;
  script: string;
  inputPath: string;
  resultPath: string;
  signal?: AbortSignal;
  timeoutMs: number;
};

export type EgoRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type EgoRunner = (invocation: EgoInvocation) => Promise<EgoRunResult>;

type HelperAction = {
  kind: "click" | "fill" | "type" | "upload";
  ref: string;
  text?: string;
  paths?: string[];
  origin?: string;
  field?: "username" | "password" | "code";
};

type HelperExpectedElement = {
  role: string;
  name: string;
  loc?: string;
  occurrence: number;
  frame?: boolean;
};

type HelperExpectation = {
  nonce: string;
  spaceId: string;
  pageLabel: string;
  url: string;
  elements: Record<string, HelperExpectedElement>;
};

type HelperInput = {
  spaceName: string;
  action: "navigate" | "snapshot" | "act" | "hand_off" | "resume";
  session?: BrowserSession;
  pageId?: string;
  userConfirmed?: boolean;
  waitForDownload?: boolean;
  url?: string;
  query?: string;
  actions?: HelperAction[];
  expected?: HelperExpectation;
  /** Absolute workspace root a download is saved under. */
  downloadRoot?: string;
  /** Folder under that root, as the tool layer names it. */
  downloads?: string;
  blockedOrigins: string[];
  maxSnapshotChars: number;
};

type HelperElement = {
  ref: string;
  role: string;
  name: string;
  loc?: string;
  occurrence: number;
  selector: string;
  frame?: boolean;
};

type HelperResult = {
  ok: boolean;
  code?: string;
  error?: string;
  nonce?: string;
  spaceId?: number | string;
  pageLabel?: string;
  pages?: BrowserPage[];
  control?: "agent" | "user";
  url?: string;
  title?: string;
  snapshot?: string;
  elements?: HelperElement[];
  downloads?: BrowserDownload[];
  completed?: number;
  uncertain?: boolean;
  note?: string;
  dialog?: string;
};

type BrowserSession = { spaceId: string; pageLabel: string; handedOff?: boolean };

type PageState = {
  url: string;
  title: string;
  tree: string;
  elements: BrowserSnapshotNode[];
};

type SnapshotBinding = {
  nonce: string;
  spaceId: string;
  pageLabel: string;
  url: string;
  elements: Map<string, HelperExpectedElement>;
  page: PageState;
};

/** Refusals that must not send the model to another tool: nothing ran, and the page is known. */
const SETTLED_CODES = new Set([
  "blocked-origin",
  "invalid-action",
  "invalid-download-path",
  "element-ambiguous",
  "space-not-owned",
  "space-expired",
  "page-not-found",
  "protected-field",
  "resume-not-confirmed",
  "stale-ref",
  "unknown-ref",
  "unsupported-action",
]);

const DESKTOP_ONLY = "The ego page browser is only available on the native desktop computer.";
/** A per-snapshot random id and the element's position in that snapshot. */
const EXTERNAL_REF = /^s([0-9a-f]{16})-(\d+)$/;

/**
 * Page browser backed by an installed ego lite browser (`ego-browser nodejs`), for the native
 * desktop host. It drives the ego browser's own managed TaskSpace per bot and never closes,
 * finishes or claims a user's space or page. Returning a delegated space requires an explicit
 * user confirmation through control().
 *
 * Each snapshot mints refs with a random nonce. This process remembers the nonce with the
 * TaskSpace id, page label, URL and each element's role/name/locator. The executor persists that
 * minimal binding in its existing tool records. A restored binding is rechecked against a fresh
 * snapshot before pressing anything. Purchase semantics are not inferred from button text.
 */
export class EgoBrowserProvider implements BrowserProvider {
  private readonly command: string;
  private readonly blockedOrigins: string[];
  private readonly run: EgoRunner;
  private readonly timeoutMs: number;
  /** Cached bindings; the executor also saves their minimal form in durable tool records. */
  private readonly snapshots = new Map<string, SnapshotBinding>();
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(options: EgoBrowserProviderOptions = {}) {
    this.command = options.command?.trim() || path.join(homedir(), ".local/bin", "ego-browser");
    const origins = options.blockedOrigins
      ? options.blockedOrigins.map(originOrigin)
      : selfAppOrigins(options.env ?? process.env);
    this.blockedOrigins = withLoopbackAliases(origins);
    this.run = options.run ?? runEgoBrowser;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  describe() {
    return {
      id: "ego",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: true,
        refs: true,
        pageSelection: true,
        keyless: true,
        requiresGraphicalComputer: false,
        requiresActionApproval: true,
      },
    };
  }

  checkpoint(computer: ComputerRef, context: AdapterContext): unknown {
    const key = spaceKey(computer, context);
    const session = this.sessions.get(key);
    if (!session) return null;
    const binding = this.snapshots.get(key);
    return {
      provider: "ego",
      version: 1,
      scope: spaceNameFor(key),
      session,
      ...(binding
        ? {
            snapshot: {
              nonce: binding.nonce,
              url: binding.url,
              elements: [...binding.elements].map(([ref, element]) => ({ ref, ...element })),
            },
          }
        : {}),
    };
  }

  restore(computer: ComputerRef, state: unknown, context: AdapterContext): void {
    const key = spaceKey(computer, context);
    this.snapshots.delete(key);
    this.sessions.delete(key);
    if (!state || typeof state !== "object" || computer.kind !== "desktop") return;
    const saved = state as Record<string, unknown>;
    if (saved.provider !== "ego" || saved.version !== 1 || saved.scope !== spaceNameFor(key))
      return;
    const session = saved.session as Partial<BrowserSession> | undefined;
    if (
      !session ||
      typeof session.spaceId !== "string" ||
      !/^\d+$/.test(session.spaceId) ||
      typeof session.pageLabel !== "string" ||
      !/^p\d+$/.test(session.pageLabel)
    )
      return;
    this.sessions.set(key, {
      spaceId: session.spaceId,
      pageLabel: session.pageLabel,
      ...(session.handedOff === true ? { handedOff: true } : {}),
    });
    const snapshot = saved.snapshot as Partial<HelperResult> | undefined;
    if (!snapshot || session.handedOff) return;
    this.remember(key, {
      ok: true,
      nonce: snapshot.nonce,
      url: snapshot.url,
      elements: snapshot.elements,
      snapshot: "",
      ...session,
    });
  }

  async control(
    computer: ComputerRef,
    request: BrowserControlRequest,
    context: AdapterContext,
  ): Promise<BrowserControlResult> {
    const signal = request.signal ?? context.signal;
    signal.throwIfAborted();
    if (computer.kind !== "desktop") return { ok: false, error: DESKTOP_ONLY };
    if (request.action === "resume" && request.userConfirmed !== true) {
      return { ok: false, error: "The user must return control before this browser can resume." };
    }
    const key = spaceKey(computer, context);
    const session = this.sessions.get(key);
    if (!session)
      return { ok: false, error: "There is no browser session to hand over or resume." };
    this.snapshots.delete(key);
    const helper = await this.runHelper(
      {
        spaceName: spaceNameFor(key),
        session,
        action: request.action,
        userConfirmed: request.userConfirmed,
        blockedOrigins: this.blockedOrigins,
        maxSnapshotChars: MAX_SNAPSHOT_CHARS,
      },
      signal,
    );
    if ("error" in helper) return { ok: false, error: helper.error };
    if (request.action === "resume" && helper.result.code === "space-expired") {
      this.sessions.delete(key);
      return { ok: true, control: "agent" };
    }
    this.remember(key, helper.result);
    return {
      ok: helper.result.ok,
      ...pagesOf(helper.result),
      ...(helper.result.control ? { control: helper.result.control } : {}),
      ...(helper.result.error ? { error: helper.result.error } : {}),
    };
  }

  /**
   * What a pending page action is about, from the latest snapshot this process holds. It is
   * synchronous and read-only: it does not start a browser or materialize a computer, and it never
   * reports typed text, upload paths or secrets. An unknown or protected step leaves the card on
   * the existing raw-arguments path.
   */
  describeAction(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): BrowserActionDescription | undefined {
    if (computer.kind !== "desktop") return undefined;
    const binding = this.snapshots.get(spaceKey(computer, context));
    if (!binding?.url) return undefined;
    if (!Array.isArray(request.actions) || request.actions.length === 0) return undefined;
    const steps: BrowserActionDescription["steps"] = [];
    for (const step of request.actions) {
      if (
        step.kind !== "click" &&
        step.kind !== "fill" &&
        step.kind !== "type" &&
        step.kind !== "upload"
      ) {
        return undefined;
      }
      if (step.kind === "click" && step.approved) return undefined;
      if ((step.kind === "fill" || step.kind === "type") && (step.origin || step.field)) {
        return undefined;
      }
      if (step.ref === undefined) return undefined;
      const ref = normalizeRef(step.ref);
      const match = EXTERNAL_REF.exec(ref);
      const known = match && match[1] === binding.nonce ? binding.elements.get(ref) : undefined;
      if (!match || match[1] !== binding.nonce || !known) return undefined;
      steps.push({ kind: step.kind, role: known.role, name: known.name });
    }
    return { url: binding.url, steps };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    const signal = request.signal ?? context.signal;
    signal.throwIfAborted();
    const url = request.url.trim();
    if (computer.kind !== "desktop") return { url, title: "", error: DESKTOP_ONLY };
    const problem = httpUrlProblem(url);
    if (problem) return { url, title: "", fallback: "computer_act", error: problem };
    if (this.isBlocked(url)) return { url, title: "", error: BLOCKED_ORIGIN_ERROR };
    const key = spaceKey(computer, context);
    // A navigation invalidates every ref held for the page being left.
    this.snapshots.delete(key);
    const helper = await this.runHelper(
      {
        spaceName: spaceNameFor(key),
        session: this.sessions.get(key),
        pageId: request.pageId,
        action: "navigate",
        url,
        waitForDownload: request.waitForDownload,
        ...downloadInput(computer, request.downloads),
        blockedOrigins: this.blockedOrigins,
        maxSnapshotChars: MAX_SNAPSHOT_CHARS,
      },
      signal,
    );
    if ("error" in helper) {
      this.snapshots.delete(key);
      return { url, title: "", fallback: "computer_act", error: helper.error };
    }
    const result = helper.result;
    const page = pageOf(result);
    if (!result.ok) {
      this.snapshots.delete(key);
      return {
        url: text(result.url) ?? url,
        title: text(result.title) ?? "",
        ...(page ? { tree: page.tree, elements: page.elements } : {}),
        ...downloadsOf(result),
        ...pagesOf(result),
        ...(SETTLED_CODES.has(result.code ?? "") ? {} : { fallback: "computer_act" as const }),
        error: result.error || "The ego page browser could not open this page.",
      };
    }
    this.remember(key, result);
    return {
      url: page?.url || url,
      title: page?.title ?? "",
      ...(page ? { tree: page.tree, elements: page.elements } : {}),
      ...downloadsOf(result),
      ...pagesOf(result),
      ...(text(result.note) ? { note: text(result.note) } : {}),
      ...(text(result.dialog) ? { dialog: text(result.dialog) } : {}),
    };
  }

  async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    const signal = request.signal ?? context.signal;
    signal.throwIfAborted();
    if (computer.kind !== "desktop") {
      return { url: "", title: "", tree: "", elements: [], error: DESKTOP_ONLY };
    }
    const key = spaceKey(computer, context);
    const helper = await this.runHelper(
      {
        spaceName: spaceNameFor(key),
        session: this.sessions.get(key),
        pageId: request.pageId,
        action: "snapshot",
        ...(request.query ? { query: request.query } : {}),
        blockedOrigins: this.blockedOrigins,
        maxSnapshotChars: MAX_SNAPSHOT_CHARS,
      },
      signal,
    );
    if ("error" in helper) {
      this.snapshots.delete(key);
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: helper.error,
      };
    }
    const result = helper.result;
    const page = pageOf(result);
    if (!result.ok) {
      this.snapshots.delete(key);
      return {
        url: text(result.url) ?? "",
        title: text(result.title) ?? "",
        tree: page?.tree ?? "",
        elements: page?.elements ?? [],
        ...pagesOf(result),
        ...(SETTLED_CODES.has(result.code ?? "") ? {} : { fallback: "computer_act" as const }),
        error: result.error || "The ego page browser could not read the page.",
      };
    }
    this.remember(key, result);
    return {
      url: page?.url ?? "",
      title: page?.title ?? "",
      tree: page?.tree ?? "",
      elements: page?.elements ?? [],
      ...pagesOf(result),
      ...(page
        ? {}
        : { note: "The page could not be read. Call browser_snapshot again before acting." }),
      ...(text(result.note) ? { note: text(result.note) } : {}),
      ...(text(result.dialog) ? { dialog: text(result.dialog) } : {}),
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    const signal = request.signal ?? context.signal;
    signal.throwIfAborted();
    if (computer.kind !== "desktop") return settledAct(undefined, DESKTOP_ONLY);
    const key = spaceKey(computer, context);
    const binding = this.snapshots.get(key);
    if (!binding) return settledAct(undefined, NO_SNAPSHOT_ERROR);
    const prepared = await this.prepareActions(computer, request.actions, binding);
    if ("error" in prepared) return settledAct(binding.page, prepared.error);
    const helper = await this.runHelper(
      {
        spaceName: spaceNameFor(key),
        action: "act",
        session: this.sessions.get(key),
        actions: prepared.actions,
        expected: prepared.expected,
        waitForDownload: request.waitForDownload,
        ...downloadInput(computer, request.downloads),
        blockedOrigins: this.blockedOrigins,
        maxSnapshotChars: MAX_SNAPSHOT_CHARS,
      },
      signal,
    );
    if ("error" in helper) {
      // The script may have acted before its process or result was lost: observe, do not replay.
      this.snapshots.delete(key);
      return {
        ok: false,
        completed: 0,
        uncertain: true,
        url: "",
        title: "",
        fallback: "computer_act",
        error: helper.error,
      };
    }
    const result = helper.result;
    const remembered = this.remember(key, result);
    const page = remembered?.page ?? pageOf(result);
    if (!result.ok) {
      if (result.uncertain === false || SETTLED_CODES.has(result.code ?? "")) {
        return {
          ok: false,
          completed: completedCount(result.completed, request.actions.length),
          uncertain: false,
          url: text(result.url) ?? page?.url ?? "",
          title: text(result.title) ?? page?.title ?? "",
          ...(page ? { tree: page.tree, elements: page.elements } : {}),
          ...downloadsOf(result),
          ...pagesOf(result),
          ...(text(result.note) ? { note: text(result.note) } : {}),
          error: result.error || "The ego page browser refused this step.",
        };
      }
      return {
        ok: false,
        completed: completedCount(result.completed, request.actions.length),
        uncertain: true,
        url: text(result.url) ?? page?.url ?? "",
        title: text(result.title) ?? page?.title ?? "",
        ...(page ? { tree: page.tree, elements: page.elements } : {}),
        ...downloadsOf(result),
        ...pagesOf(result),
        ...(text(result.note) ? { note: text(result.note) } : {}),
        ...(result.code === "control-lost" ? {} : { fallback: "computer_act" as const }),
        error: result.error || "The ego page browser did not finish this step.",
      };
    }
    const note =
      text(result.note) ??
      (page
        ? undefined
        : "The actions ran, but the page could not be read afterward. Call browser_snapshot before continuing.");
    return {
      ok: true,
      completed: completedCount(result.completed, request.actions.length),
      url: text(result.url) ?? page?.url ?? "",
      title: text(result.title) ?? page?.title ?? "",
      ...(page ? { tree: page.tree, elements: page.elements } : {}),
      ...downloadsOf(result),
      ...pagesOf(result),
      ...(note ? { note } : {}),
      ...(text(result.dialog) ? { dialog: text(result.dialog) } : {}),
    };
  }

  /**
   * Resolves every refusal before the browser process starts, so one bad step cannot leave a
   * half-filled form. The page helper checks protected fields again on the actual document.
   */
  private async prepareActions(
    computer: ComputerRef,
    actions: BrowserActStep[],
    binding: SnapshotBinding,
  ): Promise<{ actions: HelperAction[]; expected: HelperExpectation } | { error: string }> {
    if (!Array.isArray(actions) || actions.length === 0) {
      return { error: "browser_act requires at least one action" };
    }
    const prepared: HelperAction[] = [];
    const expectedElements: Record<string, HelperExpectedElement> = {};
    for (const step of actions) {
      if (step.kind === "pay_token" || (step.kind === "fill" && step.field === "card")) {
        return { error: "Card fills and pay tokens are not supported by the ego page browser." };
      }
      if (step.kind === "click" && step.approved) {
        return {
          error: "Approved purchase clicks are not supported by the ego page browser.",
        };
      }
      if (step.kind === "fill" || step.kind === "type") {
        if (step.origin || step.field) {
          if (
            step.kind !== "fill" ||
            !step.origin ||
            !step.field ||
            !["username", "password", "code"].includes(step.field) ||
            httpUrlProblem(step.origin) ||
            !URL.canParse(binding.url) ||
            new URL(step.origin).protocol !== "https:" ||
            new URL(step.origin).origin !== step.origin ||
            new URL(binding.url).origin !== step.origin
          )
            return { error: PROTECTED_FILL_ERROR };
        }
        if (step.ref === undefined) return { error: PROTECTED_FILL_ERROR };
        if (typeof step.text !== "string") {
          return { error: `browser_act ${step.kind} requires text` };
        }
      }
      if (
        step.kind !== "click" &&
        step.kind !== "fill" &&
        step.kind !== "type" &&
        step.kind !== "upload"
      ) {
        return { error: `Unsupported browser action ${String(step.kind)}` };
      }
      if (step.ref === undefined)
        return { error: "This action needs an element ref from browser_snapshot." };
      const ref = normalizeRef(step.ref);
      const match = EXTERNAL_REF.exec(ref);
      const known = match && match[1] === binding.nonce ? binding.elements.get(ref) : undefined;
      if (!match || match[1] !== binding.nonce || !known) {
        return {
          error: `Element ref "${step.ref}" is not from the latest bound snapshot. Call browser_snapshot and use a ref it returns.`,
        };
      }
      expectedElements[ref] = {
        role: known.role,
        name: known.name,
        ...(known.loc ? { loc: known.loc } : {}),
        occurrence: known.occurrence,
        ...(known.frame ? { frame: true } : {}),
      };
      if (step.kind === "upload") {
        const paths = await uploadPaths(computer, step);
        if ("error" in paths) return paths;
        prepared.push({ kind: "upload", ref, paths: paths.paths });
        continue;
      }
      if (step.kind === "click") {
        prepared.push({ kind: "click", ref });
        continue;
      }
      prepared.push({
        kind: step.kind,
        ref,
        text: step.text,
        ...(step.origin && step.field
          ? { origin: step.origin, field: step.field as HelperAction["field"] }
          : {}),
      });
    }
    return {
      actions: prepared,
      expected: {
        nonce: binding.nonce,
        spaceId: binding.spaceId,
        pageLabel: binding.pageLabel,
        url: binding.url,
        elements: expectedElements,
      },
    };
  }

  private isBlocked(url: string): boolean {
    try {
      return this.blockedOrigins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  }

  /** Stores the snapshot a helper result describes, or clears the bot's refs if it has none. */
  private remember(key: string, result: HelperResult): SnapshotBinding | undefined {
    const page = pageOf(result);
    const nonce = result.nonce;
    const spaceId = result.spaceId;
    const pageLabel = result.pageLabel;
    if (spaceId !== undefined && typeof pageLabel === "string" && /^p\d+$/.test(pageLabel)) {
      this.sessions.set(key, {
        spaceId: String(spaceId),
        pageLabel,
        ...(result.control === "user" ? { handedOff: true } : {}),
      });
    }
    if (
      !page ||
      typeof nonce !== "string" ||
      !/^[0-9a-f]{16}$/.test(nonce) ||
      spaceId === undefined ||
      typeof pageLabel !== "string" ||
      !pageLabel
    ) {
      this.snapshots.delete(key);
      return undefined;
    }
    const elements = new Map<string, HelperExpectedElement>();
    for (const element of result.elements ?? []) {
      if (
        !element ||
        typeof element.ref !== "string" ||
        !element.ref.startsWith(`s${nonce}-`) ||
        typeof element.role !== "string" ||
        typeof element.name !== "string" ||
        !Number.isInteger(element.occurrence) ||
        element.occurrence < 0
      ) {
        continue;
      }
      elements.set(element.ref, {
        role: element.role,
        name: element.name,
        ...(typeof element.loc === "string" && element.loc ? { loc: element.loc } : {}),
        occurrence: element.occurrence,
        ...(element.frame ? { frame: true } : {}),
      });
    }
    const binding: SnapshotBinding = {
      nonce,
      spaceId: String(spaceId),
      pageLabel,
      url: page.url,
      elements,
      page,
    };
    this.snapshots.set(key, binding);
    return binding;
  }

  private async runHelper(
    input: HelperInput,
    signal: AbortSignal | undefined,
  ): Promise<{ result: HelperResult } | { error: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-ego-"));
    const inputPath = path.join(dir, "input.json");
    const resultPath = path.join(dir, "result.json");
    try {
      await writeFile(inputPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
      let run: EgoRunResult;
      try {
        run = await this.run({
          command: this.command,
          script: helperScript(inputPath, resultPath),
          inputPath,
          resultPath,
          ...(signal ? { signal } : {}),
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        signal?.throwIfAborted();
        return { error: egoFailure(error, this.command) };
      }
      signal?.throwIfAborted();
      let raw: string | undefined;
      try {
        raw = await readFile(resultPath, "utf8");
      } catch {
        raw = undefined;
      }
      if (raw !== undefined) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") {
            return { error: "ego-browser returned an unreadable result." };
          }
          const result = parsed as HelperResult;
          if (typeof result.ok !== "boolean") {
            return { error: "ego-browser returned an unreadable result." };
          }
          return { result };
        } catch {
          return { error: "ego-browser returned an unreadable result." };
        }
      }
      return { error: describeRunFailure(run) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function settledAct(page: PageState | undefined, error: string): BrowserActResult {
  return {
    ok: false,
    completed: 0,
    uncertain: false,
    url: page?.url ?? "",
    title: page?.title ?? "",
    ...(page ? { tree: page.tree, elements: page.elements } : {}),
    error,
  };
}

function pageOf(result: HelperResult): PageState | undefined {
  if (typeof result.snapshot !== "string" || !Array.isArray(result.elements)) return undefined;
  return {
    url: text(result.url) ?? "",
    title: text(result.title) ?? "",
    tree: result.snapshot,
    elements: publicElements(result),
  };
}

function publicElements(result: HelperResult): BrowserSnapshotNode[] {
  return (Array.isArray(result.elements) ? result.elements : []).flatMap((element) =>
    element &&
    typeof element.ref === "string" &&
    typeof element.role === "string" &&
    typeof element.name === "string"
      ? [{ ref: element.ref, role: element.role, name: element.name }]
      : [],
  );
}

function completedCount(value: unknown, limit: number): number {
  if (!Number.isInteger(value)) return 0;
  const count = value as number;
  if (count < 0 || count > limit) return limit;
  return count;
}

function httpUrlProblem(url: string): string | undefined {
  if (!URL.canParse(url)) return "An HTTP(S) URL without embedded credentials is required";
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    return "An HTTP(S) URL without embedded credentials is required";
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Snapshot refs are per-snapshot nonce refs; accept the brackets or prefixes a model may copy. */
function normalizeRef(value: string): string {
  let ref = value.trim();
  if (ref.startsWith("[") && ref.endsWith("]")) ref = ref.slice(1, -1).trim();
  if (ref.startsWith("@")) return ref.slice(1);
  if (ref.startsWith("ref=")) return ref.slice(4);
  return ref;
}

function spaceKey(computer: ComputerRef, context: AdapterContext): string {
  // context.botId is the running bot. computer.botId is the home key, shared by every bot on a
  // team computer, so it is only a fallback for callers outside a run.
  const bot = context.botId?.trim() || computer.botId;
  return JSON.stringify([
    context.spaceId,
    context.userId,
    bot,
    computer.id,
    computer.kind,
    computer.providerRef,
  ]);
}

/** Stable per bot and workspace, without putting either id or any local path in the browser UI. */
function spaceNameFor(key: string): string {
  return `Rakazo bot ${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * The workspace root and folder a page's downloads are saved under. Only a folder the tool did
 * not name skips the watch. A missing or relative root is passed through as it is, so the helper
 * refuses the action before dispatch instead of silently saving nothing.
 */
function downloadInput(
  computer: ComputerRef,
  directory: string | undefined,
): { downloadRoot?: string; downloads?: string } {
  if (!directory) return {};
  const root = computer.providerRef?.trim() ?? "";
  return {
    downloadRoot: path.isAbsolute(root) ? path.resolve(root) : root,
    downloads: directory,
  };
}

/**
 * Files the helper saved. Stored paths stay relative to the workspace root, as the computer
 * browser reports them, so the tool layer can map them to the bot's own path form.
 */
function publicDownloads(value: unknown): BrowserDownload[] {
  const files: BrowserDownload[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" && item.name ? item.name : undefined;
    const error = typeof item.error === "string" ? item.error : undefined;
    const stored = storedDownloadPath(item.path);
    if (!stored && !error) continue;
    files.push({
      ...(name ? { name } : {}),
      ...(stored ? { path: stored } : {}),
      ...(typeof item.size === "number" && Number.isFinite(item.size) ? { size: item.size } : {}),
      ...(error ? { error } : {}),
    });
  }
  return files;
}

/** A saved file names a path under the workspace: relative, with no NUL or parent segment. */
function storedDownloadPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.includes("\u0000")) return undefined;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[\\/]/.test(value)) {
    return undefined;
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) return undefined;
  return value;
}

function downloadsOf(result: HelperResult): { downloads?: BrowserDownload[] } {
  const downloads = publicDownloads(result.downloads);
  return downloads.length > 0 ? { downloads } : {};
}

function pagesOf(result: HelperResult): { pageId?: string; pages?: BrowserPage[] } {
  return {
    ...(result.spaceId !== undefined && result.pageLabel
      ? { pageId: `${result.spaceId}:${result.pageLabel}` }
      : {}),
    ...(Array.isArray(result.pages) ? { pages: result.pages } : {}),
  };
}

/**
 * Uploads stay inside the bot computer's workspace, plus the extra roots the executor trusts for
 * team bots. Both the roots and each file are resolved through realpath, so a symlink cannot
 * point an upload outside the workspace; the resolved paths are what the page receives.
 */
async function uploadPaths(
  computer: ComputerRef,
  step: Extract<BrowserActStep, { kind: "upload" }>,
): Promise<{ paths: string[] } | { error: string }> {
  const root = computer.providerRef?.trim();
  if (!root || !path.isAbsolute(root)) {
    return { error: "This bot computer has no workspace to upload from." };
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { error: "This bot computer's workspace is unavailable." };
  }
  const roots = [realRoot];
  for (const extra of Array.isArray(step.roots) ? step.roots : []) {
    if (typeof extra !== "string" || !extra.trim()) {
      return { error: "This bot computer has no workspace to upload from." };
    }
    try {
      roots.push(await realpath(path.resolve(realRoot, extra)));
    } catch {
      // A trusted root that does not exist cannot contain a file this call may upload.
    }
  }
  const paths: string[] = [];
  for (const file of step.paths) {
    if (typeof file !== "string" || !file.trim()) {
      return { error: "Upload paths must name files." };
    }
    const lexical = path.isAbsolute(file) ? path.resolve(file) : path.resolve(realRoot, file);
    let realFile: string;
    try {
      realFile = await realpath(lexical);
    } catch {
      return { error: "An upload file does not exist." };
    }
    if (!isAllowedDesktopPath(realFile, roots)) {
      return { error: "Upload files must stay inside this bot's workspace." };
    }
    paths.push(realFile);
  }
  return { paths };
}

function originOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    throw new Error(`Invalid blocked origin "${value}"`);
  }
}

/** The app's own origins, as the server already names them; nothing local is hardcoded here. */
function selfAppOrigins(source: NodeJS.ProcessEnv): string[] {
  const entries = [
    source.WEB_ORIGIN,
    source.BETTER_AUTH_URL,
    ...(source.RAKAZO_EXTRA_AUTH_ORIGINS ?? "").split(/[\s,]+/),
  ];
  const origins = new Set<string>();
  for (const entry of entries) {
    if (!entry?.trim()) continue;
    try {
      const url = new URL(entry.trim());
      if (/^https?:$/.test(url.protocol)) origins.add(url.origin);
    } catch {
      // An unusable entry must not stop the guard from covering the others.
    }
  }
  return [...origins];
}

/** `localhost` and `127.0.0.1` are the same local app on a port, so block both spellings. */
function withLoopbackAliases(origins: string[]): string[] {
  const result = new Set(origins);
  for (const origin of origins) {
    const url = new URL(origin);
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) continue;
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      result.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`);
    }
  }
  return [...result];
}

function describeRunFailure(run: EgoRunResult): string {
  if (run.timedOut) return "ego-browser did not finish in time.";
  const detail = (run.stderr.trim() || run.stdout.trim()).slice(-600);
  const status = run.exitCode === null ? "was interrupted" : `exited with code ${run.exitCode}`;
  return detail ? `ego-browser ${status}: ${detail}` : `ego-browser ${status}.`;
}

function egoFailure(error: unknown, command: string): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return `ego-browser is not installed at ${command}.`;
    if (code === "EACCES") return `ego-browser at ${command} is not executable.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Spawns `ego-browser nodejs` with the helper on stdin; no argument ever carries page content. */
function runEgoBrowser(invocation: EgoInvocation): Promise<EgoRunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: EgoRunResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const child = spawn(invocation.command, ["nodejs"], {
      cwd: path.dirname(path.resolve(invocation.command)),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, invocation.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-MAX_PROCESS_OUTPUT);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_PROCESS_OUTPUT);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exitCode: code,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(invocation.script);
  });
}

function helperScript(inputPath: string, resultPath: string): string {
  // Function replacements keep `$` sequences inside the injected source literal.
  return EGO_HELPER_SCRIPT.replace("__EGO_INPUT__", () => JSON.stringify(inputPath))
    .replace("__EGO_RESULT__", () => JSON.stringify(resultPath))
    .replace("__EGO_DOWNLOADS__", () => EGO_DOWNLOAD_HELPERS);
}

/**
 * Runs inside `ego-browser nodejs`. It uses only the API the ego-browser skill documents. It never
 * calls finish, release or close. A delegated space returns only through the explicit confirmed
 * resume operation. The adapter reads the result file because stdout may be empty.
 */
const EGO_HELPER_SCRIPT = String.raw`
const fs = await import("node:fs/promises");
const crypto = await import("node:crypto");
const input = JSON.parse(await fs.readFile(__EGO_INPUT__, "utf8"));

let activeTask;
let activePage;
let lastPages;
function redact(value) {
  if (typeof value === "string") {
    for (const action of input.actions || []) {
      if (!action.field || !action.text) continue;
      for (const secret of [action.text, JSON.stringify(action.text).slice(1, -1)]) {
        value = value.split(secret).join("[redacted]");
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}
async function write(value) {
  let pages = lastPages;
  if (activeTask && activeTask.ownership === "agent") {
    try { pages = await pageList(activeTask, activePage); } catch {}
  }
  await fs.writeFile(__EGO_RESULT__, JSON.stringify(redact({
    ...(pages ? { pages } : {}),
    ...value,
  })), { encoding: "utf8", mode: 0o600 });
}
const message = (error) => (error instanceof Error ? error.message : String(error));
const POLICY_DENIED =
  "Blocked by policy: this page is the app's own origin. Browser tools may not operate it.";

// The download helper keeps its own bindings inside this scope, so a name such as fs in its
// source cannot collide with the script above. It may use fs, input and message.
const startDownloadWatch = await (async () => {
__EGO_DOWNLOADS__
return startDownloadWatch;
})();

const downloadWatches = [];
const savedDownloads = [];
let downloadsCollected = false;
let popupNote;
const openedPopups = [];
let blockedPopup = false;
let morePopups = false;

/** Names the new page a click opened, without switching to it or echoing a blocked origin. */
function updatePopupNote() {
  const parts = openedPopups
    .map((item) => (item.url ? (item.label ? item.label + ": " + item.url : item.url) : item.label))
    .filter(Boolean);
  if (morePopups) parts.push("another page");
  if (blockedPopup) parts.push("another page blocked by policy");
  popupNote =
    parts.length > 0
      ? "The action opened a new page (" +
        parts.join(", ") +
        "); browser tools stay on this page."
      : undefined;
}

/** One watcher covers the whole call, so ordinary clicks never wait between steps. */
async function collectArmedDownloads() {
  if (downloadWatches.length === 0) return;
  const pending = downloadWatches.splice(0);
  const settled = await Promise.all(
    pending.map((watch) => watch.collect(input.waitForDownload === true).catch((error) => [{ error: message(error) }])),
  );
  for (const item of settled.flat()) {
    if (item && typeof item === "object") savedDownloads.push(item);
  }
}

/** Each watcher collects once; the last result carries everything the call saved. */
async function collectDownloads() {
  if (downloadsCollected) return savedDownloads.length > 0 ? savedDownloads : undefined;
  downloadsCollected = true;
  await collectArmedDownloads();
  return savedDownloads.length > 0 ? savedDownloads : undefined;
}

/** Every result carries what the call downloaded and, after a popup, where the new page is. */
async function writeResult(value) {
  const downloads = await collectDownloads();
  const withNote = popupNote && !("note" in value) ? { ...value, note: popupNote } : value;
  await write(downloads ? { ...withNote, downloads } : withNote);
}

/** Arms the download waiter before the action it covers; a bad folder refuses the action. */
async function armDownload(page) {
  if (!input.downloads || downloadWatches.length > 0) return undefined;
  try {
    downloadWatches.push(await startDownloadWatch(page, input.downloadRoot, input.downloads));
    return undefined;
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "invalid-download-path") return { code: code, error: message(error) };
    throw error;
  }
}

function dialogText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const named = value.message || value.text || value.type || value.kind;
    if (typeof named === "string") return named;
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return String(value);
}

function quoted(value) {
  const start = value.indexOf('"');
  if (start < 0) return undefined;
  const end = value.lastIndexOf('"');
  if (end <= start) return undefined;
  const raw = value.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return value.slice(start + 1, end);
  }
}

function identityOf(element) {
  return (
    element.role +
    String.fromCharCode(0) +
    element.name +
    String.fromCharCode(0) +
    (element.loc || "") +
    String.fromCharCode(0) +
    String(element.occurrence === undefined ? 0 : element.occurrence) +
    String.fromCharCode(0) + String(element.frame === true)
  );
}

function bindingMatches(page, state, expected) {
  return (
    String(page.spaceId) === String(expected.spaceId) &&
    page.label === expected.pageLabel &&
    String(state.info && state.info.url ? state.info.url : "") === String(expected.url || "")
  );
}

function elementFor(state, wanted) {
  if (!wanted) return undefined;
  const identity = identityOf(wanted);
  for (const element of state.elements) {
    if (identityOf(element) === identity) return element;
  }
  return undefined;
}

function selectorFor(role, name, loc) {
  if (loc) return "loc=" + loc;
  const value = name.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return "loc=role:" + role + "[name='" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "']";
}

/** The ref attribute, not an identical-looking sequence inside a quoted accessible name. */
function refAt(text) {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"' && text[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && text.startsWith("[ref=", index)) return index;
  }
  return -1;
}

function parseSnapshot(snapshot, nonce) {
  const lines = String(snapshot || "").split("\n");
  const root = lines.findIndex((line) => line.trim() === "root");
  const body = root >= 0 ? lines.slice(root) : lines;
  const elements = [];
  const egoRefs = new Map();
  const seen = new Map();
  const tree = [];
  const frames = [];
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    while (frames.length && indent <= frames[frames.length - 1]) frames.pop();
    const inFrame = frames.length > 0;
    if (/^iframe\b/i.test(trimmed)) frames.push(indent);
    const at = refAt(trimmed);
    if (at < 0) {
      tree.push(line);
      continue;
    }
    const head = trimmed.slice(0, at).trim();
    const role = head.split(/\s+/)[0] || "";
    if (!role) {
      tree.push(line);
      continue;
    }
    let name = quoted(head) || "";
    if (!name) {
      for (let next = index + 1; next < body.length; next += 1) {
        const candidate = body[next];
        const nextIndent = candidate.length - candidate.trimStart().length;
        if (nextIndent <= indent) break;
        const candidateTrimmed = candidate.trim();
        if (candidateTrimmed.startsWith("text ")) {
          const found = quoted(candidateTrimmed);
          if (found) {
            name = found;
            break;
          }
        }
      }
    }
    const rest = trimmed.slice(at + 1);
    const refMatch = /^ref=(\d+)/.exec(rest);
    if (!refMatch) {
      tree.push(line);
      continue;
    }
    const withoutClose = rest.endsWith("]") ? rest.slice(0, -1) : rest;
    const locAt = withoutClose.indexOf("loc=");
    let loc;
    if (locAt >= 0) {
      const urlAt = withoutClose.indexOf(", url=", locAt);
      loc = withoutClose.slice(locAt + 4, urlAt >= 0 ? urlAt : withoutClose.length).trim();
    }
    const lineAt = refAt(line);
    const withoutRef = line.slice(0, lineAt >= 0 ? lineAt : line.length).trimEnd();
    // An unnamed control can still have an actionable Ego ref. Only the ref from this
    // fresh observation is used to act; the persisted binding keeps its semantic identity.
    const selector = selectorFor(role, name, loc) || "@" + refMatch[1];
    const base = role + String.fromCharCode(0) + name + String.fromCharCode(0) + (loc || "");
    const occurrence = seen.get(base) || 0;
    seen.set(base, occurrence + 1);
    const ref = "s" + nonce + "-" + String(elements.length + 1);
    egoRefs.set(ref, "@" + refMatch[1]);
    elements.push({ ref, role, name, ...(loc ? { loc } : {}), occurrence, selector, ...(inFrame ? { frame: true } : {}) });
    tree.push(withoutRef + " [" + ref + "]");
  }
  return { body: tree.join("\n"), elements, egoRefs };
}

function bound(snapshot, limit) {
  if (snapshot.length <= limit) return snapshot;
  let cut = snapshot.lastIndexOf("\n", limit);
  if (cut < Math.floor(limit * 0.6)) cut = limit;
  return snapshot.slice(0, cut) + "\n[snapshot truncated: " + (snapshot.length - cut) + " more characters]";
}

function blocked(url) {
  if (!Array.isArray(input.blockedOrigins) || input.blockedOrigins.length === 0) return false;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return input.blockedOrigins.includes(origin);
}

async function observe(page) {
  let info = await page.info();
  const nonce = crypto.randomBytes(8).toString("hex");
  if (blocked(info.url)) return { info, nonce, tree: "", elements: [], egoRefs: new Map() };
  const limit = Number.isInteger(input.maxSnapshotChars) ? input.maxSnapshotChars : 12000;
  const raw = await page.snapshot({ scope: "full_page" });
  // Snapshot waits for pending navigation. Bind its refs to the settled URL, not the
  // old address returned just after a click.
  info = await page.info();
  if (blocked(info.url)) return { info, nonce, tree: "", elements: [], egoRefs: new Map() };
  const parsed = parseSnapshot(bound(String(raw || ""), limit), nonce);
  return { info, nonce, tree: parsed.body, elements: parsed.elements, egoRefs: parsed.egoRefs };
}

function pageView(page, state) {
  const dialog = state.info && state.info.dialog ? dialogText(state.info.dialog) : undefined;
  return {
    ok: true,
    nonce: state.nonce,
    spaceId: page.spaceId,
    pageLabel: page.label,
    url: String(state.info && state.info.url ? state.info.url : ""),
    title: String(state.info && state.info.title ? state.info.title : ""),
    snapshot: state.tree,
    elements: state.elements,
    ...(dialog ? { dialog } : {}),
  };
}

function refusal(code, error, page, state, completed = 0) {
  return {
    ok: false,
    code,
    error,
    uncertain: false,
    completed,
    nonce: state.nonce,
    spaceId: page.spaceId,
    pageLabel: page.label,
    url: String(state.info && state.info.url ? state.info.url : ""),
    title: String(state.info && state.info.title ? state.info.title : ""),
    snapshot: state.tree,
    elements: state.elements,
  };
}

async function openPage() {
  const spaces = await listTaskSpaces();
  const found = spaces.find((space) => space.name === input.spaceName);
  const control = input.action === "hand_off" || input.action === "resume";
  const wantedSpace = input.action === "act" ? input.expected && input.expected.spaceId : control ? input.session && input.session.spaceId : undefined;
  if (wantedSpace && (!found || String(found.id) !== String(wantedSpace))) {
    return { refused: { ok: false, code: "space-expired", error: "This browser session has expired. Observe a new session before continuing; no action was replayed.", uncertain: false, completed: 0 } };
  }
  const canResume = input.action === "resume" && input.userConfirmed === true &&
    input.session && found &&
    String(found.id) === String(input.session.spaceId) &&
    found.ownership === "agentDelegatedToUser";
  if (input.action === "hand_off" && found && found.ownership === "agentDelegatedToUser") {
    return { refused: { ok: true, spaceId: found.id, pageLabel: input.session.pageLabel, control: "user" } };
  }
  if (found && found.ownership !== "agent" && !canResume) {
    return {
      refused: {
        ok: false,
        code: "space-not-owned",
        error:
          "The ego TaskSpace for this bot is held by a space the agent does not own (ownership: " +
          String(found.ownership) +
          "). Browser tools will not take it over.",
        uncertain: false,
        completed: 0,
      },
    };
  }
  let task;
  try {
    task = canResume ? await takeOverTaskSpace(found.id) : found ? await taskSpace(found.id) : await taskSpace(input.spaceName);
  } catch (error) {
    const text = message(error);
    if (text.indexOf("EGO_TASK_SPACE_NAME_IN_USE") >= 0) {
      return {
        refused: {
          ok: false,
          code: "space-not-owned",
          error:
            "The ego TaskSpace name for this bot is held by a space the agent does not own. Browser tools will not take it over.",
          uncertain: false,
          completed: 0,
        },
      };
    }
    throw error;
  }
  if (task.ownership && task.ownership !== "agent") {
    return {
      refused: {
        ok: false,
        code: "space-not-owned",
        error:
          "The ego TaskSpace for this bot is no longer under agent control (ownership: " +
          String(task.ownership) +
          "). Browser tools will not take it over.",
        uncertain: false,
        completed: 0,
      },
    };
  }
  activeTask = task;
  const pages = await task.pages();
  let page;
  if (input.action === "resume") {
    const returned = task.userPage();
    if (returned) {
      page = pages.find((item) => item.label === returned.label && item.spaceId === returned.spaceId);
      if (!page) page = await task.adopt(returned);
    }
  }
  const selected = input.pageId ||
    (input.action === "act" && input.expected
      ? String(input.expected.spaceId) + ":" + input.expected.pageLabel
      : input.session && String(input.session.spaceId) === String(task.spaceId)
        ? String(input.session.spaceId) + ":" + input.session.pageLabel
        : undefined);
  if (!page && selected) {
    page = pages.find((item) => String(task.spaceId) + ":" + item.label === selected);
    if (!page) {
      return { refused: { ok: false, code: "page-not-found", error: "The selected page is no longer available. Select a page from pages and observe it before acting.", uncertain: false, completed: 0, pages: await pageList(task) } };
    }
  }
  page = page || pages[0] || (await task.newPage());
  activePage = page;
  return { task, page };
}

async function pageList(task, selected) {
  const pages = await task.pages();
  return Promise.all(pages.map(async (page) => {
    const url = String(await page.url() || "");
    return {
      id: String(task.spaceId) + ":" + page.label,
      url: blocked(url) ? "" : url,
      title: blocked(url) ? "" : String(await page.title() || ""),
      ...(selected && selected.label === page.label ? { selected: true } : {}),
      ...(blocked(url) ? { blocked: true } : {}),
    };
  }));
}

async function controlLost(task) {
  try {
    const current = (await listTaskSpaces()).find((space) => String(space.id) === String(task.spaceId));
    if (current && current.ownership === "agent") return false;
    activeTask = undefined;
    return true;
  } catch {
    return false;
  }
}

async function tryObserve(page) {
  try {
    return await observe(page);
  } catch {
    return undefined;
  }
}

/** A popup's label and URL from the receipt, read without adopting or switching to its Page. */
async function popupInfo(task, popup) {
  const label = popup && typeof popup.label === "string" ? popup.label : "";
  const targetId = popup && typeof popup.targetId === "string" ? popup.targetId : "";
  let found;
  try {
    const pages = await task.pages();
    found = pages.find(
      (item) => (label && item.label === label) || (targetId && item.targetId === targetId),
    );
  } catch {}
  if (!found) {
    try {
      const tabs = await task.tabs();
      const tab = tabs.find(
        (item) => (label && item.label === label) || (targetId && item.targetId === targetId),
      );
      found = tab && tab.page;
    } catch {}
  }
  let url = "";
  try {
    url = found ? String((await found.url()) || "") : "";
  } catch {}
  return { label: label, url: url };
}

/**
 * A protected fill is bound to one unique top-document CSS target from the fresh snapshot.
 * Check origin, URL and field type in the same evaluation that sets the value; iframe and
 * unidentifiable targets require handoff. No secret is returned from the page.
 */
async function protectedFill(page, element, action, expected, commit = true) {
  if (element.frame || !element.loc || !element.loc.startsWith("css:")) return false;
  // As with the computer's protected-input helper, an isolated world uses browser-owned DOM
  // methods rather than methods the website can replace. Raw CDP invalidates snapshot refs.
  const { frameTree } = await page.cdp("Page.getFrameTree");
  const { executionContextId } = await page.cdp("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "rakazo-protected-input",
  });
  const fill = ({ selector, url, origin, field, text, length, commit }) => {
    if (location.href !== url || location.origin !== origin || location.protocol !== "https:") return false;
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) return false;
    const el = matches[0];
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly || el.hidden ||
        !el.getClientRects().length || getComputedStyle(el).visibility !== "visible") return false;
    const type = el.type.toLowerCase();
    if (field === "password" && type !== "password") return false;
    if (field === "username" && !["text", "email", "tel"].includes(type)) return false;
    if (field === "code" && (!["text", "tel", "number", "password"].includes(type) ||
        !(el.autocomplete || "").toLowerCase().split(/\s+/).includes("one-time-code") ||
        (el.maxLength > 0 && el.maxLength < length))) return false;
    if (!["username", "password", "code"].includes(field)) return false;
    if (!commit) return true;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const args = { selector: element.loc.slice(4), url: expected.url, origin: action.origin,
    field: action.field, text: commit ? action.text : "", length: action.text.length, commit };
  const result = await page.cdp("Runtime.evaluate", {
    contextId: executionContextId,
    expression: "(" + fill.toString() + ")(" + JSON.stringify(args) + ")",
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error("The protected input could not be confirmed.");
  return result.result && result.result.value === true;
}

async function run() {
  if (input.action === "navigate" && blocked(input.url)) {
    await write({
      ok: false,
      code: "blocked-origin",
      error: POLICY_DENIED,
      uncertain: false,
      completed: 0,
      url: input.url,
      title: "",
    });
    return;
  }
  const opened = await openPage();
  if (opened.refused) {
    await write(opened.refused);
    return;
  }
  const { task, page } = opened;
  if (input.action === "hand_off") {
    lastPages = await pageList(task, page);
    await task.handOff();
    activeTask = undefined;
    await write({ ok: true, spaceId: task.spaceId, pageLabel: page.label, control: "user" });
    return;
  }
  if (input.action === "resume") {
    await write({ ok: true, spaceId: task.spaceId, pageLabel: page.label, control: "agent" });
    return;
  }

  if (input.action === "navigate") {
    const armed = await armDownload(page);
    if (armed) {
      await write({
        ok: false,
        code: armed.code,
        error: armed.error,
        uncertain: false,
        completed: 0,
        url: input.url,
        title: "",
      });
      return;
    }
    let failure;
    try {
      await page.goto(input.url);
    } catch (error) {
      failure = error;
    }
    if (failure) {
      if (await controlLost(task)) {
        await writeResult({ ok: false, code: "space-not-owned", uncertain: false, completed: 0,
          error: "Browser control is with the user or the session has closed. Return control before continuing." });
        return;
      }
      // A navigation whose answer is a file ends with ERR_ABORTED while the download still starts.
      const downloads = await collectDownloads();
      const saved = Array.isArray(downloads)
        ? downloads.some((item) => item && typeof item.path === "string")
        : false;
      if (saved) {
        const state = await tryObserve(page);
        if (state) {
          if (blocked(state.info.url)) {
            await write({ ...refusal("blocked-origin", POLICY_DENIED, page, state), downloads: downloads });
            return;
          }
          await write({ ...pageView(page, state), downloads: downloads });
          return;
        }
        await write({ ok: true, completed: 0, url: input.url, title: "", downloads: downloads });
        return;
      }
      await write({
        ok: false,
        code: "runtime",
        error: message(failure),
        ...(downloads ? { downloads: downloads } : {}),
      });
      return;
    }
    const state = await observe(page);
    if (blocked(state.info.url)) {
      await writeResult(refusal("blocked-origin", POLICY_DENIED, page, state));
      return;
    }
    await writeResult(pageView(page, state));
    return;
  }

  const state = await observe(page);
  if (blocked(state.info.url)) {
    await write(refusal("blocked-origin", POLICY_DENIED, page, state));
    return;
  }

  if (input.action === "snapshot") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      await write(pageView(page, state));
      return;
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = state.elements.filter((element) =>
      words.every((word) =>
        (element.role + " " + element.name + " " + (element.loc || "")).toLowerCase().includes(word),
      ),
    );
    const tree =
      matched
        .map((element) => "- " + element.role + " " + JSON.stringify(element.name) + " [" + element.ref + "]")
        .join("\n") || "(no interactive elements matched " + JSON.stringify(query) + ")";
    await write({
      ...pageView(page, state),
      snapshot: tree,
      elements: matched,
    });
    return;
  }

  const expected = input.expected;
  if (!expected || !expected.elements || typeof expected.elements !== "object") {
    await write(refusal("invalid-action", "This page action needs the snapshot binding held by the server process. Call browser_snapshot again.", page, state));
    return;
  }
  if (!bindingMatches(page, state, expected)) {
    await write(refusal("stale-ref", "The TaskSpace, page or URL changed since that snapshot. Call browser_snapshot again.", page, state));
    return;
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    await write(refusal("invalid-action", "browser_act requires at least one action.", page, state));
    return;
  }
  const byIdentity = new Map(state.elements.map((element) => [identityOf(element), element]));
  const resolved = new Map();
  for (const action of input.actions) {
    const ref = String(action.ref || "");
    if (!ref) {
      await write(refusal("invalid-action", "This action needs an element ref from browser_snapshot.", page, state));
      return;
    }
    if (!ref.startsWith("s" + expected.nonce + "-")) {
      await write(refusal("stale-ref", "Element ref " + JSON.stringify(ref) + " is not from the bound snapshot. Call browser_snapshot and use a ref it returns.", page, state));
      return;
    }
    const want = expected.elements[ref];
    if (!want) {
      await write(refusal("stale-ref", "Element ref " + JSON.stringify(ref) + " is not from the bound snapshot. Call browser_snapshot and use a ref it returns.", page, state));
      return;
    }
    const element = byIdentity.get(identityOf(want));
    if (!element || !element.selector) {
      await write(refusal("stale-ref", "The page changed since that snapshot; ref " + JSON.stringify(ref) + " no longer names the same element. Call browser_snapshot and use the refs it returns.", page, state));
      return;
    }
    resolved.set(ref, element);
  }
  for (const action of input.actions) {
    if (action.field && !(await protectedFill(page, resolved.get(action.ref), action, expected, false))) {
      await write(refusal("protected-field", "The protected field does not match its page, origin or field type. Nothing was typed; use a new snapshot or hand control to the user.", page, state));
      return;
    }
  }

  let completed = 0;
  let dialog;
  let stop = false;
  for (let index = 0; index < input.actions.length; index += 1) {
    const action = input.actions[index];
    let stepState = state;
    let element = resolved.get(action.ref);
    if (index > 0 || input.actions.some((step) => step.field)) {
      // Match the next step against the page as it is now, not the page the batch started on.
      try {
        stepState = await observe(page);
      } catch (error) {
        await writeResult({
          ok: false,
          code: "action-failed",
          error: message(error),
          uncertain: true,
          completed,
        });
        return;
      }
      if (blocked(stepState.info.url)) {
        await writeResult(refusal("blocked-origin", POLICY_DENIED, page, stepState, completed));
        return;
      }
      if (!bindingMatches(page, stepState, expected)) {
        await writeResult(refusal("stale-ref", "The TaskSpace, page or URL changed during this batch. Call browser_snapshot again.", page, stepState, completed));
        return;
      }
      element = elementFor(stepState, expected.elements[action.ref]);
    }
    if (!element || !element.selector) {
      await writeResult(refusal("stale-ref", "The page changed during this batch; ref " + JSON.stringify(action.ref) + " no longer names the same element. Call browser_snapshot and use the refs it returns.", page, stepState, completed));
      return;
    }
    // The raw ego ref is only valid for the snapshot just read in this invocation.
    const egoTarget = stepState.egoRefs.get(element.ref);
    if (!egoTarget) {
      await writeResult(refusal("stale-ref", "The page changed during this batch; ref " + JSON.stringify(action.ref) + " no longer names the same element. Call browser_snapshot and use the refs it returns.", page, stepState, completed));
      return;
    }
    const select = element.role === "combobox" || element.role === "select" || element.role === "listbox";
    try {
      if (action.kind === "click") {
        const armed = await armDownload(page);
        if (armed) {
          await writeResult(refusal(armed.code, armed.error, page, stepState, completed));
          return;
        }
        const receipt = await page.click(egoTarget);
        if (receipt && receipt.dialog) {
          dialog = dialogText(receipt.dialog);
          stop = true;
        }
        if (receipt && Array.isArray(receipt.popups) && receipt.popups.length > 0) {
          try {
            for (const popup of receipt.popups.slice(0, 3)) {
              const info = await popupInfo(task, popup);
              if (info.url && blocked(info.url)) {
                blockedPopup = true;
                continue;
              }
              if (info.label || info.url) openedPopups.push(info);
            }
            if (receipt.popups.length > 3) morePopups = true;
          } catch {}
          updatePopupNote();
        }
      } else if (action.kind === "fill") {
        if (action.field) {
          const filled = await protectedFill(page, element, action, expected);
          if (!filled) {
            await writeResult(refusal("protected-field", "The protected field no longer matches its page, origin or field type. Nothing was typed; use a new snapshot or hand control to the user.", page, stepState, completed));
            return;
          }
        } else if (select) {
          await page.selectOption(egoTarget, action.text);
        } else {
          await page.fill(egoTarget, action.text, { clearFirst: true });
        }
      } else if (action.kind === "type") {
        if (select) {
          await page.selectOption(egoTarget, action.text);
        } else {
          // Replace the field's text, not append to it: select all, then type over it.
          await page.press(egoTarget, "ControlOrMeta+A");
          await page.keyboard.type(action.text);
        }
      } else if (action.kind === "upload") {
        await page.setInputFiles(egoTarget, action.paths);
      } else {
        await writeResult(refusal("unsupported-action", "Unsupported browser action " + String(action.kind), page, state));
        return;
      }
    } catch (error) {
      if (await controlLost(task)) {
        await writeResult({ ok: false, code: "control-lost", uncertain: true, completed,
          error: "Browser control was lost while the action was running. Do not replay it or use another tool; wait for the user to return control." });
        return;
      }
      const after = await tryObserve(page);
      const failure = message(error);
      // A locator that matched no single element never dispatched: settled, not uncertain.
      const settled = failure.indexOf("ElementResolutionError") >= 0;
      await writeResult({
        ok: false,
        code: settled ? "element-ambiguous" : "action-failed",
        error: failure,
        uncertain: !settled,
        completed,
        ...(after
          ? {
              nonce: after.nonce,
              spaceId: page.spaceId,
              pageLabel: page.label,
              url: String(after.info && after.info.url ? after.info.url : ""),
              title: String(after.info && after.info.title ? after.info.title : ""),
              snapshot: after.tree,
              elements: after.elements,
            }
          : {}),
        ...(dialog ? { dialog } : {}),
      });
      return;
    }
    completed += 1;
    if (await controlLost(task)) {
      await writeResult({ ok: false, code: "space-not-owned", uncertain: false, completed,
        error: "Browser control is with the user or the session has closed. Return control before continuing." });
      return;
    }
    // A step may have navigated. Stop before the next click or fill if it reached a blocked origin.
    try {
      const now = await page.info();
      if (blocked(now.url)) {
        const blockedState = await tryObserve(page);
        if (blockedState) {
          await writeResult(refusal("blocked-origin", POLICY_DENIED, page, blockedState, completed));
        } else {
          await writeResult({
            ok: false,
            code: "blocked-origin",
            error: POLICY_DENIED,
            uncertain: false,
            completed,
          });
        }
        return;
      }
    } catch (error) {
      const after = await tryObserve(page);
      await writeResult({
        ok: false,
        code: "action-failed",
        error: message(error),
        uncertain: true,
        completed,
        ...(after
          ? {
              nonce: after.nonce,
              spaceId: page.spaceId,
              pageLabel: page.label,
              url: String(after.info && after.info.url ? after.info.url : ""),
              title: String(after.info && after.info.title ? after.info.title : ""),
              snapshot: after.tree,
              elements: after.elements,
            }
          : {}),
        ...(dialog ? { dialog } : {}),
      });
      return;
    }
    if (stop) break;
  }

  try {
    await page.waitForLoadState();
  } catch {}
  const after = await tryObserve(page);
  if (!after) {
    await writeResult({
      ok: true,
      completed,
      uncertain: false,
      note: "The actions ran, but the page could not be read afterward. Call browser_snapshot before continuing.",
      ...(dialog ? { dialog } : {}),
    });
    return;
  }
  if (blocked(after.info.url)) {
    await writeResult(refusal("blocked-origin", POLICY_DENIED, page, after, completed));
    return;
  }
  await writeResult({
    ...pageView(page, after),
    completed,
    uncertain: false,
    ...(dialog ? { dialog } : {}),
  });
}

try {
  await run();
} catch (error) {
  if (activeTask && await controlLost(activeTask)) {
    await writeResult({ ok: false, code: "space-not-owned", uncertain: false, completed: 0,
      error: "Browser control is with the user or the session has closed. Return control before continuing." });
  } else {
  await writeResult({ ok: false, code: "runtime", error: message(error) });
  }
}
`;
