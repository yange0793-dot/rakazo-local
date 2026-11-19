import type {
  AdapterContext,
  AgentToolExecutionObserver,
  AutoReviewRequest,
  BrowserActionDescription,
  BrowserActRequest,
  BrowserActStep,
  ConnectorCall,
  ToolBatch,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  applyJudgeDecision,
  approvalModeFromPreference,
  BACKGROUND_HELPER_TRIGGER,
  batchActions,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  decisiveActionApprovalRules,
  displayName,
  humanizeToolName,
  newSiteOutcome,
  outboundSiteGate,
  outsideRunToolRequiresApproval,
  planActionGate,
  redactSecrets,
  repeatsDeniedAction,
  resolveActionApprovalForTools,
  SITE_SENDING_TOOLS,
  TAINT_GATED_BUILTIN_TOOLS,
  toolNeedsPersonApproval,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
} from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { AuditEventInput } from "@rakazo/db";
import { recordAuditEvent, runSecretKind } from "@rakazo/db";
import type { ApprovalBrowserAction, FleetCardSummary } from "./approval-ask.js";
import { buildApprovalAskBlock, MAX_FETCH_URL_LENGTH } from "./approval-ask.js";
import {
  boundDirectApprovalDetails,
  DENIED_ACTION_ERROR,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  uncertainEffectResult,
} from "./approval-effect.js";
import type { AutoReviewChecker } from "./auto-review.js";
import {
  isAutoReviewCheckerConfigured,
  redactToolArgsForReview,
  resolveAutoReviewChecker,
} from "./auto-review.js";
import { reviewWithBackups } from "./auto-review-backups.js";
import { RAKAZO_DOCS_URLS } from "./builtin-skills.js";
import { toComputerRef } from "./computer-support.js";
import { redactConnectorPayload } from "./connector-safety.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { CATALOG_LOAD, CATALOG_SEARCH } from "./lazy-tool-catalog.js";
import { mcpServerPreapprovalRefusal } from "./mcp-server-tool.js";
import { findConnectedModelCredential } from "./model-selection.js";
import { paidRequestEffect } from "./paid-request.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import { PURCHASE_CHECKED_TOOLS, purchaseApprovalOf } from "./purchase-gate.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import type { RunContext, RunTrust } from "./run-context.js";
import {
  isRunTainted,
  nextMutatingEffectOccurrence,
  pauseForApproval,
  pauseForSecret,
  persistTurnCheckpoint,
} from "./run-context.js";
import {
  CATALOG_APPROVAL_TOOL,
  claimEffect,
  completeEffect,
  recordEffect,
  uncertainEffectError,
} from "./run-effects.js";
import { enqueueSteeringContinuation, renewRunLease } from "./run-lifecycle.js";
import { notifyRun } from "./run-notifications.js";
import { resolveCompletedSecretLeftover } from "./run-secret.js";
import type { ToolRequest } from "./run-tool-request.js";
import { BUILTIN_AGENT_TOOL_NAMES, READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";
import { callMediaTool } from "./run-tools-files.js";
import { callPaidService } from "./run-tools-integrations.js";
import { USER_COMPUTER_TOOLS, userComputerGate } from "./run-tools-user-computer.js";
import { connectorTrustKeys } from "./run-trust.js";
import { watchFromTool } from "./schedule-tools.js";
import { pagePaymentPrecheck, paysWithWallet } from "./spending-gate.js";
import { announceTicketAttention } from "./ticket-attention.js";
import { refusal } from "./tool-refusal.js";

export type AppliedEffect = Awaited<ReturnType<typeof recordEffect>>;

/** browser_act kinds that use saved logins, cards or codes: a background helper never runs them. */
const HELPER_UNSUPPORTED_BROWSER_KINDS: ReadonlySet<string> = new Set([
  "fill_secret",
  "fill_card",
  "fill_pay_token",
  "fill_code",
]);
const PAGE_TOOLS = ["browser_navigate", "browser_snapshot", "browser_act"];

type ApprovalCard = {
  reviewReason: string | undefined;
  summary: FleetCardSummary | undefined;
  batch: ToolBatch | undefined;
  onceOnly: boolean;
  /** The chat that started this helper: its approval card is shown there. */
  cardThreadId?: string;
  /** The page a browser action would act on, read from the browser's last observation. */
  browserAction?: ApprovalBrowserAction;
};

/** A tool call that passed its approval gate, as tool handlers receive it. */
export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly executionId: string;
  readonly observer: AgentToolExecutionObserver | undefined;
  readonly connectorCall: ConnectorCall;
  /** Idempotency key of this call's effect; also the delivery key of what it sends. */
  readonly effectKey: string;
  /** The effect recorded for this call. Read-only tools that need no approval have none. */
  readonly applied: AppliedEffect | undefined;
  readonly nextApprovedTool: string | undefined;
  /** A gated call that policy or the reviewer allowed without asking. */
  readonly bypassApproval: boolean;
  /**
   * The approved payment this call presses, counted against the user's spending limit just before
   * the press: the handler records it then, so a call that stops earlier never uses the room.
   */
  readonly spend: PurchaseApproval | undefined;
  /** This call moved its effect to executing. request_secret can hand the claim back. */
  claimedEffect: boolean;
  /** Store the result on the effect; false when it could not be stored. */
  readonly persistEffectResult: (result: unknown) => Promise<boolean>;
  /** Store the result and return it, or an uncertain-effect result when storing failed. */
  readonly finish: (result: unknown) => Promise<unknown>;
  /** Claim the effect to execute it, or return what an earlier attempt already settled. */
  readonly claimOrReturn: (from: "approved" | "intended") => Promise<unknown | undefined>;
}

export type ToolHandler = (ctx: RunContext, call: ToolCall) => Promise<unknown>;
export type ToolHandlers = Record<string, ToolHandler>;

