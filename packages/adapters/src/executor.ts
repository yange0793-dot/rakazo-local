import { createHash } from "node:crypto";
import type { AgentRunRequest, ComputerRef, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock, RunStatus } from "@rakazo/contracts";
import { disabledBuiltinToolSet } from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  botMessageAllowsSilence,
  expandSkillReferencesInPrompt,
  formatSkillRunPrompt,
  formatSkillsCatalogInstruction,
  isCallClientNonce,
  isConversationalRun,
  isMessagingChannelRun,
  isOwnerStartedRun,
  isTerminal,
  messagingChannelId,
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
  nonOwnerChatPrivacyBlock,
  promptInvokesSkill,
  redactSecrets,
  renderBotDirectory,
  userTurnMessageForRun,
} from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import {
  accountDeactivated,
  appendEventInTransaction,
  availableInSpace,
  cancelDeactivatedAccountRuns,
  cancelRunsInTransaction,
  createPendingSteeringRun,
  effectiveMemoryScope,
  isPartialReplyClientNonce,
  loadRunHistoryMessages,
  loadRunTurnCheckpoint,
  parseComputerMode,
  RunHistoryWriteError,
  readRunTimingFields,
  recordLessonUse,
  recordUsage,
  settleReleasedTakeoverCards,
  teamChatRunFromOwner,
} from "@rakazo/db";
import { enrichLogContext, getLogger } from "@rakazo/logging";
import { formatAgentEnvironmentInstruction } from "./agent-environment.js";
import { createApprovedEffectReplayQueue, isToolPauseResult } from "./approval-effect.js";
import { automated, PARTIAL_REPLY_NOTE } from "./automated-messages.js";
import { backgroundHelpersAllowed } from "./background-helpers.js";
import { loadBotMessageContext } from "./bot-messages.js";
import {
  commandCredentialRedactions,
  loadBotCommandEnvironment,
  loadLoginPasswordRedactions,
  loadRunCodeRedactions,
  loadRunLoginRedactions,
} from "./bot-secrets.js";
import { createBrowserProvider } from "./browser-provider-factory.js";
import { partitionTools } from "./builtin-tool-bridge.js";
import { agentConnectionTools, builtinAgentTools } from "./builtin-tools.js";
import { cloudAgentsEnabled } from "./cloud-agent-factory.js";
import { mergeConnectedPlugins, needsLivePluginSync } from "./composio-connector.js";
import { diskNoteInstruction, recordComputerDisk } from "./computer-disk.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import {
  computerCheckpointResolver,
  isLostPinnedModel,
  PINNED_COMPUTER_MODEL_LOST_RUN_ERROR,
  resolveComputerRunModel,
} from "./computer-model-settings.js";
import { teamWorkspaceInstruction } from "./computer-support.js";
import { checkpointRunComputerWorkspace } from "./computer-workspace.js";
import {
  connectedContext,
  loadLivePluginSlugs,
  persistLivePluginConnections,
  selectRunConnections,
} from "./connection-context.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { createFileDeliveryJudge } from "./file-delivery-judge.js";
import type { FleetRun } from "./fleet-tools.js";
import { loadBotGroupDirectory, loadGroupContext } from "./group-handoff.js";
import { groupTurnBlocked, retryGroupTurnLater } from "./group-turn.js";
import {
  buildRecalledMemory,
  formatCompactedSummary,
  formatRecalledMemory,
  historyWindowSize,
  LEGACY_HISTORY_WINDOW_SIZE,
  selectCompactedHistory,
} from "./history-compaction.js";
import {
  historySpeaker,
  loadSpacePeople,
  loadThreadSpeakers,
  neutralizeSpeakerLabels,
  personSpeaker,
} from "./history-speakers.js";
import { buildLessonNotes } from "./lesson-notes.js";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { loadAgentMemoryContext } from "./memory-context.js";
import { resolveMemberMainModel, selectConfiguredModel } from "./model-roles.js";
import {
  findConnectedModelCredential,
  PINNED_PROVIDER_NOT_CONNECTED,
  pinnedModelCredentialError,
  runModelChoice,
} from "./model-selection.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { usesNativeShell } from "./native-shell.js";
import { createPaidServiceProvider } from "./paid-services-factory.js";
import { paymentWalletConnected } from "./payment-wallets.js";
import { restoreComputerModels } from "./pi-runtime-computer-mode.js";
import { loadPurchaseRedactions } from "./purchase-service.js";
import { loadReplyContext, messageToAgentHistoryText } from "./reply-context.js";
import { backOffRoutineAfterAccountError } from "./routine-backoff.js";
import { lateRoutineRunDueAt, lateRoutineRunInstruction } from "./routine-lateness.js";
import { lazyRunComputer } from "./run-computer.js";
import type {
  RunConfigurationManifestInput,
  RunConfigurationModel,
} from "./run-configuration-manifest.js";
import {
  persistRunConfigurationManifest,
  recordRunConfigurationModelChange,
} from "./run-configuration-manifest.js";
import type {
  RunComputerUseState,
  RunContext,
  RunLeaseState,
  RunningHelper,
  RunState,
} from "./run-context.js";
import { restoreTurnCheckpointEffects, settleRunningHelpers } from "./run-context.js";
import { APPROVED_EFFECT_REPLAY_ORDER, buildApprovalContinuation } from "./run-effects.js";
import {
  BOT_DIRECTORY_LIMIT,
  botEmailInstruction,
  dockerComputerToolInstruction,
  persistentComputerInstruction,
  runIdentityInstruction,
  threadContextForRun,
  userTurnInstructions,
  voiceCallInstruction,
} from "./run-instructions.js";
import {
  claimRun,
  createRunWorkspaceCheckpoint,
  failRunBeforeTurn,
  finishRunAttempt,
  mayOpenModelStream,
  renewRunLease,
  requeueComputerRun,
  requeueRunAfterShutdown,
  retryRunSetup,
  runEndedForThisWorker,
} from "./run-lifecycle.js";
import { withRunLease } from "./run-messages.js";
import {
  modelCreditBillingEnabled,
  resolveConnectedRunModel,
  resolvedModelRunFields,
  resolveRunModel,
  runtimeFallbackModel,
} from "./run-model.js";
import { runModelBackups, startRunModel } from "./run-model-start.js";
import { createReplyState } from "./run-progress.js";
import { observedMemorySources } from "./run-reflection.js";
import {
  DELEGATED_EMPTY_NOTICE,
  GROUP_UNADDRESSED_REPLY_GUIDANCE,
  runAllowsSilentEmpty,
  runReplyGuidance,
  runReplyMode,
} from "./run-replies.js";
import {
  notifyRoutineRetryAttemptsExhausted,
  retryRoutineRun,
  wakeRoutine,
} from "./run-routines.js";
import type { SkillComponentPhase } from "./run-skill-components.js";
import { runSkillComponents } from "./run-skill-components.js";
import type { RunStageRecallTrigger } from "./run-stage-recall.js";
import { createRunStageRecall } from "./run-stage-recall.js";
import {
  ensureRunTicketWorkState,
  runTicketProgressCheck,
  saveRunTicketPendingCall,
  ticketEnvironment,
} from "./run-ticket-state.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  followUpsOffered,
  offeredFleetTools,
  offersAgentConnectionTools,
  selectBuiltinToolsForRun,
} from "./run-tool-selection.js";
import { applyTool } from "./run-tools.js";
import {
  historyMyChatsAllowed,
  lessonRecallForRun,
  semanticRecallForRun,
} from "./run-tools-memory.js";
import type { UserComputerState } from "./run-tools-user-computer.js";
import { USER_COMPUTER_SHELL_TOOL, userComputerOwner } from "./run-tools-user-computer.js";
import { createRunTrustLoaders } from "./run-trust.js";
import { completeRun, consumeRunEvents, failRun, handoffEndedTurn } from "./run-turn.js";
import {
  claimRunSteering,
  loadCurrentTurnImages,
  missingTurnImagesInstruction,
  RECENT_TURN_IMAGE_TURNS,
  withRecentTurnImages,
} from "./run-turn-images.js";
import { loadAgentScratchpadContext } from "./scratchpad-context.js";
import { inferScript } from "./scripted-runtime.js";
import { loadSharedSpaceNote } from "./shared-space-note.js";
import { builtinAgentSkillRecords, listAgentSkillRecords } from "./skill-tools.js";
import {
  filterStrategicInitiativeTools,
  isStrategicInitiativeRun,
} from "./strategic-initiative.js";
import {
  refreshTakeoverContinuePlan,
  takeoverCheckpointOf,
  takeoverContinuePlan,
} from "./takeover-resume.js";
import { TASK_CATALOG_GUIDANCE } from "./task-catalog.js";
import type { TaughtSkillRevision } from "./taught-skill-revisions.js";
import {
  listPinnedTaughtSkillRevisions,
  pinTaughtSkillRevisionToRun,
} from "./taught-skill-revisions.js";
import { parsePlaybook } from "./teaching-session.js";
import {
  createEarlierFileQueue,
  currentTurnFilesInstruction,
  listCurrentTurnFiles,
  listRecentThreadFiles,
  materializeCurrentTurnFiles,
  materializeEarlierFiles,
  materializeRecentThreadFiles,
  recentThreadFilesInstruction,
} from "./thread-artifacts.js";
import { loadAgentTicketContext } from "./ticket-context.js";
import {
  createTicketFinalizationEvidence,
  ticketFinalizationEvents,
  ticketFinalizationRequest,
} from "./ticket-finalization.js";
import { TICKET_PROGRESS_REPLAN_NOTE } from "./ticket-progress.js";
import { createTicketProgressJudge } from "./ticket-progress-judge.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";
import { appendToolCompletionAudit, toolCompletionOutcome } from "./tool-completion-audit.js";
import { toolResultFingerprint } from "./tool-loop.js";
import { toolResultError } from "./tool-result-error.js";
import { restoreTurnCheckpoint } from "./turn-checkpoint.js";
import { createWebProvider } from "./web-provider-factory.js";

/** A helper asked for the bot's computer while another run held it: a tool error, not a run failure. */
export class ComputerBusyToolError extends Error {
  constructor() {
    super("The bot's computer is busy with another run right now. Please try again in a moment.");
    this.name = "ComputerBusyToolError";
  }
}

/** Same reach as the MCP connector: usable servers assigned to the bot or shared with every bot. */
async function verbatimMcpServersForRun(
  prisma: ExecutorDeps["prisma"],
  scope: { botId: string; spaceId: string; userId: string },
) {
  if (!prisma.mcpServer?.findMany) return undefined;
  const servers = await prisma.mcpServer.findMany({
    where: {
      verbatimResults: true,
      enabled: true,
      ...availableInSpace(scope),
      AND: [{ OR: [{ allBots: true }, { assignments: { some: { botId: scope.botId } } }] }],
    },
    select: { id: true, slug: true },
  });
  if (!servers?.length) return undefined;
  return { ids: servers.map((server) => server.id), slugs: servers.map((server) => server.slug) };
}

