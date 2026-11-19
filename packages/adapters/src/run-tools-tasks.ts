import { reflectRunJob } from "@rakazo/adapter-kit";
import {
  desktopGuardApplies,
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import type { RunContext } from "./run-context.js";
import { findSkillForRun } from "./run-reflection.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  isScheduleValueProvided,
  listSchedulesFromTool,
  scheduleCreateError,
  scheduleCreateFields,
  scheduleTimingArgs,
  updateScheduleFromTool,
} from "./schedule-tools.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "./scratchpad-tools.js";
import { selfEvolutionEnabled } from "./self-evolution.js";
import {
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";
import { taskCatalogFromTool } from "./task-catalog.js";
import {
  getCurrentTaughtSkillRevision,
  getTaughtSkillRevision,
  listPinnedTaughtSkillRevisions,
  pinTaughtSkillRevisionToRun,
  rollbackTaughtSkillRevision,
  saveTaughtSkillRevision,
} from "./taught-skill-revisions.js";
import { deliverTicketWork } from "./ticket-delivery.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "./ticket-tools.js";
import { refusal } from "./tool-refusal.js";

/** A command watch may not run what the desktop guard keeps the bot from running itself. */
function commandWatchGuardError(ctx: RunContext, watch: unknown): string | undefined {
  const command = commandWatchFromTool(watch);
  const refusal = command === undefined ? undefined : protectedComputerLifecycleRefusal(command);
  return desktopGuardApplies(ctx.computer) && refusal
    ? desktopProtectionGuardMessage(refusal)
    : undefined;
}

/**
 * What `schedule_create` refuses before saving anything. Checked before the approval gate,
 * so a routine that cannot be saved returns its error and shows no card; the handler checks again.
 */
export async function scheduleCreateRefusal(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<{ error: string } | undefined> {
  const { deps, run, bot, thread } = ctx;
  const error =
    commandWatchGuardError(ctx, args.watch) ??
    (await scheduleCreateError(deps.prisma, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      threadId: thread.id,
      ...scheduleCreateFields(args),
    }));
  return error ? { error } : undefined;
}

/** The task catalog, scratchpad, ticket board, schedules and skills. */
export const taskTools: ToolHandlers = {
  async task_catalog(ctx) {
    const { deps, run, bot, thread } = ctx;
    return taskCatalogFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      ...(thread.groupId ? { groupThreadId: thread.id } : {}),
      tools: ctx.tools.offered,
    });
  },
  async scratchpad_list(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return listScratchpadItemsFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      includeDone: Boolean(args.includeDone),
    });
  },
  async scratchpad_add(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const created = await addScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      title: String(args.title ?? ""),
      status: args.status ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
    });
    return call.finish(created);
  },
  async scratchpad_update(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const updated = await updateScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
      title: args.title !== undefined ? String(args.title) : undefined,
      status: args.status !== undefined ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
    });
    return call.finish(updated);
  },
  async scratchpad_complete(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const completed = await completeScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
    });
    return call.finish(completed);
  },
  async scratchpad_remove(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const removed = await removeScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
    });
    return call.finish(removed);
  },
  async board_tickets(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await listBoardTickets(deps, {
        spaceId: run.spaceId,
        status: args.status !== undefined ? String(args.status) : undefined,
        assigneeBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
        cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
      }),
    );
  },
  async ticket_get(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await getTicket(deps, {
        spaceId: run.spaceId,
        ref: String(args.ref ?? ""),
      }),
    );
  },
  async ticket_create(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const created = await createTicket(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      ...(ticketReceiptsEnabled() &&
      ctx.source.ownerAuthoredRun &&
      !ctx.source.channelId &&
      !ctx.thread.externalConversationId &&
      (ctx.thread.botId === bot.id || ctx.thread.groupId) &&
      run.sourceMessageId
        ? {
            origin: {
              threadId: run.threadId,
              messageId: run.sourceMessageId,
              runId: run.id,
              key: `${run.id}:${call.effectKey}`,
            },
          }
        : {}),
      title: String(args.title ?? ""),
      description: args.description !== undefined ? String(args.description) : undefined,
      priority: args.priority !== undefined ? String(args.priority) : undefined,
      ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
    });
    if ("ticket" in created && "delivery" in created && created.ticket.assigneeBotId === bot.id) {
      run.ticketId = created.ticket.id;
    }
    return call.finish(created);
  },
  async ticket_update(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    if (args.result !== undefined) {
      if (Object.keys(args).some((key) => key !== "id" && key !== "result"))
        return call.finish({ error: "Use only id and result for a delivery." });
      return call.finish(
        await deliverTicketWork(deps, run, {
          id: String(args.id ?? ""),
          result: args.result,
          ownerAuthored: ctx.source.ownerAuthoredRun && !ctx.source.channelId,
          secrets: ctx.secrets,
        }),
      );
    }
    const updated = await updateTicket(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      runId: run.id,
      id: String(args.id ?? ""),
      title: args.title !== undefined ? String(args.title) : undefined,
      description: args.description !== undefined ? String(args.description) : undefined,
      priority: args.priority !== undefined ? String(args.priority) : undefined,
      status: args.status !== undefined ? String(args.status) : undefined,
      ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
    });
    if ("ticket" in updated && args.ownerBotId === bot.id && ticketReceiptsEnabled()) {
      const current = await deps.prisma.run.findUniqueOrThrow({
        where: { id: run.id },
        select: { ticketId: true },
      });
      run.ticketId = current.ticketId;
    }
    return call.finish(updated);
  },
  async ticket_comment(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return call.finish(
      await commentTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        id: String(args.id ?? ""),
        body: String(args.body ?? ""),
      }),
    );
  },
  async schedule_create(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    const refusal = commandWatchGuardError(ctx, args.watch);
    if (refusal) return call.finish({ error: refusal });
    const created = await createScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      threadId: thread.id,
      ...scheduleCreateFields(args),
    });
    return call.finish(created);
  },
  async schedule_update(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    return call.finish(
      await updateScheduleFromTool(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        threadId: thread.id,
        ...(thread.groupId ? { scopeThreadId: thread.id } : {}),
        routineId: String(args.routineId ?? ""),
        name: isScheduleValueProvided(args.name) ? String(args.name) : undefined,
        prompt: isScheduleValueProvided(args.prompt) ? String(args.prompt) : undefined,
        active: typeof args.active === "boolean" ? args.active : undefined,
        timezone: isScheduleValueProvided(args.timezone) ? String(args.timezone) : undefined,
        schedule: compactScheduleInput(scheduleTimingArgs(args)),
      }),
    );
  },
  async schedule_list(ctx) {
    const { deps, run, bot, thread } = ctx;
    return listSchedulesFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { groupThreadId: thread.id } : {}),
    });
  },
  async schedule_cancel(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { threadId: thread.id } : {}),
      routineId: args.routineId ? String(args.routineId) : undefined,
      name: args.name ? String(args.name) : undefined,
    });
    return call.finish(cancelled);
  },
  async skill_read(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    if (args.taughtSkillId) {
      const actor = { spaceId: run.spaceId, userId: run.userId };
      if (args.inspect !== true) {
        const pinned = (await listPinnedTaughtSkillRevisions(deps.prisma, actor, run.id)).find(
          (revision) => revision.skillId === String(args.taughtSkillId),
        );
        if (pinned)
          return { revision: pinned, instruction: "Continue using this run's fixed playbook." };
      }
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: {
          id: String(args.taughtSkillId),
          spaceId: run.spaceId,
          botId: run.botId,
          status: "saved",
          ...(!ctx.source.ownerStartedRun ? { userId: run.userId } : {}),
        },
        select: { id: true },
      });
      if (!skill) return { error: "Saved taught skill unavailable." };
      if (args.inspect === true) {
        const revision = await getCurrentTaughtSkillRevision(deps.prisma, actor, skill.id);
        const previous = revision.previousRevisionId
          ? await getTaughtSkillRevision(deps.prisma, actor, {
              skillId: skill.id,
              revisionId: revision.previousRevisionId,
            })
          : null;
        return { revision, previous };
      }
      const revision = await pinTaughtSkillRevisionToRun(deps.prisma, actor, {
        runId: run.id,
        skillId: skill.id,
        context: {
          ...(args.projectPath && ctx.bot.computer
            ? { project: { computerId: ctx.bot.computer.id, path: String(args.projectPath) } }
            : {}),
          ...(args.taskFamily ? { taskFamilies: [String(args.taskFamily)] } : {}),
        },
      });
      if (revision)
        return { revision, instruction: "Follow this fixed playbook for the matching task." };
      // Name what the skill is limited to, so one more call can load it when the task matches.
      const { scope } = (await getCurrentTaughtSkillRevision(deps.prisma, actor, skill.id))
        .snapshot;
      return {
        error:
          "This skill is limited to the task family or project below. If this task belongs to it, call again with that taskFamily or projectPath.",
        ...(scope.taskFamilies?.length ? { taskFamilies: scope.taskFamilies } : {}),
        ...(scope.project ? { projectPath: scope.project.path } : {}),
      };
    }
    return skillReadFromTool(
      deps.prisma,
      {
        spaceId: run.spaceId,
        userId: run.userId,
      },
      {
        name: args.name ? String(args.name) : undefined,
        skillId: args.skillId ? String(args.skillId) : undefined,
        file: args.file ? String(args.file) : undefined,
      },
    );
  },
  async skill_create(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillCreateFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          description: args.description ? String(args.description) : undefined,
          body: args.body ? String(args.body) : undefined,
          content: args.content ? String(args.content) : undefined,
        },
      ),
    );
  },
  async skill_update(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    if (args.taughtSkillId) {
      if (!ctx.source.ownerAuthoredRun || ctx.thread.groupId || ctx.thread.externalConversationId) {
        return call.finish({
          error: "Revert a taught skill from its owner's direct conversation.",
        });
      }
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: {
          id: String(args.taughtSkillId),
          spaceId: run.spaceId,
          botId: run.botId,
          userId: run.userId,
          status: "saved",
        },
        select: { id: true },
      });
      if (!skill || typeof args.expectedRevisionId !== "string") {
        return call.finish({
          error: "Read the saved skill's current revision before reverting it.",
        });
      }
      if (args.improvementFamily === "file-delivery") {
        if (!ctx.bot.computer || typeof args.projectPath !== "string" || !args.projectPath.trim()) {
          return call.finish({
            error: "Choose the project directory for this skill's comparison pilot.",
          });
        }
        const actor = { spaceId: run.spaceId, userId: run.userId };
        const current = await getCurrentTaughtSkillRevision(deps.prisma, actor, skill.id);
        if (current.id !== args.expectedRevisionId) {
          return call.finish({ error: "Skill changed. Read its current revision first." });
        }
        return call.finish({
          revision: await saveTaughtSkillRevision(deps.prisma, actor, {
            skillId: skill.id,
            scope: {
              project: { computerId: ctx.bot.computer.id, path: args.projectPath.trim() },
              taskFamilies: ["file-delivery"],
            },
          }),
        });
      }
      return call.finish(
        await rollbackTaughtSkillRevision(
          deps.prisma,
          {
            spaceId: run.spaceId,
            userId: run.userId,
          },
          { skillId: skill.id, expectedCurrentRevisionId: args.expectedRevisionId },
        ),
      );
    }
    return call.finish(
      await skillUpdateFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          skillId: args.skillId ? String(args.skillId) : undefined,
          newName: args.newName ? String(args.newName) : undefined,
          description: args.description !== undefined ? String(args.description) : undefined,
          body: args.body !== undefined ? String(args.body) : undefined,
          content: args.content ? String(args.content) : undefined,
        },
      ),
    );
  },
  async skill_delete(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillDeleteFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          skillId: args.skillId ? String(args.skillId) : undefined,
        },
      ),
    );
  },
  async reflect_on_run(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    if (!selfEvolutionEnabled())
      return refusal(
        "self_evolution_disabled",
        "Reviewing a run is turned off in this deployment.",
      );
    if (!ctx.source.ownerStartedRun)
      return refusal("reflect_owner_only", "Only the user's own chat can ask for a run review.");
    if (thread.groupId)
      return refusal("reflect_direct_only", "Run reviews happen in the bot's own chat.");
    const requested = args.runId ? String(args.runId).trim() : undefined;
    const target = await deps.prisma.run.findFirst({
      where: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: thread.id,
        status: { in: ["completed", "failed", "cancelled"] },
        ...(requested ? { id: requested } : { id: { not: ctx.runId } }),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!target)
      return {
        error: requested
          ? "That run is not a finished run in this chat."
          : "There is no finished run to review in this chat yet.",
      };
    const existing = await findSkillForRun(deps.prisma, bot.id, target.id);
    if (existing && !run.sourceMessageId)
      return {
        ok: true,
        runId: target.id,
        alreadyReviewed: true,
        skill: { id: existing.id, name: existing.name, status: existing.status },
        hint: `This run already produced the skill "${existing.name}" (${existing.status}); no new draft will be created. Edit that skill instead, or delete it first to review this run again.`,
      };
    await deps.jobs.enqueue(
      reflectRunJob(target.id, {
        // The owner may include a specific correction in the message asking for the review.
        ...(run.sourceMessageId ? { exceptMessageId: run.sourceMessageId } : {}),
      }),
    );
    return {
      ok: true,
      runId: target.id,
      hint: "Short lessons the review saves appear on this bot's memory page under Experience; a draft skill card appears in this chat only if something reusable turns up, and the user must review and save it.",
    };
  },
};