type GateOutcome = { result: unknown } | { call: ToolCall };

type ToolReview = {
  name: string;
  args: Record<string, unknown>;
  connectorKind: ReturnType<typeof connectorKindFromToolName>;
  newSite: boolean;
  fetchUrl: string | undefined;
  matchingRules: ReturnType<typeof resolveActionApprovalForTools>["matchingRules"];
  gated: boolean;
  applied: AppliedEffect | undefined;
  injectedReview: ExecutorDeps["autoReview"];
  checker: AutoReviewChecker | null | undefined;
  reviewSettings: Awaited<ReturnType<RunTrust["loadApprovalModel"]>> | null;
  memberChecker: boolean;
};

/**
 * Decide whether a resolved call runs, asks the owner, is reviewed, or is refused, and record
 * the effect it claims. Returns the result to hand back when the call stops here.
 */
export async function gateToolCall(
  ctx: RunContext,
  request: ToolRequest,
  observer: AgentToolExecutionObserver | undefined,
): Promise<GateOutcome> {
  const { deps, run, runId, context } = ctx;
  const { name, executionId, connectorCall, resolvedTool, nextApprovedTool, approvedEffectKey } =
    request;
  const { replayEffectToolName } = request;
  let { args, effectRequest } = request;
  const durableBrowser =
    PAGE_TOOLS.includes(name) &&
    Boolean(ctx.providers.browser.checkpoint && ctx.providers.browser.restore);
  if (durableBrowser && ctx.computer.stored.providerRef) {
    const last = await deps.prisma.externalEffect.findFirst({
      where: {
        spaceId: run.spaceId,
        run: { botId: run.botId, userId: run.userId },
        kind: { in: PAGE_TOOLS },
        status: "completed",
        result: { path: ["browserState", "computerId"], equals: ctx.computer.stored.id },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { result: true },
    });
    const result = last?.result as Record<string, unknown> | null | undefined;
    const saved = result?.browserState as { computerId?: unknown; provider?: unknown } | undefined;
    if (saved?.computerId === ctx.computer.stored.id) {
      ctx.providers.browser.restore?.(toComputerRef(ctx.computer.stored), saved.provider, context);
    }
  }
  const viaConnector = !BUILTIN_AGENT_TOOL_NAMES.has(name);
  // Declared effect of the operation this call dispatches (installed API method and
  // flag). Install config is immutable per route resource, so it cannot drift before
  // execute; a catalog call uses the tool it was just resolved to.
  const connectorTool = viaConnector ? (resolvedTool ?? ctx.tools.connector.get(name)) : undefined;
  const declaredReadOnly = connectorTool?.readOnly;
  // A batch tool names the actions it runs in its arguments, so rules and the read/write
  // check look at each action, never the batch tool. An entry naming no action asks.
  const batch = connectorTool?.batch ? batchActions(connectorTool.batch, args) : undefined;
  const unidentifiedAction = Boolean(batch && !batch.complete);
  const approvalName = connectorCall.route?.connectionId ? connectorCall.route.toolName : name;
  const approvalToolNames = batch?.actions.length ? batch.actions : [approvalName];
  // Search and load return a list or a schema. They never call the connector.
  const catalogControlRead =
    !connectorCall.route?.connectionId &&
    !connectorCall.route?.resourceId &&
    (connectorCall.route?.toolName === CATALOG_SEARCH ||
      connectorCall.route?.toolName === CATALOG_LOAD);
  // A batch tool declared as a write makes each of its actions one.
  const declaredReadOnlyFor = (toolName: string) =>
    toolName === approvalName || toolName === name || declaredReadOnly === false
      ? declaredReadOnly
      : ctx.tools.connector.get(toolName)?.readOnly;
  const connectorProviders = ctx.tools.connectedPlugins.map((plugin) => plugin.provider);
  const connectorKind = connectorKindFromToolName(approvalName, connectorProviders);
  const watch = name === "schedule_create" ? watchFromTool(args.watch) : undefined;
  const httpWatch = watch?.kind === "http";
  // paid_request with only a purchase id sends the request its approval already named. A page
  // action is in SITE_SENDING_TOOLS so its card's "Always allow" saves the page's site; it never
  // sends a url itself, so the fetch checks below skip it.
  const sendsToSite =
    httpWatch ||
    (SITE_SENDING_TOOLS.has(name) &&
      name !== "browser_act" &&
      (name === "web_fetch" || args.url !== undefined));
  const fetchUrl = sendsToSite
    ? normalizedHttpUrl(String(httpWatch ? watch.url : (args.url ?? "")))
    : undefined;
  const fetchSite = fetchUrl ? urlSite(fetchUrl) : undefined;
  if (sendsToSite && !fetchSite)
    return { result: refusal("fetch_url_invalid", "url must be an http(s) URL") };
  if (fetchUrl && fetchUrl.length > MAX_FETCH_URL_LENGTH)
    return {
      result: refusal(
        "fetch_url_too_long",
        `url must be at most ${MAX_FETCH_URL_LENGTH} characters`,
      ),
    };
  // The card, the stored effect and the request all use the URL the gate checked.
  if (fetchUrl) {
    args = httpWatch ? { ...args, watch: { ...watch, url: fetchUrl } } : { ...args, url: fetchUrl };
    effectRequest = name === "paid_request" ? paidRequestEffect(args) : args;
  }
  // A page action's site comes from the browser's last observation, and its card names it: the
  // same site is what a saved rule allows, and what an "Always allow" answer on the card stores.
  const browserAction = name === "browser_act" ? describeBrowserAction(ctx, args) : undefined;
  const browserSite = browserAction ? urlSite(browserAction.url) : undefined;
  if (browserSite && browserAction) {
    // The stored request carries the approved page so the "Always" answer can allow its site.
    effectRequest = { ...args, url: browserAction.url };
  }
  const connectorTrusts = connectorTrustKeys(
    batch?.actions,
    connectorCall.route,
    connectorKind,
    connectorProviders,
  );
  const siteGate =
    fetchUrl && fetchSite
      ? outboundSiteGate({
          site: fetchSite,
          trusted:
            ctx.trust.searchResultUrls.has(fetchUrl) ||
            (name === "web_fetch" && RAKAZO_DOCS_URLS.includes(fetchUrl)) ||
            (await ctx.trust.loadTrustedSites()).has(fetchSite),
          rules: await ctx.trust.loadApprovalRules(),
        })
      : "allow";
  // A tool watch repeats its read unattended, so it passes the read check that call would now.
  const watchedTool = watch?.kind === "tool" ? watch.tool : undefined;
  const readTrusts = watchedTool
    ? connectorTrustKeys(
        undefined,
        ctx.tools.connector.get(watchedTool)?.route,
        connectorKindFromToolName(watchedTool, connectorProviders),
        connectorProviders,
      )
    : viaConnector &&
        !unidentifiedAction &&
        (catalogControlRead ||
          approvalToolNames.every(
            (toolName) => !connectorToolRequiresApproval(toolName, declaredReadOnlyFor(toolName)),
          ))
      ? connectorTrusts
      : undefined;
  const connectorReadGated =
    readTrusts !== undefined &&
    connectorReadRequiresApproval({
      tainted: await isRunTainted(ctx),
      connectorTrusted: await ctx.trust
        .loadTrustedConnectors()
        .then((trusted) => readTrusts.every((trust) => trusted.has(trust))),
    });
  // Unattended shell execution or repeated HTTP requests need a person's approval once;
  // neither an allow rule nor an automatic reviewer may create them.
  const unattendedWatch = watch?.kind === "command" || httpWatch;
  // A routine's prompt counts as the owner's words when it runs, so the sites it names are
  // ones its runs may fetch. Once outside content entered this run, a routine naming a
  // site this run was not given needs a person: a reviewer would judge it on this run's
  // context, and passing it would trust the site for every later run.
  const scheduleNamesNewSite =
    (name === "schedule_create" ||
      name === "create_child_routine" ||
      (name === "schedule_update" && Boolean(args.prompt))) &&
    (await isRunTainted(ctx)) &&
    (await ctx.trust.routineNamesNewSite(String(args.prompt ?? "")));
  const { purchase, cardUse } = request;
  // A helper may browse pages, but buying and typing saved logins or cards stay with the bot's
  // own visible turn: its result can ask the bot to do those.
  if (
    run.trigger === BACKGROUND_HELPER_TRIGGER &&
    name === "browser_act" &&
    (purchase ||
      cardUse ||
      (Array.isArray(args.actions) &&
        args.actions.some(
          (action) =>
            Boolean(action) &&
            typeof action === "object" &&
            HELPER_UNSUPPORTED_BROWSER_KINDS.has(String((action as { kind?: unknown }).kind ?? "")),
        )))
  ) {
    return {
      result: refusal(
        "helper_browser_unavailable",
        "A background helper cannot buy anything or type saved logins, cards or codes. Don't retry; say in your result what the bot should do.",
      ),
    };
  }
  // A local (stdio) server is refused before the card: no answer could let it run.
  if (name === "add_mcp_server") {
    const uncreatable = mcpServerPreapprovalRefusal(args);
    if (uncreatable) return { result: refusal("mcp_server_unavailable", uncreatable) };
  }
  // A provider can make ordinary page actions consequential, but cannot override the owner's
  // Ask/Auto/Never policy. Purchases and saved cards retain their separate mandatory checks.
  const browserApprovalRequired =
    name === "browser_act" &&
    ctx.providers.browser.describe().capabilities.requiresActionApproval === true;
  // Typing a saved card is approved like a purchase: every time, by a person.
  const paying = Boolean(purchase) || Boolean(cardUse);
  // A built-in that needs a person because of who started this run or what it has read, never
  // the approval model: outside text that reached the run could otherwise run a shell command,
  // save a routine, spawn a bot, rewrite shared memory or add an MCP server. Taint is read only
  // when it can change the answer: a shell command in the owner's own run never depends on it.
  const taintDecidesPersonApproval =
    !viaConnector &&
    approvalToolNames.some(
      (toolName) =>
        TAINT_GATED_BUILTIN_TOOLS.has(toolName) &&
        !(toolName === "shell" && ctx.source.ownerStartedRun),
    );
  const personApprovalTainted = taintDecidesPersonApproval ? await isRunTainted(ctx) : false;
  const personApproval =
    !viaConnector &&
    approvalToolNames.some((toolName) =>
      toolNeedsPersonApproval({
        toolName,
        ownerStartedRun: ctx.source.ownerStartedRun,
        messagingChannelRun: ctx.source.messagingChannelRun,
        tainted: personApprovalTainted,
      }),
    );
  const requiresApprovalByDefault =
    request.heldForApproval ||
    browserApprovalRequired ||
    paying ||
    unattendedWatch ||
    siteGate === "new" ||
    unidentifiedAction ||
    personApproval ||
    (!catalogControlRead &&
      approvalToolNames.some(
        (toolName) =>
          toolRequiresApproval(toolName, viaConnector, declaredReadOnlyFor(toolName)) ||
          (!viaConnector && outsideRunToolRequiresApproval(run.trigger, toolName)),
      ));
  // A gated read still fails closed when its review errors, and keeps its approval key.
  const gated = requiresApprovalByDefault || connectorReadGated;
  // These ask in every run, whatever started it.
  const mandatoryInAnyRun =
    paying || unattendedWatch || scheduleNamesNewSite || toolRequiresExplicitApproval(name);
  // No allow rule skips these, and without them the tool needs no approval, so "Always allow"
  // on their card would save a rule that never takes effect.
  const asksEveryTime =
    (unattendedWatch || scheduleNamesNewSite) && !toolRequiresApproval(name, viaConnector);
  // Never ask runs everything else: only another owner's connection could have been steered into it.
  const guardedInNeverAsk = name === "respond_agent_connection";
  const resolvedRules = resolveActionApprovalForTools({
    tools: approvalToolNames.map((toolName) => ({
      name: toolName,
      aliases: toolName === approvalName && approvalName !== name ? [name] : undefined,
      connectorKind:
        toolName === approvalName
          ? connectorKind
          : connectorKindFromToolName(toolName, connectorProviders),
      readOnly: declaredReadOnlyFor(toolName),
    })),
    wrapper: batch ? { name, connectorKind } : undefined,
    site: fetchSite ?? browserSite,
    rules: await ctx.trust.loadApprovalRules(),
  });
  const approvalResolved =
    unidentifiedAction && resolvedRules.decision === "allow"
      ? { ...resolvedRules, decision: "ask" as const }
      : resolvedRules;
  const mode = approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference());
  // A helper's brief is the bot's own words, never the owner's, so Auto Review could only
  // authorize a write from text the model wrote itself. A helper's write still runs on the
  // owner's explicit allow or Never ask, exactly as it would in the owner's own turn.
  const helperWriteNeedsPerson =
    run.trigger === BACKGROUND_HELPER_TRIGGER &&
    viaConnector &&
    !catalogControlRead &&
    (unidentifiedAction ||
      approvalToolNames.some((toolName) =>
        connectorToolRequiresApproval(toolName, declaredReadOnlyFor(toolName)),
      ));
  // A person approves the person-approval tools above: the approval model never sees them.
  const reviewable =
    mode === "auto" && !mandatoryInAnyRun && !helperWriteNeedsPerson && !personApproval;
  const injectedReview = reviewable ? deps.autoReview : undefined;
  const reviewSettings = !reviewable || injectedReview ? null : await ctx.trust.loadApprovalModel();
  const memberChecker = reviewSettings?.primarySource === "member";
  const checker = !reviewable
    ? undefined
    : reviewSettings
      ? reviewSettings.primary
        ? {
            provider: reviewSettings.primary.provider,
            model: reviewSettings.primary.modelId,
            thinkingLevel: reviewSettings.primary.thinkingLevel,
            credentialId: reviewSettings.primary.credentialId,
          }
        : null
      : resolveAutoReviewChecker();
  const checkerConfigured =
    reviewable &&
    (Boolean(injectedReview) ||
      memberChecker ||
      Boolean(reviewSettings?.backups.length) ||
      (checker
        ? isAutoReviewCheckerConfigured({}) ||
          Boolean(
            await findConnectedModelCredential(
              deps.prisma,
              deps.secretStore,
              { userId: run.userId, spaceId: run.spaceId },
              checker.provider,
            ),
          )
        : false));
  const plan = USER_COMPUTER_TOOLS.has(name)
    ? await userComputerGate(ctx, approvalResolved.decision === "deny", name, args)
    : planActionGate({
        resolved: approvalResolved,
        mode,
        mandatory: mandatoryInAnyRun,
        steerable:
          guardedInNeverAsk && mode === "never"
            ? !ctx.source.ownerStartedRun || (await isRunTainted(ctx))
            : undefined,
        consequential: requiresApprovalByDefault,
        reviewOnly: connectorReadGated,
        checkerConfigured,
        newDestination: siteGate === "new",
        purchase: paying,
      });
  // Nobody is there to approve a purchase a webhook run reaches.
  if (paying && run.trigger === "webhook" && plan !== "deny") {
    await auditToolCall(ctx, name, "denied", { reason: "purchase_unattended" });
    return {
      result: refusal(
        "purchase_needs_approval_unattended",
        "This would complete a purchase, which needs the user's approval, and a webhook run cannot ask. Don't retry; tell the user.",
      ),
    };
  }
  if (plan === "deny") {
    await auditToolCall(ctx, name, "denied", {
      reason: approvalResolved.decision === "deny" ? "rule" : "never_asks",
    });
    return {
      result: refusal(
        "approval_denied",
        approvalResolved.decision === "deny"
          ? `${name} is blocked in this space${blockingRuleSuffix(approvalResolved)}. Don't try it another way; tell the user it's blocked.`
          : `${name} needs the owner's approval because it could have been asked for by someone else, and this space never asks. Don't retry; tell the user.`,
      ),
    };
  }
  // A pay click counts against the user's spending limit, unless it pays with a wallet purchase,
  // which was counted when it was requested. One the limit refuses is refused before the card; the
  // handler counts it for good just before the press.
  const spends = purchase && !paysWithWallet(args) ? purchase : undefined;
  if (spends && nextApprovedTool !== name) {
    const spender = {
      userId: run.userId,
      spaceId: run.spaceId,
      botId: ctx.bot.id,
      threadId: ctx.thread.id,
    };
    const refused = await pagePaymentPrecheck(deps.prisma, spender, spends);
    if (refused) {
      await auditToolCall(ctx, name, "denied", { reason: "spending_limit" });
      return { result: refusal("spending_limit", refused) };
    }
  }
  let reviewReason: string | undefined;
  let gateDecision: "ask" | "allow" = plan === "ask" ? "ask" : "allow";
  const needsApprovalEarly = plan === "ask" || plan === "judge";
  // A resumed approval keeps its key even if "Always allow" changed the policy.
  const usesApprovalKey =
    nextApprovedTool || name === "request_secret" || needsApprovalEarly || gated;
  // Count before choosing a key so an approved replay (occurrence 0 / base
  // key) cannot collide with a later identical-args call in this attempt.
  // request_secret stays single-use: retries must reuse the same card. A code is the exception:
  // a wrong or expired one needs a new card, so each request counts, and a retry still finds its
  // own through the saved turn.
  const occurrence =
    (name === "request_secret" && args.oneTimeCode === undefined) || name === "connect_app"
      ? 0
      : nextMutatingEffectOccurrence(
          ctx,
          replayEffectToolName,
          args,
          executionId,
          approvedEffectKey,
        );
  // An approved replay claims the row the user approved. A derived key can differ
  // (another call's occurrence count), which would ask again and strand the approval.
  const effectKey =
    approvedEffectKey ??
    (usesApprovalKey && occurrence === 0
      ? approvalEffectKey(runId, replayEffectToolName, args)
      : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence));
  // Connector read-only hints must not bypass approval, review, or replay decisions.
  // A fetch to a new site is gated like any action, so it needs an effect to approve.
  const applied =
    READ_ONLY_AGENT_TOOLS.has(name) &&
    !durableBrowser &&
    siteGate !== "new" &&
    nextApprovedTool !== name &&
    !approvedEffectKey
      ? undefined
      : await recordEffect(
          deps,
          run,
          replayEffectToolName,
          effectKey,
          effectRequest,
          executionId,
          ctx.state.effects.consumedIds,
          batch && (batch.complete ? batch.actions : []),
        );

  // Refuse a repeat of a tool the user denied earlier in this run. Refusals carry a result,
  // so only real denies match. A stored row is checked only while it still waits for an
  // answer. web_fetch and secret_request target one site per call; request_secret and
  // connect_app name their own target.
  // Browsing goes on after a denied purchase: a purchase is checked against earlier denied purchases
  // on the same site, and other page work against earlier denied page work that bought nothing.
  const pageAction = PURCHASE_CHECKED_TOOLS.has(name);
  const repeatChecked =
    applied &&
    (!applied.duplicate || applied.effect.status === "intended") &&
    !["web_fetch", "secret_request", "request_secret", "connect_app"].includes(name);
  const deniedEarlier = repeatChecked
    ? (
        await deps.prisma.externalEffect.findMany({
          where: { runId, status: "denied", kind: replayEffectToolName },
          select: { request: true, result: true },
        })
      ).flatMap((effect) =>
        effect.result == null &&
        (!pageAction ||
          purchaseApprovalOf(
            (effect.request as { purchaseApproval?: unknown } | null)?.purchaseApproval,
          )?.site === purchase?.site)
          ? [
              boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL)?.args ??
                effect.request,
            ]
          : [],
      )
    : [];
  if (
    applied &&
    repeatsDeniedAction({ toolName: replayEffectToolName, args, denied: deniedEarlier })
  ) {
    await deps.prisma.externalEffect.updateMany({
      where: { id: applied.effect.id, status: "intended" },
      data: { status: "denied", result: { refused: "repeat" } },
    });
    return { result: refusal("action_denied_repeat", DENIED_ACTION_ERROR) };
  }

  const runAutoReview = async () => {
    const judged = await reviewToolCall(ctx, {
      name,
      args,
      connectorKind,
      newSite: siteGate === "new",
      fetchUrl,
      matchingRules: approvalResolved.matchingRules,
      gated,
      applied,
      injectedReview,
      checker,
      reviewSettings,
      memberChecker,
    });
    if (!judged) return;
    reviewReason = judged.reason;
    gateDecision = judged.decision;
  };

  if (applied && plan === "judge" && (injectedReview || checker)) {
    if (!applied.duplicate) {
      await runAutoReview();
    } else {
      const priorDecision = applied.effect.reviewDecision;
      if (priorDecision === "ask" || priorDecision === "error") {
        reviewReason =
          typeof applied.effect.reviewReason === "string" ? applied.effect.reviewReason : undefined;
        gateDecision = "ask";
      } else if (priorDecision === "pass") {
        reviewReason =
          typeof applied.effect.reviewReason === "string" ? applied.effect.reviewReason : undefined;
        gateDecision = "allow";
      } else {
        await runAutoReview();
      }
    }
  } else if (applied?.duplicate && plan === "ask") {
    gateDecision = "ask";
  }
  if (context.signal.aborted) return { result: pauseForApproval(ctx) };
  if (
    siteGate === "new" &&
    newSiteOutcome({ trigger: run.trigger, decision: gateDecision }) === "deny"
  ) {
    if (applied) {
      await deps.prisma.externalEffect.updateMany({
        where: { id: applied.effect.id, status: "intended" },
        data: { status: "denied" },
      });
    }
    return {
      result: refusal(
        "fetch_needs_approval_unattended",
        `Fetching ${fetchSite} needs approval, and a webhook run cannot ask.`,
      ),
    };
  }

  const needsApproval = gateDecision === "ask";
  // An approved replay settles below and must not ask a second time.
  const duplicateGate = applied?.duplicate
    ? resolveDuplicateEffectGate(applied.effect, name)
    : undefined;
  const asksPersonNow = !duplicateGate || duplicateGate.action === "paused";
  // A background helper's own thread is hidden, so its approval is asked in the chat that
  // started it (Run.sourceMessageId is that chat's subagent card).
  const helperApproval =
    needsApproval && run.trigger === BACKGROUND_HELPER_TRIGGER && asksPersonNow
      ? await helperApprovalTarget(ctx)
      : undefined;
  // Without its originating chat there is nobody to show the card to: refuse rather than pause
  // a run whose thread no person can see.
  if (
    needsApproval &&
    run.trigger === BACKGROUND_HELPER_TRIGGER &&
    asksPersonNow &&
    !helperApproval
  ) {
    if (applied) {
      await deps.prisma.externalEffect.updateMany({
        where: { id: applied.effect.id, status: "intended" },
        data: { status: "denied" },
      });
    }
    return {
      result: refusal(
        "helper_cannot_ask_approval",
        `${name} needs the owner's approval, and this background helper has no chat to ask in. Don't retry; say in your result what the bot should ask for.`,
      ),
    };
  }
  const browserCardAction = needsApproval && asksPersonNow ? browserAction : undefined;
  const call = createToolCall(ctx, {
    name,
    args,
    executionId,
    observer,
    connectorCall,
    effectKey,
    applied,
    nextApprovedTool,
    bypassApproval: gateDecision === "allow" && gated,
    spend: spends,
  });
  const card: ApprovalCard = {
    reviewReason,
    summary: request.fleetSummary,
    batch: connectorTool?.batch,
    onceOnly: asksEveryTime,
    ...(helperApproval ?? {}),
    ...(browserCardAction ? { browserAction: browserCardAction } : {}),
  };

  if (applied?.duplicate) {
    const gate = resolveDuplicateEffectGate(applied.effect, name);
    if (gate.action === "return") {
      if (name === "request_secret") {
        const replacementSecret = await deps.prisma.secret.findFirst({
          where: {
            spaceId: run.spaceId,
            userId: run.userId,
            kind: runSecretKind(runId),
          },
          select: { id: true, createdAt: true },
        });
        if (!replacementSecret) return { result: gate.result };
        // Crash between persist and delete leaves the same OTP row. Do not
        // resubmit it to the connector; only newer rows are replacements.
        const effectUpdatedAt = applied.effect.updatedAt;
        if (
          !(effectUpdatedAt instanceof Date) ||
          resolveCompletedSecretLeftover({
            secretCreatedAt: replacementSecret.createdAt,
            effectUpdatedAt,
          }) === "drop_leftover"
        ) {
          await deps.prisma.secret.delete({
            where: { id: replacementSecret.id },
          });
          return { result: gate.result };
        }
      } else {
        return { result: browserResultWithoutState(name, gate.result) };
      }
    }
    if (gate.action === "paused") {
      if (name === "request_secret") {
        const current = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (current?.status === "waiting_input") {
          return { result: pauseForSecret(ctx) };
        }
        // An intended secret request resumes protected entry below, including
        // recovery after action approval but before the card was committed.
      } else if (!needsApproval) {
        const early = await call.claimOrReturn("intended");
        if (early !== undefined) return { result: early };
      } else {
        const current = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (current?.status === "waiting_input") {
          return { result: pauseForApproval(ctx) };
        }
        return { result: await requestApproval(ctx, call, card) };
      }
    } else if (gate.action === "uncertain") {
      return { result: await settleToolUncertainty(ctx, call, applied.effect.id, gate.toolName) };
    } else if (gate.action === "execute") {
      const early = await call.claimOrReturn("approved");
      if (early !== undefined) return { result: early };
    }
  } else if (needsApproval && applied) {
    return { result: await requestApproval(ctx, call, card) };
  } else if (call.bypassApproval && applied) {
    const early = await call.claimOrReturn("intended");
    if (early !== undefined) return { result: early };
  }
  // Past the gate: this destination is now one the run was given. A search result's exact
  // URL trusts only that URL, never the rest of its site.
  if (fetchSite && siteGate === "new") (await ctx.trust.loadTrustedSites()).add(fetchSite);
  if (viaConnector) {
    const trusted = await ctx.trust.loadTrustedConnectors();
    for (const trust of connectorTrusts) trusted.add(trust);
  }
  return { call };
}