export function createRunExecutor(executorDeps: ExecutorDeps) {
  const contextStrategy = executorDeps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY;
  const web = executorDeps.web ?? createWebProvider();
  const mediaGeneration = executorDeps.mediaGeneration ?? createMediaGenerationProvider();
  const paidServices = executorDeps.paidServices ?? createPaidServiceProvider();
  const browser =
    executorDeps.browser ?? createBrowserProvider(undefined, { sandbox: executorDeps.sandbox });
  const cloudAgent = executorDeps.cloudAgent;
  const resolveConnectedModel = resolveConnectedRunModel.bind(undefined, executorDeps);

  // Run-scoped connector state (installed MCP sessions) outlives one attempt
  // but not its run, so the session side owns the lifetime: the connector ends
  // it when this worker observes the run's end, and bounds the rest itself.
  const endRunConnectorState = (runId: string) => executorDeps.connector?.endRun?.(runId);
  // Every terminal outcome funnels through finalizeRun — completion, failure,
  // the tool-loop stop and pre-turn failures — but only the attempt that still
  // owns the run finalizes it. A fenced-out attempt must not end the run's
  // state while a newer attempt of this run still needs it; whether it may end
  // it depends on the run row, not on this attempt. A rejected finalizeRun left
  // the run unfinished, so its state survives the retry.
  const events: ThreadEvents = {
    ...executorDeps.events,
    finalizeRun: async (input) => {
      const result = await executorDeps.events.finalizeRun(input);
      if (result || (await runEndedForThisWorker(executorDeps.prisma, input))) {
        endRunConnectorState(input.runId);
      }
      return result;
    },
  };
  const baseDeps: ExecutorDeps = { ...executorDeps, events };
  return {
    resolveConnectedModel,
    contextStrategy,
    resolveModel: resolveRunModel.bind(undefined, baseDeps),
    wakeRoutine: wakeRoutine.bind(undefined, baseDeps),
    notifyRoutineRetryAttemptsExhausted: notifyRoutineRetryAttemptsExhausted.bind(
      undefined,
      baseDeps,
    ),
    retryRoutineRun: retryRoutineRun.bind(undefined, baseDeps),

    async continueRun(runId: string, workerId: string, onRunStarted?: () => void) {
      let deps = baseDeps;
      // A stopping process must not claim work it cannot finish. The row stays
      // queued or expired for a worker that is still running.
      if (deps.shutdownSignal?.aborted) return;
      const run = await deps.prisma.run.findUnique({
        where: { id: runId },
        include: { routine: { select: { name: true } } },
      });
      if (!run) return;
      // Logs and security events raised by this run's tools name its account and space.
      enrichLogContext({
        "run.id": runId,
        "bot.id": run.botId,
        "thread.id": run.threadId,
        "space.id": run.spaceId,
        ...(run.userId ? { "user.id": run.userId } : {}),
      });
      if (isTerminal(run.status as RunStatus)) {
        // Finalized elsewhere (cancelled while waiting, another worker): this
        // worker's run-scoped state for it may end now; until a next touch, the
        // connector's own idle bound holds it.
        endRunConnectorState(runId);
        return;
      }
      // Every way work reaches a bot ends here, so a deactivated account's run stops before it starts.
      if (await accountDeactivated(deps.prisma, run.userId)) {
        // Nothing cancelled: the owner is back (or the run already ended), so carry on.
        if (await cancelDeactivatedAccountRuns(deps.prisma, deps.events, run.userId, runId)) return;
      }
      if (await cancelRunOfFormerMember(deps, run)) return;
      // Only members of this message wait: their history must include earlier speakers' replies.
      if (await groupTurnBlocked(deps.prisma, run)) {
        await retryGroupTurnLater(deps.jobs, run.id);
        return;
      }
      let { resumeCheckpoint, heldForTakeover, takeoverResume } = takeoverContinuePlan(run);

      const claimed = await claimRun(deps, run, workerId);
      if (!claimed) return;
      const { fence, current } = claimed;
      const leaseTarget = await deps.prisma.bot.findUniqueOrThrow({
        where: { id: run.botId },
        select: {
          computerId: true,
          computerSwitching: true,
          computer: { select: { scope: true } },
        },
      });
      if (!leaseTarget.computerId) throw new Error("Bot has no computer");
      const computerId = leaseTarget.computerId;
      // A helper holds the bot's computer only while it is actually using it: the lease, not
      // the chat, is what makes simultaneous work wait.
      if (run.trigger !== BACKGROUND_HELPER_TRIGGER && leaseTarget.computerSwitching) {
        await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, heldForTakeover);
        return;
      }
      if (takeoverResume) {
        try {
          await settleReleasedTakeoverCards(
            deps.prisma,
            {
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId,
              reason: takeoverResume.checkpoint,
              lease: { owner: workerId, fence },
            },
            (threadId, seq) => deps.events.notify(threadId, seq),
          );
        } catch (error) {
          // A newer claim owns the run and its takeover cards.
          if (error instanceof RunHistoryWriteError) return;
          throw error;
        }
      }
      let computerLease: ComputerExecutionLease | null = null;
      let deferComputerLease = run.trigger === BACKGROUND_HELPER_TRIGGER;
      // A helper takes the computer only when a tool first uses it (see getRunComputer); every
      // other run takes it before its first model call.
      if (run.trigger !== BACKGROUND_HELPER_TRIGGER) {
        try {
          computerLease = await acquireComputerExecutionLease(deps.prisma, {
            computerId: leaseTarget.computerId,
            runId,
            botId: run.botId,
            workerId,
            runFence: fence,
          });
          if (!computerLease && leaseTarget.computer?.scope === "dedicated") {
            computerLease = await acquireDedicatedScreenLeaseFence(deps.prisma, {
              computerId: leaseTarget.computerId,
              runId,
              botId: run.botId,
              workerId,
              runFence: fence,
            });
          }
        } catch (error) {
          if (!(error instanceof ComputerBusyError)) throw error;
          // Maintenance or suspension sends no release, so only a held lease waits for one.
          const heldByAnotherRun = await deps.prisma.computerExecutionLease.findFirst({
            where: {
              computerId: leaseTarget.computerId,
              botId: run.botId,
              runId: { not: runId },
              expiresAt: { gt: new Date() },
            },
            select: { id: true, runId: true },
          });
          const holder = heldByAnotherRun
            ? await deps.prisma.run.findUnique({
                where: { id: heldByAnotherRun.runId },
                select: { trigger: true },
              })
            : null;
          if (holder?.trigger === BACKGROUND_HELPER_TRIGGER) {
            // The helper owns the computer, not the conversation. Chat and memory can
            // proceed; a later computer tool must still acquire the same lease.
            deferComputerLease = true;
          } else {
            await requeueComputerRun(
              deps,
              runId,
              workerId,
              fence,
              resumeCheckpoint,
              heldForTakeover,
              Boolean(heldByAnotherRun),
            );
            return;
          }
        }
      }
      let attempt: { id: string };
      // Resumed attempts keep the first start, so lateness reflects when the run began.
      const executionStartedAt = current.startedAt ?? new Date();
      // Classified with the first start, so a retry, resume or later schedule edit keeps it.
      let firstLateSince: Date | undefined;
      if (!current.startedAt && run.trigger === "routine" && run.routineId && run.clientNonce) {
        try {
          const routine = await deps.prisma.routine.findUnique({
            where: { id: run.routineId },
            select: { crons: true, timezone: true },
          });
          if (routine) firstLateSince = lateRoutineRunDueAt(run, routine, executionStartedAt);
        } catch {
          // Lateness is optional context; a lookup failure must not prevent a run.
        }
      }
      try {
        // Acquiring the computer can requeue a busy run. Count that wait as queue
        // time, and only stamp execution once this attempt can use its computer.
        const executionStarted = await deps.prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
          data: { startedAt: executionStartedAt, lateSince: firstLateSince },
        });
        if (executionStarted.count !== 1) {
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
          return;
        }
        getLogger().info("run.execution_started", {
          ...(await readRunTimingFields(deps.prisma, runId)),
        });
        attempt = await deps.prisma.attempt.create({
          data: { runId, fence, status: "running" },
        });
      } catch (error) {
        await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
        throw error;
      }

      // A newer claim of this run now rejects this attempt's history writes.
      deps = withRunLease(deps, runId, { owner: workerId, fence });
      const lease: RunLeaseState = {
        valid: true,
        completed: false,
        lastCheckAt: 0,
        retainComputer: false,
      };
      const computerUse: RunComputerUseState = {
        reason: "none",
        tool: undefined,
        screenRelease: undefined,
      };
      let runAbortController: AbortController | null = null;
      const runningHelpers = new Map<string, RunningHelper>();
      const settleHelpers = () => settleRunningHelpers(deps, run, runningHelpers);

      let detachShutdown: (() => void) | undefined;
      const heartbeat = setInterval(() => {
        if (lease.completed) return;
        void Promise.all([
          renewRunLease(deps, runId, workerId, fence),
          renewComputerExecutionLease(deps.prisma, computerLease),
        ])
          .then(([runRenewed, computerRenewed]) => {
            if (lease.completed) return;
            if (!runRenewed || !computerRenewed) {
              lease.valid = false;
              runAbortController?.abort();
            }
          })
          .catch(() => {
            if (lease.completed) return;
            lease.valid = false;
            runAbortController?.abort();
          });
      }, 60_000);
      heartbeat.unref?.();
      const stopHeartbeatAfterCompletion = () => {
        lease.completed = true;
        clearInterval(heartbeat);
      };

      const runSecrets = [...deps.secrets];
      let dispatchHandedOff = false;
      try {
        // Durable run ownership and its heartbeat now carry recovery. Model,
        // integration and computer setup must not occupy a queue dispatch slot.
        onRunStarted?.();
        dispatchHandedOff = Boolean(onRunStarted);
        // A saved computer turn owns both identities. Resolve them before consulting
        // today's main selection, whose connection may have changed while paused.
        let turnCheckpoint: string | undefined;
        let checkpointLoadError: Error | undefined;
        try {
          turnCheckpoint = await loadRunTurnCheckpoint(deps.prisma, run);
        } catch (error) {
          checkpointLoadError =
            error instanceof Error ? error : new Error("Unsupported turn checkpoint");
        }
        const storedTurnCheckpoint = Boolean(turnCheckpoint);
        const resolveCheckpointModel = (
          provider: string,
          id: string,
          connectionId?: string,
          effort?: string,
        ) =>
          resolveConnectedModel(
            run,
            provider,
            id,
            (values) => runSecrets.push(...values),
            true,
            effort ?? null,
            connectionId,
          );
        const checkpointIdentity = { provider: run.modelProvider ?? "", id: run.modelId ?? "" };
        const checkpointModelResolver = computerCheckpointResolver(
          turnCheckpoint,
          checkpointIdentity,
          resolveCheckpointModel,
        );
        const savedComputerMode = checkpointModelResolver
          ? restoreTurnCheckpoint(turnCheckpoint!, checkpointIdentity).computerMode
          : undefined;
        let pinnedComputerModels: Awaited<ReturnType<typeof restoreComputerModels>> | undefined;
        let pinnedComputerFailure: string | undefined;
        if (savedComputerMode) {
          try {
            pinnedComputerModels = await restoreComputerModels(
              { resolveFallbackModel: checkpointModelResolver },
              savedComputerMode,
            );
          } catch (error) {
            // A paused turn whose model or account is gone cannot resume; retrying will not help.
            if (!isLostPinnedModel(error)) throw error;
            pinnedComputerFailure = PINNED_COMPUTER_MODEL_LOST_RUN_ERROR;
          }
        }
        const messagingSource =
          run.trigger === "messaging" && run.sourceMessageId
            ? await deps.prisma.message.findUnique({
                where: { id: run.sourceMessageId },
                select: { blocks: true, clientNonce: true },
              })
            : null;
        const sourceBlocks = messagingSource?.blocks as MessageBlock[] | undefined;
        const channelId = messagingChannelId(sourceBlocks);
        const messagingChannelRun = isMessagingChannelRun(run.trigger, sourceBlocks);
        const [
          bot,
          thread,
          messages,
          peerMessage,
          sourceMessage,
          task,
          storedConnections,
          main,
          settings,
          configuredMemory,
          savedSkills,
          agentSkills,
          initialBotCommandEnvironment,
          savedLoginPasswordRedactions,
          purchaseRedactions,
          runLoginRedactions,
          runCodeRedactions,
        ] = await Promise.all([
          deps.prisma.bot.findUniqueOrThrow({
            where: { id: run.botId },
            include: { computer: true },
          }),
          deps.prisma.thread.findUniqueOrThrow({
            where: { id: run.threadId },
            include: {
              space: { select: { _count: { select: { memberships: true } } } },
            },
          }),
          loadRunHistoryMessages(deps.prisma, run, LEGACY_HISTORY_WINDOW_SIZE, channelId),
          run.trigger === "bot_message"
            ? loadBotMessageContext(deps.prisma, run.sourceMessageId)
            : Promise.resolve(undefined),
          (run.trigger === "user" || run.trigger === "follow_up") && run.sourceMessageId
            ? deps.prisma.message.findUnique({
                where: { id: run.sourceMessageId, threadId: run.threadId },
                select: {
                  id: true,
                  clientNonce: true,
                  role: true,
                  authorUserId: true,
                  blocks: true,
                  threadId: true,
                },
              })
            : Promise.resolve(null),
          deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } }),
          deps.prisma.connection.findMany({
            where: { userId: run.userId, spaceId: run.spaceId },
            select: {
              id: true,
              connectorId: true,
              provider: true,
              providerRef: true,
              displayName: true,
              status: true,
            },
          }),
          pinnedComputerModels ? Promise.resolve(null) : resolveMemberMainModel(deps, run),
          deps.prisma.deploymentSettings.findUnique({
            where: { id: "default" },
          }),
          deps.memoryProviders.resolve(run.spaceId),
          deps.prisma.taughtSkill.findMany({
            where: { botId: run.botId, spaceId: run.spaceId, status: "saved" },
            // Newest first, so a long-lived bot's catalog favors what it learned recently.
            // No take: invokedSkill matches by name across every saved skill.
            orderBy: { updatedAt: "desc" },
          }),
          listAgentSkillRecords(deps.prisma, {
            spaceId: run.spaceId,
            userId: run.userId,
          }),
          loadBotCommandEnvironment(deps.prisma, deps.secretStore, run),
          loadLoginPasswordRedactions(deps.prisma, deps.secretStore, run),
          deps.paymentWallet ? loadPurchaseRedactions(deps, run) : [],
          loadRunLoginRedactions(deps.prisma, deps.secretStore, run, run.id),
          loadRunCodeRedactions(deps.prisma, deps.secretStore, run, run.id),
        ]);
        // Team chat reaches people besides the owner, so their runs get a group channel's limits.
        const teamChatConversationId =
          run.trigger === "messaging" ? thread.externalConversationId : null;
        const nonOwnerChatRun =
          messagingChannelRun ||
          (teamChatConversationId
            ? !(await teamChatRunFromOwner(deps.prisma, {
                externalConversationId: teamChatConversationId,
                sourceClientNonce: messagingSource?.clientNonce,
              }))
            : false);
        const historySearchBeforeSeq =
          contextStrategy !== "current" && run.sourceMessageId
            ? (messages.find((message) => message.id === run.sourceMessageId)?.seq ??
              (
                await deps.prisma.message.findUnique({
                  where: { id: run.sourceMessageId, threadId: thread.id },
                  select: { seq: true },
                })
              )?.seq ??
              thread.nextMessageSeq)
            : thread.nextMessageSeq;
        // Encoded forms too: read_file redacts with these values before any shell command runs.
        runSecrets.push(...commandCredentialRedactions(initialBotCommandEnvironment));
        // A login filled in an earlier run may still be on its page, and anything this run reads
        // or is given may contain it, so every run hides its saved passwords before the model runs.
        runSecrets.push(
          ...savedLoginPasswordRedactions,
          ...purchaseRedactions,
          ...runLoginRedactions,
          ...runCodeRedactions,
        );
        const agentEnvironmentInstruction = formatAgentEnvironmentInstruction(
          initialBotCommandEnvironment,
        );
        // modelPinned distinguishes the captured choice from an attempt's recorded model.
        const modelChoice = runModelChoice(run, bot);
        const hasModelOverride = Boolean(modelChoice.modelProvider && modelChoice.modelId);
        const overrideCredential =
          !pinnedComputerModels && hasModelOverride && modelChoice.modelProvider
            ? await findConnectedModelCredential(
                deps.prisma,
                deps.secretStore,
                run,
                modelChoice.modelProvider,
                modelChoice.modelId,
              )
            : null;
        runAbortController = new AbortController();
        if (!lease.valid) runAbortController.abort();
        if (deps.shutdownSignal?.aborted) runAbortController.abort(deps.shutdownSignal.reason);
        const onShutdown = () => runAbortController?.abort(deps.shutdownSignal?.reason);
        deps.shutdownSignal?.addEventListener("abort", onShutdown);
        detachShutdown = () => deps.shutdownSignal?.removeEventListener("abort", onShutdown);
        const composioRows = storedConnections.filter(
          (connection) => connection.connectorId === "composio",
        );
        let liveSlugs: string[] = [];
        if (needsLivePluginSync(composioRows)) {
          const listing = await loadLivePluginSlugs(deps.listConnectedPluginSlugs, run.userId);
          if (listing.ok) {
            liveSlugs = listing.slugs;
            await persistLivePluginConnections(deps.prisma, run, composioRows, listing.slugs).catch(
              () => undefined,
            );
          }
        }
        const connectedComposio = mergeConnectedPlugins(composioRows, liveSlugs);
        const connectedPlugins = selectRunConnections(
          storedConnections,
          connectedComposio.map((connection) => connection.provider),
        );
        const context = {
          operationId: runId,
          traceId: runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          runId,
          screenLeaseId: screenLeaseIdForRun(computerLease, runId, fence),
          signal: runAbortController.signal,
          ...connectedContext(connectedPlugins),
          connectedProviders: connectedComposio.map((row) => row.provider),
        };
        const memoryScope = configuredMemory
          ? effectiveMemoryScope(bot.memoryScope, configuredMemory.defaultScope)
          : null;
        const semanticMemory: SemanticMemoryProvider | null = configuredMemory?.provider ?? null;

        await deps.events.append({
          spaceId: run.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.started",
          runId,
          payload: {
            trigger: run.trigger,
            routineId: run.routineId,
            ...(run.routine ? { routineName: run.routine.name } : {}),
          },
        });

        const discoveredPromise = deps.connector
          ? deps.connector.discoverTools(context)
          : Promise.resolve([]);
        // Group threads and spaces several people share: who wrote each message, so the model can
        // tell the bots and the people apart. A personal space's direct chat stays plain turns.
        const people = await loadSpacePeople(
          deps.prisma,
          thread.space?._count.memberships ?? 0,
          run.userId,
          messages,
        );
        const speakers = await loadThreadSpeakers(
          deps.prisma,
          thread,
          { spaceId: run.spaceId, bot },
          messages,
          people,
        );
        const threadContext = threadContextForRun(
          run.trigger,
          {
            messages: [...messages].reverse().map((m) => {
              const speaker = historySpeaker(speakers, m);
              // In a group, turns from several speakers are joined, so no line may pose as a label.
              const text = speakers
                ? neutralizeSpeakerLabels(messageToAgentHistoryText(m))
                : messageToAgentHistoryText(m);
              return {
                id: m.id,
                createdAt: m.createdAt?.toISOString(),
                seq: m.seq,
                role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
                  | "user"
                  | "assistant"
                  | "system",
                ...(speaker ? { speaker } : {}),
                waiting: m.steeringMessages.length > 0,
                content: isPartialReplyClientNonce(m.clientNonce)
                  ? `${text}\n\n${PARTIAL_REPLY_NOTE}`
                  : text,
              };
            }),
            summary: thread.historyCompactionSummary,
            historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
          },
          nonOwnerChatRun,
          run.sourceMessageId,
        );
        const compactedHistory = selectCompactedHistory({
          messages: threadContext.messages,
          summary: threadContext.summary,
          historyCompactedUpToSeq: threadContext.historyCompactedUpToSeq,
        });
        let history = compactedHistory.history.map(({ id, role, content, createdAt, speaker }) => ({
          id,
          createdAt,
          role,
          content,
          ...(speaker ? { speaker } : {}),
        }));
        const historyMessages = messages
          .filter((message) => message.steeringMessages.length === 0)
          .map((message) => ({
            id: message.id,
            role: message.role,
            runId: message.runId,
            blocks: message.blocks as MessageBlock[],
          }));
        const currentTurnMessage = userTurnMessageForRun(
          run.trigger,
          runId,
          historyMessages,
          run.sourceMessageId,
        );
        const turnBlocks = currentTurnMessage?.blocks;
        // A run owns its source message and steering bound to it, including waiting-input
        // replies. message.runId alone is display linkage: a send during background work
        // points at that run but waits for its continuation. Read independently of history.
        const currentRunImageMessages = await deps.prisma.message.findMany({
          where: {
            threadId: thread.id,
            OR: [
              ...(run.sourceMessageId ? [{ id: run.sourceMessageId }] : []),
              { steeringMessages: { some: { runId, botId: run.botId } } },
            ],
            role: "user",
            blocks: { array_contains: [{ kind: "image" }] },
          },
          select: { id: true, blocks: true },
          orderBy: { seq: "asc" },
        });
        // The content extension decrypts imageHandling after filtering on plain kind.
        const confirmedRunImages = currentRunImageMessages.flatMap((message) =>
          (message.blocks as MessageBlock[]).filter(
            (block) => block.kind === "image" && block.imageHandling === "confirm",
          ),
        );
        const currentRunRequiresImageInput = confirmedRunImages.length > 0;
        // The send decided whether the message named this member; one it named nobody for
        // reached every member, and each may end its turn without a reply.
        const groupReplyOptional =
          Boolean(thread.groupId) && run.trigger === "user" && run.groupReplyOptional;
        const allowSilentPeerMessage = botMessageAllowsSilence(
          peerMessage?.intent,
          peerMessage?.repliesToRequest,
        );
        const allowSilentEmptyRun =
          allowSilentPeerMessage || messagingChannelRun || runAllowsSilentEmpty(run.trigger);
        const emptyResponseText = peerMessage
          ? peerMessage.intent === "result" ||
            peerMessage.intent === "status" ||
            peerMessage.intent === "question" ||
            peerMessage.repliesToRequest
            ? `Update from ${peerMessage.fromBotName}: ${peerMessage.text}`
            : DELEGATED_EMPTY_NOTICE
          : undefined;
        const sourceHistoryIndex = messages.findIndex(
          (message) => message.id === run.sourceMessageId,
        );
        const previousUserMessages =
          sourceHistoryIndex < 0
            ? []
            : messages
                .slice(sourceHistoryIndex + 1)
                .filter((message) => message.steeringMessages.length === 0);
        const externalRecall = nonOwnerChatRun || Boolean(thread.externalConversationId);
        const recallPromise = semanticRecallForRun(
          {
            provider: semanticMemory,
            scope: memoryScope,
            botId: bot.id,
            run,
            sourceMessage,
            previousMessages: previousUserMessages,
            external: externalRecall,
            includeSemanticRecall: threadContext.includeSemanticRecall,
            prompt: task.prompt,
            historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
            historyGeneration: thread.historyCompactionGeneration,
            secrets: runSecrets,
          },
          context,
        );
        // Lessons recall alongside facts, with their own namespace and query.
        const lessonRecallPromise = lessonRecallForRun(
          {
            provider: semanticMemory,
            botId: bot.id,
            run,
            sourceMessage,
            previousMessages: previousUserMessages,
            external: externalRecall,
            prompt: task.prompt,
            secrets: runSecrets,
          },
          context,
        );
        const [
          discovered,
          currentTurnImages,
          memoryContext,
          scratchpadContext,
          ticketContext,
          automaticRecall,
          lessonRecall,
        ] = await Promise.all([
          discoveredPromise,
          loadCurrentTurnImages(deps, turnBlocks, context),
          nonOwnerChatRun
            ? Promise.resolve("")
            : loadAgentMemoryContext(deps.memory, bot.id, context),
          nonOwnerChatRun
            ? Promise.resolve("")
            : loadAgentScratchpadContext(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
              }),
          nonOwnerChatRun || !deps.ticketBoardEnabled
            ? Promise.resolve(undefined)
            : loadAgentTicketContext(deps, {
                spaceId: run.spaceId,
                text: task.prompt,
                ticketId: run.ticketId,
                ...(run.ticketId && ticketReceiptsEnabled()
                  ? {
                      workState: {
                        runId,
                        userId: run.userId,
                        botId: bot.id,
                        environment: ticketEnvironment(bot.computer, deps.runtime.describe()),
                      },
                    }
                  : {}),
                ...(run.trigger === "user" &&
                sourceMessage?.authorUserId === run.userId &&
                !channelId &&
                !thread.externalConversationId
                  ? {
                      origin: {
                        threadId: thread.id,
                        userId: run.userId,
                        botId: bot.id,
                        messageId: run.sourceMessageId,
                      },
                    }
                  : {}),
              }),
          recallPromise,
          lessonRecallPromise,
        ]);
        const semanticMemoryEnabled = Boolean(semanticMemory) && !nonOwnerChatRun;
        const recalled = automaticRecall.response;
        if (recalled && !recalled.ok) {
          getLogger().error(
            "semantic memory recall failed",
            sanitizeConnectorError(recalled.error, runSecrets),
          );
        }
        if (lessonRecall && !lessonRecall.ok) {
          getLogger().error(
            "lesson recall failed",
            sanitizeConnectorError(lessonRecall.error, runSecrets),
          );
        }
        // Early durable recall is not evidence that a legacy thread's missing history is covered.
        // Only its existing compacted-recall path can select the smaller fallback window.
        if (!compactedHistory.usedLocalSummary) {
          history = history.slice(
            -historyWindowSize({
              semanticMemoryEnabled: semanticMemoryEnabled && !thread.historyCompactionSummary,
              compacted: thread.historyCompactedUpToSeq != null,
              recallSucceeded:
                automaticRecall.origin === "compacted" &&
                Boolean(recalled?.ok && formatRecalledMemory(recalled.value, runSecrets)),
            }),
          );
        }
        const runDeployment = deps.deploymentModelConfigured ? resolveDeploymentModel() : null;
        const runtimeFallback = runtimeFallbackModel(deps.runtime);
        // A model the deployment itself serves needs no user connection: its own model
        // (deployment key or host credentials) and the eval runtime's scripted model resolve
        // without one. A pin must not demand a connection the unpinned path never needs.
        const deploymentServesModel =
          modelChoice.modelProvider === runDeployment?.provider ||
          modelChoice.modelProvider === runtimeFallback?.provider;
        const pinError =
          !pinnedComputerModels && run.modelPinned && !deploymentServesModel
            ? pinnedModelCredentialError(modelChoice, overrideCredential)
            : undefined;
        const selected = pinnedComputerModels
          ? {
              provider: pinnedComputerModels.main.provider,
              id: pinnedComputerModels.main.id,
              thinkingLevel: pinnedComputerModels.main.thinkingLevel,
              credential: null,
            }
          : selectConfiguredModel({
              override: modelChoice,
              overrideCredential,
              main,
              hostedProvider: (await modelCreditBillingEnabled(deps))
                ? resolveDeploymentModel().provider
                : undefined,
              defaults: { settings, deployment: runDeployment },
            });
        const selectedProvider = selected.provider ?? runtimeFallback?.provider;
        const selectedModelId = selected.id ?? runtimeFallback?.id;
        // A missing or refused connection of the user's own fails every scheduled run alike.
        const failRunBeforeModel = async (message: string, accountFailure = false) => {
          const failed = await failRunBeforeTurn(
            deps,
            run,
            bot.name,
            { attemptId: attempt.id, workerId, fence },
            message,
          );
          if (failed && accountFailure && run.trigger === "routine" && run.routineId) {
            await backOffRoutineAfterAccountError(deps, {
              routineId: run.routineId,
              userId: run.userId,
            });
          }
        };
        if (pinnedComputerFailure) {
          await failRunBeforeModel(pinnedComputerFailure, true);
          return;
        }
        if (pinError) {
          await failRunBeforeModel(pinError, pinError === PINNED_PROVIDER_NOT_CONNECTED);
          return;
        }
        if (
          !pinnedComputerModels &&
          run.modelPinned &&
          (selectedProvider !== modelChoice.modelProvider ||
            selectedModelId !== modelChoice.modelId)
        ) {
          await failRunBeforeModel(PINNED_PROVIDER_NOT_CONNECTED, true);
          return;
        }
        const scripted = deps.runtime.describe().capabilities.scripted;
        const registerRunSecrets = (values: string[]) => runSecrets.push(...values);
        const backups = runModelBackups(
          deps,
          run,
          { settings, deployment: runDeployment },
          scripted,
          registerRunSecrets,
        );
        const started = await startRunModel(
          deps,
          run,
          {
            provider: selectedProvider,
            id: selectedModelId,
            credential: selected.credential,
            thinkingLevel: selected.thinkingLevel,
          },
          pinnedComputerModels?.main,
          backups,
          registerRunSecrets,
        );
        if (started.failure) {
          await failRunBeforeModel(started.failure.message, started.failure.accountFailure);
          return;
        }
        const {
          provider: runModelProvider,
          id: runModelId,
          credential,
          thinkingLevel,
          resolved,
        } = started.start;
        runSecrets.push(...resolved.redact);
        // A pin stays as it was created. Unpinned runs still record the model they
        // used; modelPinned is what keeps that record from becoming the next choice.
        if (!run.modelPinned) {
          await deps.prisma.run.updateMany({
            where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
            data: { modelProvider: runModelProvider, modelId: runModelId },
          });
        }

        if (!bot.computer) throw new Error("Bot has no computer");
        const storedComputer = bot.computer;
        const computerMode = parseComputerMode(storedComputer.scope);
        const artifacts = deps.artifacts;
        const recentFilesInput = {
          context,
          computerMode,
          skipMessageId: currentTurnMessage?.id,
          maxTurns: RECENT_TURN_IMAGE_TURNS,
        };
        // Files from earlier messages that history tools surfaced this run.
        const earlierFiles = createEarlierFileQueue();
        const runComputer = lazyRunComputer(
          async () => {
            getLogger().info("computer.requested");
            const computer = await provisionComputer(deps, storedComputer.id, context, "bot");
            earlierFiles.computerStarted();
            computerUse.screenRelease = { computer, context, keepWarm: false };
            recordComputerDisk(deps, storedComputer.id, computer, context);
            scheduleComputerSleep(deps.jobs, storedComputer.id);
            // Earlier attachments wait for the computer's first use; every start copies them
            // again, so they need no checkpoint, and each copy logs and skips its own failure.
            if (artifacts) {
              await materializeRecentThreadFiles({ ...deps, artifacts }, history, historyMessages, {
                ...recentFilesInput,
                computer: async () => computer,
              });
            }
            return computer;
          },
          () => runAbortController?.abort(),
        );
        const computerKind =
          (await deps.sandbox.provisionKind?.(storedComputer.homeKey)) ?? storedComputer.kind;
        const workspaceCheckpoint = createRunWorkspaceCheckpoint(
          async () => {
            if (!runComputer.ready) return;
            await checkpointRunComputerWorkspace(deps, storedComputer, runComputer.ready, context);
          },
          { id: storedComputer.id, kind: computerKind },
          context.signal,
        );
        const pendingTurnFiles: MessageBlock[][] = [turnBlocks ?? []];
        let copyingTurnFiles = Promise.resolve();
        // Serialize copies before each tool, including attachments received while a boot is in flight.
        let computerLeaseSettled = false;
        const getRunComputer = async (reason: "tool" | "takeover" | "script", tool?: string) => {
          if (computerUse.reason === "none") {
            computerUse.reason = reason;
            computerUse.tool = tool && BUILTIN_AGENT_TOOL_NAMES.has(tool) ? tool : undefined;
          }
          return getLogger().withContext(
            {
              reason: computerUse.reason,
              tool: computerUse.tool,
              trigger: run.trigger,
              "run.id": runId,
              "computer.id": storedComputer.id,
            },
            async () => {
              // Deferred runs acquire the computer only when a tool actually uses it.
              if (deferComputerLease && !computerLeaseSettled) {
                if (leaseTarget.computerSwitching) throw new ComputerBusyToolError();
                try {
                  computerLease = await acquireComputerExecutionLease(deps.prisma, {
                    computerId,
                    runId,
                    botId: run.botId,
                    workerId,
                    runFence: fence,
                  });
                  if (!computerLease && leaseTarget.computer?.scope === "dedicated") {
                    computerLease = await acquireDedicatedScreenLeaseFence(deps.prisma, {
                      computerId,
                      runId,
                      botId: run.botId,
                      workerId,
                      runFence: fence,
                    });
                  }
                } catch (error) {
                  if (!(error instanceof ComputerBusyError)) throw error;
                  throw new ComputerBusyToolError();
                }
                computerLeaseSettled = true;
                if (computerLease) {
                  context.screenLeaseId = screenLeaseIdForRun(computerLease, runId, fence);
                }
              }
              const computer = await runComputer.get();
              copyingTurnFiles = copyingTurnFiles
                .catch(() => undefined)
                .then(async () => {
                  while (artifacts && pendingTurnFiles.length) {
                    const files = await materializeCurrentTurnFiles(
                      { ...deps, artifacts },
                      pendingTurnFiles[0],
                      {
                        context,
                        computer: async () => computer,
                        computerMode,
                        markWorkspaceDirty: workspaceCheckpoint.markDirty,
                      },
                    );
                    workspaceCheckpoint.markFiles(files);
                    pendingTurnFiles.shift();
                  }
                  const earlier = earlierFiles.take();
                  if (artifacts && earlier.length) {
                    earlierFiles.copiedTo(
                      earlier,
                      // Saved with the run's checkpoint, so a resumed attempt still has them.
                      await materializeEarlierFiles({ ...deps, artifacts }, earlier, {
                        context,
                        computer: async () => computer,
                        computerMode,
                        markWorkspaceDirty: workspaceCheckpoint.markDirty,
                      }),
                    );
                  }
                });
              await copyingTurnFiles;
              return computer;
            },
          );
        };
        let currentTurnFiles: Awaited<ReturnType<typeof listCurrentTurnFiles>> = [];
        let recentThreadFiles: Awaited<ReturnType<typeof listRecentThreadFiles>> = [];
        try {
          if (artifacts) {
            currentTurnFiles = await listCurrentTurnFiles(deps, turnBlocks, context);
            recentThreadFiles = await listRecentThreadFiles(
              deps,
              history,
              historyMessages,
              recentFilesInput,
            );
          }
        } catch (error) {
          await workspaceCheckpoint.flush().catch(() => undefined);
          throw error;
        }
        const attachedFilesPrompt = [
          currentTurnFilesInstruction(currentTurnFiles),
          recentThreadFilesInstruction(recentThreadFiles),
        ]
          .filter(Boolean)
          .join("\n\n");
        const graphical =
          computerKind !== "desktop" && deps.sandbox.describe().capabilities.graphical;
        // Gate on the pair written to the run row above; re-deriving it would drop the
        // deployment fallback and gate a vision-capable default as text-only.
        const modelSeesImages = modelAcceptsImageInput(
          runModelProvider,
          runModelId,
          resolved.acceptsImages,
        );

        const groupContext = thread.groupId
          ? await loadGroupContext(
              deps.prisma,
              thread.groupId,
              { id: bot.id, name: bot.name },
              Boolean(people),
            )
          : undefined;
        const hasMessagingIdentity = deps.messaging
          ? await deps.messaging.hasIdentity(bot.id)
          : false;
        const paymentWallet = deps.paymentWallet;
        const paymentWalletEnabled = paymentWallet
          ? await paymentWalletConnected(
              { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet },
              run.userId,
            )
          : false;
        const messagingContext =
          [
            hasMessagingIdentity ? messagingDmSurfaceNote() : null,
            messagingChannelRun
              ? messagingChannelPrivacyBlock()
              : nonOwnerChatRun
                ? nonOwnerChatPrivacyBlock()
                : null,
          ]
            .filter(Boolean)
            .join("\n\n") || undefined;
        if (heldForTakeover) {
          const held = await deps.prisma.run.findUnique({
            where: { id: runId },
            select: { status: true, checkpoint: true },
          });
          if (held) {
            ({ resumeCheckpoint, heldForTakeover, takeoverResume } = refreshTakeoverContinuePlan(
              { resumeCheckpoint, heldForTakeover, takeoverResume },
              held,
            ));
          }
        }
        const mainRunModel: AgentRunRequest["model"] = pinnedComputerModels?.main ?? {
          provider: runModelProvider,
          id: runModelId,
          ...(credential ? { connectionId: credential.id } : {}),
          ...resolvedModelRunFields(resolved),
          thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
        };
        if (
          !scripted &&
          !nonOwnerChatRun &&
          deps.ticketBoardEnabled &&
          ticketReceiptsEnabled() &&
          !deps.fileDeliveryJudge
        ) {
          deps = {
            ...deps,
            fileDeliveryJudge: createFileDeliveryJudge({
              runtime: deps.runtime,
              model: mainRunModel,
              budget: { maxTotalTokens: 64_000, timeoutMs: 120_000 },
              onUsage: (event, judgeContext) =>
                recordUsage(deps.prisma, event, {
                  spaceId: run.spaceId,
                  userId: run.userId,
                  botId: bot.id,
                  runId,
                  parentRunId: runId,
                  operationKind: "setup",
                  operationId: judgeContext.operationId,
                }),
            }),
          };
        }
        // Saved identities win on resume, including when the setting was cleared meanwhile.
        const computerModel =
          pinnedComputerModels?.computer ??
          // A paused turn resumes with the models it started with, even one saved before this setting.
          (scripted || storedTurnCheckpoint || !graphical
            ? undefined
            : await resolveComputerRunModel(
                {
                  prisma: deps.prisma,
                  resolve: resolveCheckpointModel,
                  connectionFor: async (provider, modelId) =>
                    (
                      await findConnectedModelCredential(
                        deps.prisma,
                        deps.secretStore,
                        run,
                        provider,
                        modelId,
                      )
                    )?.id,
                },
                { userId: run.userId, spaceId: run.spaceId },
                mainRunModel,
              ));
        // Calls carry no schema flag: the sending client encodes them in the clientNonce.
        const sourceClientNonce = sourceMessage?.clientNonce ?? null;
        // A follow-up can be queued by a bot (group handoffs); only the user's own counts.
        const ownerStartedRun = isOwnerStartedRun(run.trigger, sourceMessage?.role === "user");
        // A hang-up run has no source message: its own nonce carries the call it closes.
        const callEndRun = run.trigger === "call_end";
        const callClientNonceForRun = callEndRun ? run.clientNonce : sourceClientNonce;
        const voiceCall = callEndRun || isCallClientNonce(sourceClientNonce);
        const acceptsImages =
          deps.runtime.describe().capabilities.scripted ||
          modelSeesImages ||
          Boolean(computerModel || checkpointModelResolver);
        const graphicalToolsAllowed = graphical && acceptsImages && !heldForTakeover;
        const browserCapabilities = browser.describe().capabilities;
        const pageBrowserAllowed =
          browserCapabilities.page &&
          (graphical || browserCapabilities.requiresGraphicalComputer === false) &&
          !heldForTakeover;
        const disabledBuiltinTools = disabledBuiltinToolSet(bot.disabledBuiltinTools);
        const replyMode = runReplyMode(run.trigger, bot.replyMode, disabledBuiltinTools);
        const emailName = deps.inboundEmailDomain
          ? await deps.prisma.botEmailAddress.findUnique({
              where: { botId: bot.id },
              select: { name: true },
            })
          : null;
        const botEmail = emailName ? `${emailName.name}@${deps.inboundEmailDomain}` : null;
        // The inbox is the owner's mail: read only in their own runs, never in a group or channel, and
        // never for another bot, which may be answering someone else.
        const emailInbox =
          Boolean(botEmail) &&
          run.userId === bot.userId &&
          run.trigger !== "bot_message" &&
          !thread.groupId &&
          !nonOwnerChatRun;
        const userComputerOwnerId = userComputerOwner({
          trigger: run.trigger,
          sourceRole: sourceMessage?.role,
          messagingChannelRun: nonOwnerChatRun,
          runUserId: run.userId,
          botUserId: bot.userId,
        });
        let userComputer: UserComputerState;
        let userComputerShell = false;
        let userComputerScreen = false;
        if (
          userComputerOwnerId &&
          deps.userDevices &&
          !disabledBuiltinTools.has(USER_COMPUTER_SHELL_TOOL)
        ) {
          const device = await deps.userDevices.connected(userComputerOwnerId).catch(() => null);
          if (device) {
            userComputer = "connected";
            userComputerShell = !device.screenOnly;
            // The macOS and Windows desktops fetch a screen driver; Linux has none yet.
            userComputerScreen = device.platform === "darwin" || device.platform === "win32";
          } else userComputer = "offline";
        }
        const builtins = [
          ...selectBuiltinToolsForRun({
            ticketBoardEnabled: deps.ticketBoardEnabled,
            // A call rings the bot's own person, whose chat it is; other members of a shared
            // Space reach it by message for now.
            phoneCallsEnabled: deps.phoneCallsEnabled && run.userId === bot.userId,
            historyRetrievalEnabled: contextStrategy !== "current",
            graphicalToolsAllowed,
            pageBrowserAllowed,
            groupId: thread.groupId,
            trigger: run.trigger,
            semanticMemoryEnabled,
            semanticMemoryForgets: Boolean(
              semanticMemory?.forget &&
                semanticMemory.describe().capabilities.managedFacts === true,
            ),
            mediaImagesEnabled: Boolean(deps.artifacts && mediaGeneration?.capabilities.images),
            mediaVideoEnabled: Boolean(deps.artifacts && mediaGeneration?.capabilities.video),
            paidServicesEnabled: Boolean(paidServices),
            cloudAgentEnabled: cloudAgentsEnabled(cloudAgent, run.spaceId),
            paymentWalletEnabled,
            messagingChannelRun: nonOwnerChatRun,
            voiceCall,
            // Every member already got a message that names nobody, so a handoff only repeats it.
            disabledBuiltinTools: groupReplyOptional
              ? [...(bot.disabledBuiltinTools ?? []), "handoff_to_bot"]
              : bot.disabledBuiltinTools,
            fleetManagement: bot.fleetManagement,
            followUpFromUser: sourceMessage?.role === "user",
            userComputer: userComputerShell,
            userComputerScreen,
            emailInbox,
            emailClaimable:
              Boolean(deps.inboundEmailDomain) && !emailName && run.userId === bot.userId,
            emailSend: Boolean(deps.email),
          }),
          // Cross-owner agent connections only exist for chat-linked bots. The chat link is its
          // creator's, and a connected agent's messages run as them, so only their runs may
          // open, approve or use one.
          ...(run.userId === bot.userId &&
          offersAgentConnectionTools({
            hasMessagingIdentity,
            crossSpaceCommunication: bot.crossSpaceCommunication === true,
            trigger: run.trigger,
          })
            ? agentConnectionTools.filter((tool) => !disabledBuiltinTools.has(tool.name))
            : []),
        ];
        const strategicBuiltins = filterStrategicInitiativeTools(builtins, {
          trigger: run.trigger,
          clientNonce: run.clientNonce,
        });
        const exposedConnectorTools = discovered.filter(
          (tool) => !builtinAgentTools.some((builtin) => builtin.name === tool.name),
        );
        const strategicConnectorTools = filterStrategicInitiativeTools(exposedConnectorTools, {
          trigger: run.trigger,
          clientNonce: run.clientNonce,
        });
        const connectorTools = new Map(
          strategicConnectorTools.map((tool) => [tool.name, tool] as const),
        );
        const trustLoaders = createRunTrustLoaders(deps, {
          run,
          runId,
          botId: bot.id,
          taskPrompt: task.prompt,
          ownerStartedRun,
          messagingChannelRun: nonOwnerChatRun,
          sourceMessage,
          connectedPlugins,
        });
        // Outbound destinations this run may reach without asking. See outboundSiteGate and
        // connectorReadRequiresApproval; approvals from earlier attempts are read back from effects.
        const searchResultUrls = new Set<string>();
        const initiallyTainted =
          !ownerStartedRun || Boolean(turnCheckpoint) || Boolean(checkpointLoadError);
        // The creation intro only asks what the bot is for (see selectBuiltinToolsForRun),
        // so it gets no connector tools either.
        const tools =
          run.trigger === "created"
            ? strategicBuiltins
            : [...strategicBuiltins, ...strategicConnectorTools];
        const taskCatalogInstruction = tools.some((tool) => tool.name === "task_catalog")
          ? TASK_CATALOG_GUIDANCE
          : undefined;
        const approvedEffects = await deps.prisma.externalEffect.findMany({
          where: { runId, status: "approved" },
          orderBy: APPROVED_EFFECT_REPLAY_ORDER,
          select: { kind: true, request: true, idempotencyKey: true },
        });
        const approvedEffectReplays = createApprovedEffectReplayQueue(approvedEffects);
        const baseComputerInstruction = persistentComputerInstruction({
          heldForTakeover,
          graphicalToolsAllowed,
          graphical,
          disabled: disabledBuiltinTools,
        });
        const dockerToolInstruction = dockerComputerToolInstruction(
          computerKind,
          disabledBuiltinTools,
          new Set(tools.map((tool) => tool.name)),
        );
        const hostEnvironment =
          computerKind && usesNativeShell(computerKind)
            ? await deps.sandbox
                .environment?.(
                  {
                    id: storedComputer.providerRef ?? storedComputer.id,
                    botId: storedComputer.homeKey,
                    kind: computerKind as ComputerRef["kind"],
                    providerRef: storedComputer.providerRef ?? "",
                  },
                  {
                    ...context,
                    signal: AbortSignal.any([context.signal, AbortSignal.timeout(2000)]),
                  },
                )
                .catch(() => undefined)
            : undefined;
        const hostShell = hostEnvironment
          ? `Home: ${JSON.stringify(hostEnvironment.home)}. Shell: ${JSON.stringify(hostEnvironment.shell)}. The shell tool executes commands with that shell. Use its native syntax, paths and installed tools; do not assume Linux or bash.`
          : undefined;
        const hostInstruction = !hostEnvironment
          ? undefined
          : computerKind === "wuying"
            ? `Commands run on a Windows cloud computer. ${hostShell} Files outside the bot workspace can be accessed through commands. The screen shows the Windows desktop; use the graphical tools for apps without a command line.`
            : `Commands run on the user's ${hostEnvironment.platform} computer with their account permissions. ${hostShell} Local files outside the bot workspace can be accessed through commands. App launching is available through OS commands; graphical screen control is unavailable.`;
        const hostBrowserInstruction =
          computerKind === "desktop" &&
          pageBrowserAllowed &&
          browserCapabilities.requiresGraphicalComputer === false
            ? "The page browser is available through browser_navigate, browser_snapshot, and browser_act, even though pixel-based desktop control is unavailable. Use those tools for webpage actions. Keep the task page open for the user; stop when they take control. Download results identify files saved in this bot's Downloads folder or report a save error; do not repeat a click just because navigation was interrupted by a download. Set waitForDownload only for an intended download. When a snapshot returns pages, select the desired pageId in browser_snapshot before acting there. Use protected-fill tools only with their saved credential and observed page binding; if the browser refuses the field, ask the user to complete it."
            : computerKind === "desktop" && hostEnvironment?.platform === "darwin"
              ? "Use the user's configured browser to open web pages. This run has no page-control tools; do not claim you can click or fill a page."
              : undefined;
        const browserApprovalInstruction =
          pageBrowserAllowed && browserCapabilities.requiresActionApproval
            ? "Page actions follow the user's Ask/Auto/Never approval policy. Purchases keep their explicit confirmation requirement. A rejected action stays rejected; do not switch to the shell or another tool to bypass it."
            : undefined;
        const computerInstruction = [
          "Use the computer only when the task needs files, commands, a browser, or an installed application. Answer directly from the conversation when sufficient; use connected tools for app data. A website with no connected app is still yours to use in the computer's browser, now and in scheduled routines, so a missing connection alone is never a reason to decline. Do not inspect the computer just to prepare for an unrelated task. If what you are about to buy, send or submit differs from what the user confirmed, such as a changed item or total, show the difference and confirm again first.",
          hostInstruction
            ? `${baseComputerInstruction} ${hostInstruction}`
            : dockerToolInstruction
              ? `${baseComputerInstruction} ${dockerToolInstruction}`
              : baseComputerInstruction,
          hostBrowserInstruction,
          browserApprovalInstruction,
          diskNoteInstruction(storedComputer),
        ]
          .filter(Boolean)
          .join(" ");
        const workspaceInstruction =
          computerMode === "team"
            ? teamWorkspaceInstruction(bot.id)
            : "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.";

        const reply = await createReplyState(deps, run, runSecrets);
        const script = scripted ? inferScript(task.prompt, takeoverResume?.checkpoint) : undefined;
        const state: RunState = {
          lease,
          computerUse,
          runningHelpers,
          reply,
          approval: { pausePending: false, request: undefined },
          effects: {
            counts: new Map(),
            occurrences: [],
            restoredPending: undefined,
            consumedIds: new Set(),
            pendingTurnCheckpoints: new Map(),
            storedTurnCheckpoint,
          },
          screen: { lastFrameId: undefined, unchangedVisualStreak: { count: 0 } },
          toolCallStreak: { key: undefined, count: 0 },
          overLimitActionCalls: 0,
          steeringClaimed: 0,
          toolLoopStopped: false,
          toolResults: new Map(),
          tainted: initiallyTainted,
          ownerSettingsRefused: false,
          // A resumed turn replaces this with the baseline its saved prompt was built from.
          ownInstructionsBaseline: bot.instructions ?? "",
          earlierAttempt: undefined,
          walletHosts: new Set(),
          handedOff: false,
          terminalCheckpointComplete: false,
        };
        const { effects } = state;
        /** Fleet tools take every scope from the run, never from arguments. */
        const fleetRun: FleetRun = {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? null,
          threadId: thread.id,
          runId,
        };

        const ctx: RunContext = {
          model: {
            provider: runModelProvider,
            id: runModelId,
            thinkingLevel: mainRunModel.thinkingLevel ?? null,
          },
          deps,
          providers: { web, mediaGeneration, paidServices, browser, cloudAgent },
          run,
          runId,
          workerId,
          fence,
          attempt,
          bot,
          thread,
          task,
          context,
          abortController: runAbortController,
          runtimeAbortController: new AbortController(),
          fleetRun,
          secrets: runSecrets,
          source: {
            ownerStartedRun,
            ownerAuthoredRun:
              ownerStartedRun && sourceMessage?.authorUserId === run.userId && !nonOwnerChatRun,
            messagingChannelRun: nonOwnerChatRun,
            channelId,
            historySearchBeforeSeq,
            myChatsAllowed: historyMyChatsAllowed(
              run,
              sourceMessage,
              nonOwnerChatRun ||
                Boolean(
                  channelId ||
                    thread.externalConversationId ||
                    messagingChannelId(sourceMessage?.blocks as MessageBlock[] | undefined),
                ),
            ),
            voiceCall,
            callEndRun,
            callClientNonce: callClientNonceForRun,
            peerMessage,
            userComputerOwner: userComputerOwnerId,
          },
          computer: {
            stored: storedComputer,
            kind: computerKind,
            mode: computerMode,
            get lease() {
              return computerLease;
            },
            lazy: runComputer,
            get: getRunComputer,
            copyEarlierFiles: earlierFiles.add,
            checkpoint: workspaceCheckpoint,
            hostEnvironment,
            graphical,
            graphicalToolsAllowed,
            pageBrowserAllowed,
            acceptsImages,
            heldForTakeover,
          },
          tools: {
            offered: tools,
            builtins: strategicBuiltins,
            connector: connectorTools,
            disabled: disabledBuiltinTools,
            connectedPlugins,
            approvedReplays: approvedEffectReplays,
          },
          trust: { ...trustLoaders, searchResultUrls },
          memory: { semantic: semanticMemory, scope: memoryScope },
          scripted,
          script,
          allowSilentEmptyRun,
          groupReplyOptional,
          emptyResponseText,
          replyMode,
          state,
          settleRunningHelpers: settleHelpers,
          stopHeartbeatAfterCompletion,
        };
        if (fence > 1 && semanticMemory && !nonOwnerChatRun) {
          try {
            const recovered = await observedMemorySources(deps.prisma, run, context.signal);
            ctx.memory.observedFacts = recovered.sources;
            ctx.memory.recoveryUnavailable = !recovered.complete;
          } catch {
            ctx.memory.recoveryUnavailable = true;
            getLogger().warn("run memory sources unavailable", { "run.id": runId });
          }
        }
        const pluginLine =
          connectedPlugins.length > 0
            ? `Connected plugins: ${connectedPlugins.map((row) => `${row.displayName} (${row.connectorId}:${row.provider})`).join(", ")}. Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).`
            : "No plugins are connected yet.";
        const runSavedSkills = nonOwnerChatRun ? [] : savedSkills;
        const runAgentSkills = nonOwnerChatRun ? builtinAgentSkillRecords() : agentSkills;
        const taughtSkillIndex = runSavedSkills.slice(0, 20);
        const taughtSkillsLine =
          taughtSkillIndex.length > 0
            ? `Saved taught skills:\n${taughtSkillIndex
                .map((skill) => {
                  const playbook = parsePlaybook(skill.playbook);
                  const name = skill.name || skill.goal.slice(0, 80);
                  return `- ${name} (taughtSkillId: ${skill.id}): ${playbook.whenToUse || skill.goal}`;
                })
                .join(
                  "\n",
                )}\nWhen a saved skill matches the task, load it with skill_read using taughtSkillId and follow its playbook. Use the actual project and matching task family for scoped skills.`
            : undefined;
        const agentSkillsLine = formatSkillsCatalogInstruction(runAgentSkills);
        const missingImagesInstruction = missingTurnImagesInstruction(
          turnBlocks,
          currentTurnImages,
        );
        const taskPrompt = expandSkillReferencesInPrompt(
          [task.prompt, attachedFilesPrompt, missingImagesInstruction].filter(Boolean).join("\n\n"),
          runAgentSkills,
        );
        const invokedSkill = runSavedSkills.find(
          (skill) =>
            // Taught skills are the space's. Only a person's own message may pull in one someone
            // else taught; any other run follows only those its own person taught.
            (ownerStartedRun || skill.userId === run.userId) &&
            promptInvokesSkill(taskPrompt, skill.name || skill.goal),
        );
        let basePrompt = taskPrompt;
        const revisionActor = { spaceId: run.spaceId, userId: run.userId };
        const pinsRead = !nonOwnerChatRun && (ticketReceiptsEnabled() || fence > 1);
        const pinned = pinsRead
          ? await listPinnedTaughtSkillRevisions(deps.prisma, revisionActor, run.id)
          : [];
        if (!nonOwnerChatRun && (ticketReceiptsEnabled() || pinned.length > 0)) {
          if (
            ticketReceiptsEnabled() &&
            invokedSkill &&
            !pinned.some((revision) => revision.skillId === invokedSkill.id)
          ) {
            const selected = await pinTaughtSkillRevisionToRun(deps.prisma, revisionActor, {
              runId: run.id,
              skillId: invokedSkill.id,
              context: {},
            });
            if (selected) pinned.push(selected);
          }
          if (pinned.length) {
            basePrompt = `${pinned
              .map((revision) =>
                formatSkillRunPrompt(
                  `${revision.snapshot.name} [${revision.id}]`,
                  revision.snapshot.playbook,
                ),
              )
              .join("\n\n")}\n\n${taskPrompt}`;
          }
        } else if (invokedSkill) {
          basePrompt = `${formatSkillRunPrompt(
            invokedSkill.name || invokedSkill.goal.slice(0, 80),
            parsePlaybook(invokedSkill.playbook),
          )}\n\n${taskPrompt}`;
        }
        if (turnCheckpoint) {
          turnCheckpoint = restoreTurnCheckpointEffects(
            ctx,
            turnCheckpoint,
            {
              provider: runModelProvider,
              id: runModelId,
            },
            savedComputerMode?.mode,
          );
          if (checkpointModelResolver && !turnCheckpoint)
            throw new Error("Pinned computer mode checkpoint cannot be restored");
        }
        const approvalContinuation = turnCheckpoint
          ? undefined
          : buildApprovalContinuation(
              approvedEffects,
              (request) => redactSecrets(JSON.stringify(request), runSecrets),
              { exposedToolNames: new Set(partitionTools(tools).listed.map((tool) => tool.name)) },
            );
        const replyContext = await loadReplyContext(deps.prisma, thread.id, run.sourceMessageId);
        let userTimeZone: string | null | undefined;
        try {
          userTimeZone = (
            await deps.prisma.user.findUnique({
              where: { id: run.userId },
              select: { timezone: true },
            })
          )?.timezone;
        } catch {
          // Timezone is optional context; a lookup failure must not prevent a run.
        }
        let lateRoutineNote: string | undefined;
        const lateSince = current.lateSince ?? firstLateSince;
        if (lateSince && run.routineId) {
          try {
            const routine = await deps.prisma.routine.findUnique({
              where: { id: run.routineId },
              select: { timezone: true },
            });
            if (routine)
              lateRoutineNote = lateRoutineRunInstruction(
                lateSince,
                executionStartedAt,
                routine.timezone,
              );
          } catch {
            // Lateness is optional context; a lookup failure must not prevent a run.
          }
        }
        const sharedSpaceNote = people
          ? await loadSharedSpaceNote(deps.prisma, run.spaceId, run.userId)
          : undefined;
        // Model/browser setup can add protected values after recall; charge redaction at injection.
        const recallBlock = recalled?.ok ? buildRecalledMemory(recalled.value, runSecrets) : null;
        if (recallBlock) {
          getLogger().info("semantic memory context selected", {
            "run.id": runId,
            "memory.origin": automaticRecall.origin,
            "memory.shown": recallBlock.shown,
            "memory.omitted": recallBlock.omitted,
            "memory.bytes": recallBlock.bytes,
          });
        }
        const recalledMemory = recallBlock?.text ?? "";
        const lessonNotes = buildLessonNotes(
          lessonRecall?.ok
            ? lessonRecall.value.flatMap((result) =>
                result.id && result.revision !== undefined
                  ? [{ id: result.id, revision: result.revision, content: result.memory }]
                  : [],
              )
            : [],
          runSecrets,
        );
        if (lessonRecall?.ok) {
          getLogger().info("lesson context selected", {
            "run.id": runId,
            "memory.matched": lessonRecall.value.length,
            "memory.shown": lessonNotes.shown.length,
            "memory.omitted": lessonNotes.omitted.map((note) => note.reason),
            "memory.bytes": lessonNotes.bytes,
          });
        }
        if (lessonNotes.shown.length > 0) {
          await recordLessonUse(deps.prisma, {
            spaceId: run.spaceId,
            botId: bot.id,
            runId,
            lessons: lessonNotes.shown,
          });
        }
        const recallStage = createRunStageRecall(
          {
            provider: semanticMemory,
            botId: bot.id,
            threadId: thread.id,
            secrets: runSecrets,
            external: externalRecall,
          },
          context,
        );
        const stageNotes = async (trigger: RunStageRecallTrigger) => {
          const recalled = await recallStage(trigger);
          getLogger().info("lesson stage recall", { "run.id": runId, ...recalled.audit });
          if (recalled.audit.references.length)
            await recordLessonUse(deps.prisma, {
              spaceId: run.spaceId,
              botId: bot.id,
              runId,
              lessons: recalled.audit.references,
            }).catch(() => {
              getLogger().warn("lesson stage recall audit unavailable", { "run.id": runId });
            });
          return recalled.addition;
        };
        const recoveryLessons =
          fence > 1 && !checkpointLoadError
            ? await stageNotes({ stage: "recovery", task: task.prompt })
            : undefined;
        // Recalled facts and notes change every turn, so they ride at the end of the current turn
        // rather than the front of history: a moved first message rewrites the cached prefix.
        const prompt = [
          replyContext,
          run.trigger === "reaction" && replyContext ? undefined : basePrompt,
          takeoverResume?.promptNote,
          approvalContinuation,
          // A hang-up turn is read, not heard: no spoken-reply constraint.
          voiceCall && !callEndRun ? voiceCallInstruction(disabledBuiltinTools) : undefined,
          // Per-turn, not in the system prompt: the timestamp changes every call and would break the cacheable prefix.
          formatCurrentTimeInstruction(deps.now?.() ?? new Date(), userTimeZone),
          lateRoutineNote,
          sharedSpaceNote,
          recalledMemory || undefined,
          lessonNotes.text,
          recoveryLessons,
        ]
          .filter(Boolean)
          .join("\n\n");
        const historicalContext: AgentRunRequest["history"] = [];
        if (compactedHistory.usedLocalSummary && compactedHistory.summary) {
          historicalContext.push({
            role: "user",
            content: redactSecrets(
              formatCompactedSummary(compactedHistory.summary, thread.historyCompactedUpToSeq!),
              runSecrets,
            ),
          });
        }
        const modelImageBudget =
          resolved.maxImagesPerPrompt === undefined
            ? undefined
            : Math.max(0, resolved.maxImagesPerPrompt - (currentTurnImages?.length ?? 0));
        // A text-only model keeps the [image:] marker. Putting image parts in
        // history makes the provider reject a follow-up that used to be text.
        const historyWithImages = modelSeesImages
          ? await withRecentTurnImages(deps, history, historyMessages, context, {
              skipMessageId: currentTurnMessage?.id,
              maxImages: modelImageBudget,
            })
          : history;
        const runtimeHistory = [...historicalContext, ...historyWithImages];
        // Without a roster a bot only knows the bots it spawned itself.
        const [teammates, groupDirectory] = await Promise.all([
          thread.groupId
            ? []
            : deps.prisma.bot.findMany({
                where: {
                  spaceId: run.spaceId,
                  archivedAt: null,
                  id: { not: bot.id },
                  thread: { isNot: null },
                },
                select: { id: true, name: true, description: true },
                orderBy: { createdAt: "asc" },
                take: BOT_DIRECTORY_LIMIT,
              }),
          !thread.groupId ? loadBotGroupDirectory(deps.prisma, run) : undefined,
        ]);
        const botDirectory =
          [renderBotDirectory(teammates), groupDirectory].filter(Boolean).join("\n\n") || undefined;

        if (heldForTakeover) {
          const releasedCheckpoint = takeoverCheckpointOf(
            (
              await deps.prisma.run.findUnique({
                where: { id: runId },
                select: { checkpoint: true },
              })
            )?.checkpoint,
          );
          if (releasedCheckpoint) {
            await requeueComputerRun(deps, runId, workerId, fence, releasedCheckpoint, false);
            return;
          }
        }

        // Stop during setup must not still open the model. A reclaimed lease can
        // leave status "running" under a new owner, and the stream loop only
        // notices cancellation after the provider request has started.
        const beforeModel = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true, leaseOwner: true, leaseFence: true },
        });
        if (
          !mayOpenModelStream(
            beforeModel,
            workerId,
            fence,
            !lease.valid || Boolean(runAbortController?.signal.aborted),
          )
        ) {
          return;
        }

        const verbatimMcpServers = await verbatimMcpServersForRun(deps.prisma, {
          botId: bot.id,
          spaceId: run.spaceId,
          userId: run.userId,
        });
        // The running model is not its own backup, unless another account serves it.
        const fallbackModels = (await backups.load()).filter(
          (candidate) =>
            !backups.unavailable.has(candidate) &&
            (candidate.provider !== runModelProvider ||
              candidate.modelId !== runModelId ||
              (candidate.credentialId !== undefined &&
                candidate.credentialId !== mainRunModel.connectionId)),
        );
        const fallbackKey = (provider: string, modelId: string, credentialId?: string | null) =>
          JSON.stringify([provider, modelId, credentialId ?? null]);
        const fallbackModelKeys = new Set(
          fallbackModels.map((candidate) =>
            fallbackKey(candidate.provider, candidate.modelId, candidate.credentialId),
          ),
        );
        const fallbackModelIds = new Set(
          fallbackModels.map((candidate) => fallbackKey(candidate.provider, candidate.modelId)),
        );
        // Provider kind and model id only: custom endpoints are identified by kind, never host.
        const activeModel = { "model.provider": runModelProvider, "model.id": runModelId };
        // Shutdown must not finalize the attempt. The finally block queues the run
        // when this worker still owns it.
        const interruptedByShutdown = async () => {
          if (!deps.shutdownSignal?.aborted) return false;
          if (!ctx.state.terminalCheckpointComplete) {
            await ctx.computer.checkpoint.flush().catch(() => undefined);
          }
          return true;
        };
        // A background turn steps aside for a person's message waiting on the bot's computer:
        // the turn is aborted and requeued between tool calls, so it never opens another model
        // call ahead of the person. Its tool effects replay from the ledger on the next attempt.
        // One yield per run: a turn that already restarted once (this yield, or any other
        // requeue) runs to its end, so a busy conversation cannot restart it over and over.
        let yieldedToWaitingUser = false;
        const userTurnWaiting = async () => {
          if (isConversationalRun(run.trigger)) return false;
          ctx.state.earlierAttempt ??= deps.prisma.attempt
            .count({ where: { runId } })
            .then((count) => count > 1);
          if (await ctx.state.earlierAttempt) return false;
          const waiting = await deps.prisma.run.findFirst({
            where: {
              botId: run.botId,
              id: { not: runId },
              status: "queued",
              trigger: "user",
              // A group member waits for the members before it, not for this computer.
              groupTurn: null,
              OR: [{ wakeAt: null }, { wakeAt: { lte: new Date() } }],
            },
            select: { id: true },
          });
          return waiting !== null;
        };

        try {
          if (checkpointLoadError) throw checkpointLoadError;
          const finalizationEvidence =
            ticketReceiptsEnabled() && deps.ticketBoardEnabled
              ? createTicketFinalizationEvidence(runSecrets)
              : undefined;
          let usageOperationId = runId;
          let configurationRecorded = false;
          let configurationPublication: Promise<void> | undefined;
          let modelChangeSequence = 0;
          let progressBoundary: string | undefined;
          const appliedComponentRevisions = new Set<string>();
          const runtimeRequest: AgentRunRequest = {
            botId: bot.id,
            verbatimMcpServers,
            threadId: thread.id,
            runId,
            routineId: run.routineId,
            sourceMessageId: run.sourceMessageId,
            onUsage: async (event) => {
              await recordUsage(deps.prisma, event, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                runId,
                parentRunId: runId,
                operationId: usageOperationId,
              });
            },
            prompt,
            ...(speakers &&
            (run.trigger === "user" ||
              (run.trigger === "follow_up" && sourceMessage?.role === "user"))
              ? { promptSpeaker: personSpeaker(people, run.userId) }
              : {}),
            // Keep an explicit executor override, but let the runtime select
            // cache-aware context for connections declaring a cache window.
            contextStrategy: deps.contextStrategy,
            instructions: userTurnInstructions({
              botInstructions: [
                runIdentityInstruction(bot, run.trigger),
                botEmail
                  ? botEmailInstruction(botEmail, {
                      // Only the tools this bot has: its owner may turn any of them off.
                      read: emailInbox && !disabledBuiltinTools.has("read_email"),
                      send:
                        emailInbox &&
                        Boolean(deps.email) &&
                        !disabledBuiltinTools.has("send_email"),
                      delete: emailInbox && !disabledBuiltinTools.has("delete_email"),
                    })
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
              groupContext: groupReplyOptional
                ? [groupContext, GROUP_UNADDRESSED_REPLY_GUIDANCE].filter(Boolean).join("\n")
                : groupContext,
              messagingContext,
              redactedMemoryContext: memoryContext
                ? redactSecrets(memoryContext, runSecrets)
                : undefined,
              redactedScratchpadContext: scratchpadContext
                ? redactSecrets(scratchpadContext, runSecrets)
                : undefined,
              redactedTicketContext: ticketContext
                ? redactSecrets(ticketContext, runSecrets)
                : undefined,
              hasHistoricalContext: historicalContext.length > 0 || Boolean(recalledMemory),
              // A background helper is not offered the history tools, so it gets no guidance on them.
              historyRetrievalEnabled:
                contextStrategy !== "current" &&
                tools.some((tool) => tool.name === "search_history"),
              semanticMemoryEnabled: tools.some((tool) => tool.name === "save_memory"),
              computerInstruction,
              pageBrowserAllowed,
              taskCatalogInstruction,
              workspaceInstruction,
              agentEnvironmentInstruction,
              botDirectory,
              pluginLine,
              agentSkillsLine,
              taughtSkillsLine,
              replyGuidance: runReplyGuidance(run.trigger, replyMode),
              // These runs get a narrow tool set, so guidance names only the tools they have.
              disabledBuiltinTools:
                isStrategicInitiativeRun(run) || run.trigger === BACKGROUND_HELPER_TRIGGER
                  ? new Set(
                      builtinAgentTools
                        .map((tool) => tool.name)
                        .filter((name) => !strategicBuiltins.some((tool) => tool.name === name)),
                    )
                  : disabledBuiltinTools,
              offeredFleetTools: offeredFleetTools(strategicBuiltins),
              followUpsOffered: followUpsOffered(strategicBuiltins, ownerStartedRun),
              backgroundHelpersAllowed: backgroundHelpersAllowed({
                threadBotId: thread.botId,
                botId: bot.id,
                trigger: run.trigger,
              }),
              userComputer,
            })
              .filter((instruction): instruction is string => Boolean(instruction))
              .join("\n\n"),
            history: runtimeHistory,
            currentTurnImages,
            currentRunRequiresImageInput,
            currentTurnImageFileFallback: Boolean(
              currentTurnImages?.length &&
                currentTurnFiles.length &&
                !turnBlocks?.some(
                  (block) => block.kind === "image" && block.imageHandling === "confirm",
                ),
            ),
            tools,
            // The live array: secrets learned later in the run redact too.
            secrets: runSecrets,
            model: mainRunModel,
            computerModel,
            fallbackModels: fallbackModels.map(({ provider, modelId, credentialId }) => ({
              provider,
              id: modelId,
              ...(credentialId ? { connectionId: credentialId } : {}),
            })),
            resolveFallbackModel:
              checkpointModelResolver || fallbackModelKeys.size
                ? async (provider, modelId, connectionId) => {
                    if (checkpointModelResolver?.has(provider, modelId, connectionId))
                      return checkpointModelResolver(provider, modelId, connectionId);
                    const key = fallbackKey(provider, modelId, connectionId);
                    if (!fallbackModelKeys.has(key))
                      throw new Error("Backup model is not selected");
                    return resolveConnectedModel(
                      { userId: run.userId, spaceId: run.spaceId },
                      provider,
                      modelId,
                      (values) => runSecrets.push(...values),
                      true,
                      fallbackModels.find(
                        (candidate) =>
                          fallbackKey(
                            candidate.provider,
                            candidate.modelId,
                            candidate.credentialId,
                          ) === key,
                      )?.thinkingLevel ?? null,
                      connectionId,
                    );
                  }
                : undefined,
            onModelChange: async (provider, modelId, computerMode) => {
              const roleModel =
                [mainRunModel, computerModel].some(
                  (model) => model?.provider === provider && model.id === modelId,
                ) || checkpointModelResolver?.hasModel(provider, modelId);
              if (!roleModel && !fallbackModelIds.has(fallbackKey(provider, modelId))) {
                throw new Error("Model is not selected");
              }
              await configurationPublication;
              // The run's model is what retries and pins rerun; computer mode is a detour from it.
              if (configurationRecorded) {
                await recordRunConfigurationModelChange(
                  deps.prisma,
                  { runId, attemptId: attempt.id, spaceId: run.spaceId },
                  { owner: workerId, fence },
                  ++modelChangeSequence,
                  usageOperationId,
                  { provider, modelId, computerMode },
                );
              } else if (!computerMode) {
                const updated = await deps.prisma.run.updateMany({
                  where: {
                    id: runId,
                    status: "running",
                    leaseOwner: workerId,
                    leaseFence: fence,
                  },
                  data: { modelProvider: provider, modelId },
                });
                if (updated.count !== 1) {
                  throw new Error("Run lease was lost before the backup model could be used");
                }
              }
              activeModel["model.provider"] = provider;
              activeModel["model.id"] = modelId;
            },
            resumeFromCheckpoint: takeoverResume?.checkpoint,
            turnCheckpoint,
            onCheckpoint: async (capture, executionId) => {
              effects.pendingTurnCheckpoints.set(executionId, capture);
            },
            resumeToolResult: {
              content: [{ type: "text", text: takeoverResume?.promptNote ?? taskPrompt }],
            },
            script,
            allowSilentEmpty: allowSilentEmptyRun,
            emptyResponseText,
            executeTool: scripted
              ? undefined
              : async (name, args, executionId, route, observer) => {
                  let result = await applyTool(ctx, name, args, executionId, route, observer);
                  if (
                    name === "skill_read" &&
                    args.taughtSkillId &&
                    args.inspect !== true &&
                    !isToolPauseResult(result) &&
                    toolResultError(result) === undefined
                  ) {
                    const revision = (
                      await listPinnedTaughtSkillRevisions(deps.prisma, revisionActor, runId)
                    ).find((entry) => entry.skillId === String(args.taughtSkillId));
                    if (revision) {
                      const prepared = await preparePinnedComponents(revision, "tool_result");
                      if (prepared?.pauseResult) return prepared.pauseResult;
                      if (prepared) {
                        result = {
                          kind: "agent_tool_result",
                          content: [
                            { type: "text", text: JSON.stringify(result) },
                            { type: "text", text: prepared.instructions },
                          ],
                          details: result,
                        };
                      }
                    }
                  }
                  if (
                    !configurationRecorded &&
                    ticketReceiptsEnabled() &&
                    deps.ticketBoardEnabled &&
                    run.ticketId
                  ) {
                    await publishConfiguration();
                  }
                  // Checked after a tool, before the next model call. A paused tool belongs
                  // to the user now, so its run finishes as a pause, not a yield.
                  if (
                    !yieldedToWaitingUser &&
                    !ctx.state.approval.pausePending &&
                    (await userTurnWaiting())
                  ) {
                    yieldedToWaitingUser = true;
                    ctx.runtimeAbortController.abort();
                  }
                  if (!isToolPauseResult(result) && !ctx.runtimeAbortController.signal.aborted) {
                    const failed =
                      toolCompletionOutcome({ name, executionId, durationMs: 0, result }) ===
                      "failed";
                    const details = (result as { details?: unknown } | null)?.details ?? result;
                    const acceptance =
                      name === "ticket_update" && args.result !== undefined
                        ? (
                            details as {
                              acceptance?: {
                                status: string;
                                results: Array<{ status: string; reason: string }>;
                              };
                            } | null
                          )?.acceptance
                        : undefined;
                    const gaps =
                      acceptance?.status === "unknown"
                        ? acceptance.results
                            .filter((item) => item.status === "unknown")
                            .slice(0, 20)
                            .map((item) => item.reason)
                        : undefined;
                    const addition = failed
                      ? await stageNotes({
                          stage: "tool_failure",
                          toolName: name,
                          error: toolResultError(result) ?? "Observed nonzero exit status.",
                        })
                      : gaps?.length
                        ? await stageNotes({ stage: "acceptance_gap", task: task.prompt, gaps })
                        : undefined;
                    if (addition) {
                      const envelope = result as { kind?: string; content?: unknown[] };
                      result =
                        envelope?.kind === "agent_tool_result" && Array.isArray(envelope.content)
                          ? {
                              ...envelope,
                              content: [...envelope.content, { type: "text", text: addition }],
                            }
                          : {
                              kind: "agent_tool_result",
                              content: [
                                { type: "text", text: JSON.stringify(result) ?? "No tool output." },
                                { type: "text", text: addition },
                              ],
                              details: result,
                            };
                    }
                  }
                  return result;
                },
            resolveModel: scripted
              ? undefined
              : (provider, modelId) =>
                  resolveConnectedModel(run, provider, modelId, (values) =>
                    runSecrets.push(...values),
                  ),
            onToolCompleted: (completion) => {
              finalizationEvidence?.observe(completion);
              if (!completion.paused)
                progressBoundary = createHash("sha256")
                  .update(completion.executionId)
                  .digest("hex");
              if (effects.restoredPending?.executionId === completion.executionId)
                effects.restoredPending = undefined;
              if (!completion.paused) effects.pendingTurnCheckpoints.delete(completion.executionId);
              const outcome = toolCompletionOutcome(completion);
              if (outcome) state.reply.toolOutcomes.set(completion.executionId, outcome);
              const audited = appendToolCompletionAudit(
                deps,
                {
                  spaceId: run.spaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  runId,
                },
                completion,
                runSecrets,
              );
              state.toolResults.set(
                completion.executionId,
                toolResultFingerprint(completion.result, completion.error),
              );
              return audited;
            },
            claimSteering: async (seenIds) => {
              const claimed = await claimRunSteering(
                deps,
                {
                  threadId: thread.id,
                  botId: bot.id,
                  runId,
                  leaseOwner: workerId,
                  leaseFence: fence,
                },
                seenIds,
                context,
                pendingTurnFiles,
                {
                  messageId: currentTurnMessage?.id,
                  hasImages: Boolean(currentTurnImages?.length),
                },
              );
              ctx.state.steeringClaimed += claimed.filter((item) => item.origin === "user").length;
              if (
                run.ticketId &&
                deps.ticketBoardEnabled &&
                !nonOwnerChatRun &&
                progressBoundary &&
                usageOperationId === runId &&
                !ctx.state.approval.pausePending &&
                !ctx.runtimeAbortController.signal.aborted
              ) {
                const boundaryId = `${runId}:${attempt.id}:tools:${progressBoundary}`;
                const noteId = `ticket-progress:${boundaryId}`;
                if (!seenIds.includes(noteId)) {
                  const progress = await runTicketProgressCheck(ctx, {
                    boundaryId,
                    ...(progressJudge ? { judge: progressJudge } : {}),
                  });
                  if (progress?.revision !== null && progress?.decision.action === "replan")
                    claimed.push({
                      id: noteId,
                      messageId: noteId,
                      text: automated(TICKET_PROGRESS_REPLAN_NOTE),
                    });
                }
              }
              return claimed;
            },
          };
          const preparePinnedComponents = async (
            revision: TaughtSkillRevision,
            phase: SkillComponentPhase,
          ) => {
            if (!revision.snapshot.components || appliedComponentRevisions.has(revision.id))
              return undefined;
            appliedComponentRevisions.add(revision.id);
            let pauseResult: unknown;
            const prepared = await runSkillComponents({
              revision,
              runId,
              attemptId: attempt.id,
              phase,
              instructions: "",
              offeredTools: runtimeRequest.tools,
              runtimeCapabilities: deps.runtime.describe().capabilities,
              executeTool: runtimeRequest.executeTool
                ? async (name, args, executionId, route, observer) => {
                    const started = performance.now();
                    const result = await runtimeRequest.executeTool!(
                      name,
                      args,
                      executionId,
                      route,
                      observer,
                    );
                    const paused = isToolPauseResult(result);
                    if (paused) pauseResult = result;
                    await runtimeRequest.onToolCompleted?.({
                      name,
                      executionId,
                      durationMs: performance.now() - started,
                      result,
                      paused,
                    });
                    return result;
                  }
                : undefined,
            });
            if (!prepared.paused && !ctx.state.approval.pausePending)
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId,
                type: "effect.recorded",
                payload: {
                  kind: "skill_components",
                  attemptId: attempt.id,
                  phase,
                  eligible: prepared.eligible,
                  receipts: prepared.receipts,
                },
              });
            return { ...prepared, pauseResult };
          };
          const runtimeContext = {
            ...context,
            signal: AbortSignal.any([context.signal, ctx.runtimeAbortController.signal]),
          };
          const progressJudge =
            !scripted &&
            !nonOwnerChatRun &&
            run.ticketId &&
            deps.ticketBoardEnabled &&
            ticketReceiptsEnabled()
              ? createTicketProgressJudge({
                  runtime: deps.runtime,
                  model: mainRunModel,
                  context: { ...runtimeContext, botId: bot.id, threadId: thread.id },
                  goal: task.prompt,
                  secrets: runSecrets,
                  recordUsage: (operationId, event) =>
                    recordUsage(deps.prisma, event, {
                      spaceId: run.spaceId,
                      userId: run.userId,
                      botId: bot.id,
                      runId,
                      parentRunId: runId,
                      operationKind: "learning",
                      operationId,
                    }),
                  onAssessment: async (assessment) => {
                    await deps.events.append({
                      spaceId: run.spaceId,
                      threadId: thread.id,
                      botId: bot.id,
                      runId,
                      type: "effect.recorded",
                      payload: { kind: "ticket_progress_assessment", assessment },
                    });
                  },
                })
              : undefined;
          const requestedModel: RunConfigurationModel | null = hasModelOverride
            ? {
                provider: modelChoice.modelProvider!,
                modelId: modelChoice.modelId!,
                reasoningLevel: modelChoice.thinkingLevel ?? null,
              }
            : main
              ? {
                  provider: main.provider,
                  modelId: main.modelId,
                  reasoningLevel: modelChoice.thinkingLevel ?? main.thinkingLevel ?? null,
                }
              : selectedProvider && selectedModelId
                ? {
                    provider: selectedProvider,
                    modelId: selectedModelId,
                    reasoningLevel: selected.thinkingLevel ?? null,
                  }
                : null;
          const deliveredModel: RunConfigurationModel = {
            provider: runtimeRequest.model.provider,
            modelId: runtimeRequest.model.id,
            reasoningLevel: runtimeRequest.model.thinkingLevel ?? null,
          };
          // Capture entry values before any tool can bind work or the runtime can switch models.
          const configurationInput: RunConfigurationManifestInput | undefined =
            artifacts && !nonOwnerChatRun
              ? {
                  runId,
                  attemptId: attempt.id,
                  deploymentRevision: process.env.GIT_SHA ?? process.env.RAKAZO_GIT_SHA ?? null,
                  model: {
                    requested: requestedModel,
                    deliveredAtStart: deliveredModel,
                    computerModel: computerModel
                      ? {
                          provider: computerModel.provider,
                          modelId: computerModel.id,
                          reasoningLevel: computerModel.thinkingLevel ?? null,
                        }
                      : null,
                    effectiveReasoningLevel: null,
                    allowedFallbacks: fallbackModels.map((candidate) => ({
                      provider: candidate.provider,
                      modelId: candidate.modelId,
                      reasoningLevel: candidate.thinkingLevel ?? null,
                    })),
                    actualFallbacks: requestedModel
                      ? requestedModel.provider === deliveredModel.provider &&
                        requestedModel.modelId === deliveredModel.modelId
                        ? []
                        : [{ ...deliveredModel, source: "startup-selection" }]
                      : null,
                  },
                  runtime: deps.runtime.describe(),
                  contextPolicy: {
                    requestedStrategy: deps.contextStrategy ?? null,
                    deliveredStrategy: runtimeRequest.contextStrategy ?? null,
                    effectiveStrategy: null,
                    revision: null,
                    recallRevision: null,
                  },
                  pinnedTaughtSkills: pinsRead
                    ? pinned.map((revision) => ({
                        skillId: revision.skillId,
                        revisionId: revision.id,
                      }))
                    : null,
                  shownLessons: lessonNotes.shown.map(({ id, revision }) => ({
                    lessonId: id,
                    revision,
                  })),
                }
              : undefined;
          const publishConfiguration = (): Promise<void> => {
            if (!artifacts || !configurationInput) return Promise.resolve();
            configurationPublication ??= persistRunConfigurationManifest(
              deps.prisma,
              artifacts,
              runtimeContext,
              configurationInput,
              { owner: workerId, fence },
            ).then(async () => {
              configurationRecorded = true;
              if (run.ticketId) await ensureRunTicketWorkState(ctx);
            });
            return configurationPublication;
          };
          if (
            (ticketReceiptsEnabled() && deps.ticketBoardEnabled && run.ticketId) ||
            pinned.length > 0 ||
            lessonNotes.shown.length > 0
          ) {
            await publishConfiguration();
          }
          for (const revision of pinned) {
            const prepared = await preparePinnedComponents(
              revision,
              turnCheckpoint ? "restored_turn" : "before_model",
            );
            if (!prepared) continue;
            if (prepared.paused || ctx.state.approval.pausePending) return;
            if (prepared.instructions)
              runtimeRequest.instructions += `\n\n${prepared.instructions}`;
            runtimeRequest.tools = prepared.tools;
          }
          const runtimeEvents = deps.runtime.run(runtimeRequest, runtimeContext);
          if (await consumeRunEvents(ctx, runtimeEvents)) return;
          await configurationPublication;
          if (yieldedToWaitingUser) {
            // Queued again with no retry timer; releasing the computer starts the person's run.
            await requeueRunAfterShutdown(deps, runId, workerId, fence).catch((error) =>
              getLogger().error("run yield requeue", error),
            );
            return;
          }
          if (await interruptedByShutdown()) return;
          if (run.ticketId && deps.ticketBoardEnabled) {
            await saveRunTicketPendingCall(ctx, null);
            await runTicketProgressCheck(ctx);
          }
          if (ticketReceiptsEnabled() && run.ticketId) {
            const work = await deps.prisma.ticket.findFirst({
              where: {
                id: run.ticketId,
                spaceId: run.spaceId,
                createdByUserId: run.userId,
                originKey: { not: null },
              },
              select: { id: true, originThreadId: true, originRunId: true, assigneeBotId: true },
            });
            if (
              work?.originThreadId &&
              work.assigneeBotId === bot.id &&
              (run.trigger === "tickets" || work.originRunId === run.id)
            ) {
              const delivered = () =>
                deps.prisma.message.findFirst({
                  where: {
                    threadId: work.originThreadId!,
                    runId: run.id,
                    role: "bot",
                    clientNonce: { startsWith: `work-receipt:${work.id}:` },
                  },
                  select: { id: true },
                });
              if (!(await delivered())) {
                const draft = state.reply.assembled || state.reply.lastDiscardedMidTurnNarration;
                const deliveryRequest = ticketFinalizationRequest(runtimeRequest, {
                  ticketId: work.id,
                  evidence: finalizationEvidence?.text() ?? "No observations were retained.",
                  draft,
                });
                usageOperationId = `${runId}:ticket-finalize`;
                getLogger().info("run.phase.started", {
                  "run.id": runId,
                  "run.phase": "finalize",
                  "phase.reason": "missing_work_receipt",
                  "operation.id": usageOperationId,
                });
                const deliveryEvents = ticketFinalizationEvents(
                  deps.runtime.run(deliveryRequest, runtimeContext),
                  deliveryRequest.onUsage!,
                );
                if (await consumeRunEvents(ctx, deliveryEvents)) return;
                if (await interruptedByShutdown()) return;
                if (!(await delivered())) {
                  throw new Error("Ticket execution ended without delivering its work receipt.");
                }
              }
            }
          }
          await completeRun(ctx);
        } catch (turnError) {
          if (await interruptedByShutdown()) return;
          let caughtError = turnError;
          if (handoffEndedTurn(state, caughtError)) {
            try {
              await completeRun(ctx);
              return;
            } catch (completionError) {
              caughtError = completionError;
            }
          }
          await failRun(ctx, caughtError, {
            ownCredential: resolved.ownCredential,
            active: activeModel,
          });
        }
      } catch (setupError) {
        await retryRunSetup(
          deps,
          run,
          { id: attempt.id, workerId, fence },
          {
            resumeCheckpoint,
            heldForTakeover,
            dispatchHandedOff,
            leaseValid: lease.valid,
            secrets: runSecrets,
          },
          setupError,
        );
      } finally {
        getLogger().info("run.computer", {
          "run.id": runId,
          trigger: run.trigger,
          reason: computerUse.reason,
          tool: computerUse.tool,
          ready: Boolean(computerUse.screenRelease),
        });
        detachShutdown?.();
        clearInterval(heartbeat);
        await finishRunAttempt(
          deps,
          run,
          { id: attempt.id, workerId, fence },
          { lease, computerUse, computerLease },
          { endRunConnectorState, settleHelpers },
        );
      }
    },
  };
}

/**
 * A run acts with its sender's accounts, so it must not start or resume once they have left
 * the Space. Leaving cancels their runs; this closes the gap for anything that slipped past.
 */
async function cancelRunOfFormerMember(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
  },
): Promise<boolean> {
  const member = await deps.prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
    select: { id: true },
  });
  if (member) return false;
  const cancelled = await deps.prisma.$transaction(async (tx) => {
    const current = await tx.run.findUnique({
      where: { id: run.id },
      select: {
        id: true,
        taskId: true,
        userId: true,
        spaceId: true,
        status: true,
      },
    });
    if (!current || isTerminal(current.status as RunStatus)) return null;
    const [stopped] = await cancelRunsInTransaction(tx, [current], new Date());
    if (!stopped) return null;
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "run.cancelled",
      payload: {},
    });
    // Remaining members' messages waited behind this run; give them their own.
    const continuationId = await createPendingSteeringRun(tx, run);
    return { seq: event.seq, continuationId };
  });
  if (!cancelled) return true;
  await deps.events.notify(run.threadId, cancelled.seq).catch(() => undefined);
  if (cancelled.continuationId) await deps.jobs.enqueue(runContinueJob(cancelled.continuationId));
  return true;
}