/** A bot's consequential tool call, recorded in its organization's audit log. */
export async function auditToolCall(
  ctx: RunContext,
  tool: string,
  outcome: "success" | "failure" | "denied",
  metadata: AuditEventInput["metadata"],
  recorded: Pick<AuditEventInput, "action" | "actor"> = {
    action: "tool.call",
    actor: { type: "bot", id: ctx.bot.id, label: ctx.bot.name },
  },
): Promise<void> {
  await recordAuditEvent({
    ...recorded,
    spaceId: ctx.run.spaceId,
    target: { type: "tool", id: tool, label: humanizeToolName(tool) },
    outcome,
    runId: ctx.runId,
    threadId: ctx.thread.id,
    metadata,
  });
}

function blockingRuleSuffix(resolved: ReturnType<typeof resolveActionApprovalForTools>): string {
  const labels = decisiveActionApprovalRules(resolved).map((rule) => {
    const value = rule.matchValue.trim().replace(/\s+/g, " ");
    return JSON.stringify(rule.matchKind === "site" ? value : humanizeToolName(value));
  });
  if (labels.length === 0) return "";
  return ` by the saved ${labels.length === 1 ? "rule" : "rules"} ${labels.join(", ")}`;
}

function createToolCall(
  ctx: RunContext,
  fields: Omit<ToolCall, "claimedEffect" | "persistEffectResult" | "finish" | "claimOrReturn">,
): ToolCall {
  const { deps } = ctx;
  const { name, args, applied } = fields;
  const call: ToolCall = {
    ...fields,
    claimedEffect: false,
    persistEffectResult: (result) => {
      if (!applied) return Promise.resolve(true);
      let stored = result;
      if (
        PAGE_TOOLS.includes(name) &&
        ctx.providers.browser.checkpoint &&
        ctx.computer.stored.providerRef
      ) {
        const details =
          result &&
          typeof result === "object" &&
          "kind" in result &&
          result.kind === "agent_tool_result" &&
          "details" in result
            ? result.details
            : result;
        stored = {
          ...(details && typeof details === "object" ? details : {}),
          browserState: {
            computerId: ctx.computer.stored.id,
            provider: redactConnectorPayload(
              ctx.providers.browser.checkpoint(toComputerRef(ctx.computer.stored), ctx.context),
              ctx.secrets,
            ),
          },
        };
      }
      return completeEffect(
        deps,
        applied.effect.id,
        call.claimedEffect ? "executing" : "intended",
        stored,
      );
    },
    finish: async (result) =>
      (await call.persistEffectResult(result)) ? result : uncertainEffectResult(name, args),
    claimOrReturn: async (from) => {
      if (await claimEffect(deps, ctx.runId, applied!.effect.id, from)) {
        call.claimedEffect = true;
        return undefined;
      }
      const current = await deps.prisma.externalEffect.findUnique({
        where: { id: applied!.effect.id },
      });
      if (current) {
        const retryGate = resolveDuplicateEffectGate(current, name);
        if (retryGate.action === "return") return browserResultWithoutState(name, retryGate.result);
        if (retryGate.action === "uncertain") {
          return settleToolUncertainty(ctx, call, applied!.effect.id, name);
        }
      }
      throw uncertainEffectError(name);
    },
  };
  return call;
}

/** Browser recovery metadata is server state, not part of the model's tool response. */
function browserResultWithoutState(name: string, result: unknown): unknown {
  if (!PAGE_TOOLS.includes(name) || !result || typeof result !== "object") return result;
  const { browserState: _state, ...visible } = result as Record<string, unknown>;
  return visible;
}

async function settleToolUncertainty(
  ctx: RunContext,
  call: ToolCall,
  effectId: string,
  toolName: string,
) {
  if (call.name === "generate_image" || call.name === "generate_video") {
    const recovered = await callMediaTool(ctx, call, true);
    if (
      recovered !== undefined &&
      (await completeEffect(ctx.deps, effectId, "executing", recovered))
    )
      return recovered;
  }
  if (call.name === "service_call") {
    const recovered = await callPaidService(ctx, call).catch(() => undefined);
    // Only an answer the provider settled carries a cost; anything else stays uncertain.
    if (
      recovered &&
      "cost_usd" in recovered &&
      (await completeEffect(ctx.deps, effectId, "executing", recovered))
    )
      return recovered;
  }
  return settleUncertainEffect(ctx.deps.prisma, effectId, toolName, call.args);
}

/** Ask the owner through an approval card. Parallel calls share the first call's pause. */
function requestApproval(ctx: RunContext, call: ToolCall, card: ApprovalCard) {
  const { approval } = ctx.state;
  // Parallel calls can need approval at once. Only the first saves the turn and shows
  // its card; the others wait for that pause. Otherwise a later call's save could make
  // the turn resume a call other than the one the user approved.
  if (approval.request) return approval.request.then(() => pauseForApproval(ctx));
  approval.request = showApprovalCard(ctx, call, card);
  return approval.request;
}

async function showApprovalCard(ctx: RunContext, call: ToolCall, card: ApprovalCard) {
  const { deps, run, runId, bot, thread } = ctx;
  const { name, args, executionId, applied } = call;
  if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) {
    // Another worker owns the run now; exit without leaving a local pause card.
    return pauseForApproval(ctx);
  }
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: ctx.workerId,
    leaseFence: ctx.fence,
    blocks: [
      buildApprovalAskBlock(
        applied!.effect.id,
        name,
        name === "update_bot" && "previousInstructions" in args ? { ...args, botId: bot.id } : args,
        ctx.secrets,
        card,
      ),
    ],
    // A helper's card belongs to the chat that started it; the run and its checkpoint stay
    // on its hidden thread.
    ...(card.cardThreadId ? { cardThreadId: card.cardThreadId } : {}),
  });
  // pauseRunForInput returning false after a successful renew means the run row no
  // longer matches this worker. Exiting via pauseForApproval() would leave the run
  // stuck in "running" with no ask card — fail instead so the user can retry.
  if (!paused) {
    throw new Error("Could not pause this run for approval; try sending again.");
  }
  await announceTicketAttention(deps, run, { waitId: ctx.attempt.id, needs: "approval" });
  await enqueueSteeringContinuation(deps, paused.continuationRunId);
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs approval`,
    body: `Review before ${name}`,
    botId: bot.id,
    // The chat the database confirmed the card is in, so the push opens where a person can
    // answer it; a run that paused in its own thread keeps that thread.
    threadId: paused.cardThreadId ?? thread.id,
  });
  return pauseForApproval(ctx);
}

/**
 * The chat that started a background helper, from the subagent card its run names. The
 * database validates the same source again before it writes the card there.
 */
async function helperApprovalTarget(
  ctx: RunContext,
): Promise<{ cardThreadId: string } | undefined> {
  const messageId = ctx.run.sourceMessageId;
  if (!messageId) return undefined;
  const source = await ctx.deps.prisma.message.findUnique({
    where: { id: messageId },
    select: { threadId: true, blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  const card = blocks.find(
    (block): block is Extract<MessageBlock, { kind: "subagent" }> => block.kind === "subagent",
  );
  if (!source || !card) return undefined;
  return { cardThreadId: source.threadId };
}

/** The page and elements a browser action would touch, from the browser's last observation. */
function describeBrowserAction(
  ctx: RunContext,
  args: Record<string, unknown>,
): ApprovalBrowserAction | undefined {
  const browser = ctx.providers.browser;
  const request = browserActRequest(args);
  const stored = ctx.computer.stored;
  if (!browser.describeAction || !request || !stored.providerRef) return undefined;
  try {
    const described = browser.describeAction(toComputerRef(stored), request, ctx.context);
    return described ? withTypedText(described, args) : undefined;
  } catch {
    // The description is card context only; the raw-argument card still asks the same person.
    return undefined;
  }
}

/**
 * The text each fill or type step would enter, paired with the element the browser described.
 * The browser describes the actions in the order it was asked to run them and refuses anything
 * it cannot describe, so the two lists line up. A protected step never gets here.
 */
function withTypedText(
  description: BrowserActionDescription,
  args: Record<string, unknown>,
): ApprovalBrowserAction {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  return {
    ...description,
    steps: description.steps.map((step, index) => {
      const text = (actions[index] as { text?: unknown } | undefined)?.text;
      return (step.kind === "fill" || step.kind === "type") &&
        typeof text === "string" &&
        text.trim()
        ? { ...step, text }
        : step;
    }),
  };
}

/**
 * The action as the browser interface takes it, when every step is a plain ref action.
 * Saved logins, cards and codes never reach a helper, and any other shape keeps the
 * existing raw-argument approval card.
 */
function browserActRequest(args: Record<string, unknown>): BrowserActRequest | undefined {
  const raw = Array.isArray(args.actions) ? args.actions : undefined;
  if (!raw?.length) return undefined;
  const actions: BrowserActStep[] = [];
  for (const entry of raw) {
    const step = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const ref = typeof step.ref === "string" ? step.ref : undefined;
    if (!ref) return undefined;
    const kind = step.kind;
    if (kind === "click") actions.push({ kind: "click", ref });
    // Typed text and file paths are left out: the page description names elements only.
    else if (kind === "fill" || kind === "type") actions.push({ kind, ref, text: "" });
    else if (kind === "upload") actions.push({ kind: "upload", ref, paths: [] });
    else return undefined;
  }
  return { actions };
}

/**
 * Run the configured reviewer (and its backups) on a call and store its verdict on the
 * effect. Returns nothing when there is no reviewer or the run was cancelled.
 */
async function reviewToolCall(
  ctx: RunContext,
  review: ToolReview,
): Promise<{ reason: string | undefined; decision: "ask" | "allow" } | undefined> {
  const { deps, run, runId, bot, thread, context } = ctx;
  const { name, args, connectorKind, fetchUrl, gated, applied } = review;
  const { injectedReview, checker, reviewSettings, memberChecker } = review;
  if (!injectedReview && !checker && !reviewSettings?.backups.length) return;
  try {
    const botDescription = redactSecrets(`${bot.name}\n${bot.description}`, ctx.secrets);
    // A run the owner did not start carries someone else's words in its task prompt: another
    // bot's message, a helper's result, a channel message. The checker gets only the owner's own
    // words for it, the message they sent or the routine they wrote. With none to judge against,
    // a person decides.
    const outsideRun = !ctx.source.ownerStartedRun;
    const ownerWords = outsideRun ? await ctx.trust.loadOwnerWords() : "";
    if (outsideRun && !ownerWords.trim()) return { reason: undefined, decision: "ask" };
    // A new site is judged on the full URL and the owner's own words only: the task
    // prompt of a webhook or bot-started run carries text someone else wrote.
    const reviewRequest: AutoReviewRequest =
      review.newSite && fetchUrl
        ? {
            toolName: name,
            connectorKind,
            args: { url: redactSecrets(fetchUrl, ctx.secrets) },
            userTask: redactSecrets(await ctx.trust.loadOwnerWords(), ctx.secrets),
            botDescription,
            matchingRules: review.matchingRules,
            newSite: true,
          }
        : {
            toolName: name,
            connectorKind,
            args: redactToolArgsForReview(args, ctx.secrets),
            userTask: redactSecrets(outsideRun ? ownerWords : ctx.task.prompt, ctx.secrets),
            botDescription,
            matchingRules: review.matchingRules,
          };
    const reviewContext: AdapterContext = {
      operationId: `auto-review:${runId}`,
      traceId: `auto-review:${runId}`,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      runId,
      signal: context.signal,
    };
    const checkerProvider = (checker: AutoReviewChecker) =>
      autoReviewCheckerProvider(
        deps,
        {
          runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          threadId: thread.id,
        },
        {
          injectedReview,
          memberChecker,
          backups: reviewSettings?.backups,
          registerSecrets: (values) => ctx.secrets.push(...values),
        },
        checker,
      );
    const judge = await reviewWithBackups(
      [
        ...(checker
          ? [checker]
          : injectedReview
            ? [{ provider: "injected", model: "injected" }]
            : []),
        ...(reviewSettings?.backups.map((choice) => ({
          provider: choice.provider,
          model: choice.modelId,
          thinkingLevel: choice.thinkingLevel,
          credentialId: choice.credentialId,
        })) ?? []),
      ],
      async (checker) => {
        const provider = await checkerProvider(checker);
        return provider.review(reviewRequest, reviewContext);
      },
      context.signal,
    );
    if (context.signal.aborted) return;
    const verdict = {
      reason: judge.reason,
      decision: applyJudgeDecision({ decision: judge.decision, consequential: gated }),
    };
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id },
        data: {
          reviewDecision: judge.decision,
          reviewReason: judge.reason,
          reviewModel: judge.model,
        },
      });
    }
    await auditAutoReview(ctx, name, applied, judge.decision, judge.model);
    return verdict;
  } catch {
    // Cancellation must not write a review the next attempt would reuse.
    if (context.signal.aborted) return;
    // Auth/refresh failures must fail closed like a checker error, not fail the run.
    const reviewReason = "Checker could not authenticate.";
    const verdict = {
      reason: reviewReason,
      decision: applyJudgeDecision({ decision: "error", consequential: gated }),
    };
    const reviewModel = checker
      ? `${checker.provider}/${checker.model}`
      : (injectedReview?.describe().id ?? "auto-review");
    if (applied) {
      await deps.prisma.externalEffect.update({
        where: { id: applied.effect.id },
        data: { reviewDecision: "error", reviewReason, reviewModel },
      });
    }
    await auditAutoReview(ctx, name, applied, "error", reviewModel);
    return verdict;
  }
}

function auditAutoReview(
  ctx: RunContext,
  tool: string,
  applied: AppliedEffect | undefined,
  decision: string,
  model: string | undefined,
): Promise<void> {
  return auditToolCall(
    ctx,
    tool,
    decision === "error" ? "failure" : "success",
    { effectId: applied?.effect.id, decision },
    { action: "approval.auto_reviewed", actor: { type: "system", label: model } },
  );
}
