import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  recordUsage,
} from "@rakazo/db";
import { createLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReflectionLessonStore } from "./run-reflection.js";
import { parseReflection, reflectRun, verifyLessonEvidence } from "./run-reflection.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
  createThreadMessageInTransaction: vi.fn(
    async (_tx: unknown, input: { clientNonce?: string }) => ({
      id: input.clientNonce?.startsWith("reflect-status:") ? "status-message" : "card",
    }),
  ),
  recordUsage: vi.fn(async () => undefined),
  runAsTenant: vi.fn(
    async (_tenant: { spaceId: string; userId: string }, work: () => Promise<unknown>) => work(),
  ),
}));

const RUN = {
  id: "run-1",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
  userId: "user-1",
  status: "completed",
  trigger: "user",
  error: null,
  completedAt: new Date("2026-11-17T10:00:00.000Z"),
  taskId: "task-1",
  routineId: null,
  sourceMessageId: "message-source",
  tainted: false,
  learningSourceChecked: true,
  thread: { groupId: null, externalConversationId: null },
};

const SOURCE_MESSAGE = {
  id: "message-source",
  threadId: "thread-1",
  role: "user",
  authorUserId: "user-1",
};

const DRAFT = {
  name: "Compare Venues",
  goal: "Compare event venues and return a shortlist with prices.",
  playbook: {
    whenToUse: "When the user asks to compare venues.",
    inputs: ["city", "budget"],
    steps: [
      "Search the web for candidate venues.",
      "Collect each venue's price and capacity.",
      "Return the three best options.",
    ],
    howToCheck: "Every option has a price and a capacity.",
    whatToReturn: "A shortlist with prices and capacities.",
    approvalBoundaries: "Do not book or pay for anything without approval.",
    failureHandling: "If nothing fits the budget, say so and ask what to relax.",
  },
};

const LESSON = {
  cue: "Comparing venues in Lisbon",
  lesson: "Check capacity before price for large groups.",
  evidence: { kind: "tool_error" as const, quote: "venues search timed out" },
};

type HarnessOptions = {
  output?: string;
  taskPrompt?: string;
  finalReply?: string;
  status?: string;
  error?: string | null;
  tainted?: boolean;
  learningSourceChecked?: boolean;
  feedback?: Array<{ id: string; text: string }>;
  trigger?: string;
  routineId?: string | null;
  thread?: { groupId: string | null; externalConversationId: string | null };
  sourceMessage?: typeof SOURCE_MESSAGE | null;
  drafts?: unknown[];
  managedFacts?: boolean | null;
  steering?: Array<{ id: string; text: string }>;
  denials?: Array<{ kind: string; reviewDecision: string | null; reviewReason: string | null }>;
  toolEvents?: Array<{ type: string; payload: unknown }>;
  savedLessons?: Array<{ id: string; revision: number; content: string; updatedAt: string }>;
};

/** Three failed calls, the point where a run counts as a tool-error signal. */
function failedToolEvents(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    type: "agent.tool.completed",
    payload: {
      name: "web_search",
      executionId: `call-${index + 1}`,
      outcome: "error",
      error: "venues search timed out",
    },
  }));
}

function managedProvider() {
  return {
    provider: {
      describe: () => ({
        id: "local-memory",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: {
          recall: true,
          save: true,
          purgeHistory: true,
          sharedScope: true,
          managedFacts: true,
        },
      }),
    },
    defaultScope: "isolated",
  };
}

function harness(options: HarnessOptions = {}) {
  const output = options.output ?? JSON.stringify({ lessons: [], skill: DRAFT });
  const runtimeRun = vi.fn<AgentRuntime["run"]>(async function* (request: AgentRunRequest) {
    await request.onUsage?.({
      type: "usage",
      provider: "openai-compatible",
      model: "route/model",
      inputTokens: 100,
      outputTokens: 50,
      accounted: true,
    });
    yield { type: "text", text: output };
    yield { type: "done", text: output };
  });
  const runtime = {
    describe: () => ({
      id: "test-runtime",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: true, tools: false, scripted: false },
    }),
    run: runtimeRun,
  };
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "skill-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    name: args.data.name as string,
    goal: args.data.goal as string,
    status: "draft",
    playbook: args.data.playbook,
    recording: args.data.recording,
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: new Date("2026-11-17T10:01:00.000Z"),
    updatedAt: new Date("2026-11-17T10:01:00.000Z"),
  }));
  let statusMessage: { id: string } | null = null;
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(
        async (args: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          args.where.threadId_clientNonce.clientNonce.startsWith("reflect-status:")
            ? statusMessage
            : null,
      ),
      update: vi.fn(async (args: { where: { id: string }; data: { blocks: unknown } }) => args),
    },
    event: { findMany: vi.fn(async () => []) },
  };
  vi.mocked(createThreadMessageInTransaction).mockImplementation(
    async (_tx: unknown, input: { clientNonce?: string }) => {
      if (input.clientNonce?.startsWith("reflect-status:")) {
        statusMessage = { id: "status-message" };
        return { id: "status-message" } as never;
      }
      return { id: "card" } as never;
    },
  );
  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({
        ...RUN,
        status: options.status ?? RUN.status,
        error: options.error !== undefined ? options.error : RUN.error,
        tainted: options.tainted ?? RUN.tainted,
        learningSourceChecked: options.learningSourceChecked ?? RUN.learningSourceChecked,
        trigger: options.trigger ?? RUN.trigger,
        routineId: options.routineId !== undefined ? options.routineId : RUN.routineId,
        thread: options.thread ?? RUN.thread,
      })),
    },
    task: {
      findUnique: vi.fn(async () => ({
        prompt: options.taskPrompt ?? "compare three venues in Lisbon",
      })),
    },
    message: {
      findMany: vi.fn(async (args: { where: { role?: string; authorUserId?: string } }) =>
        args.where.role === "user"
          ? ((args.where.authorUserId ? options.feedback : options.steering) ?? []).map(
              ({ id, text }) => ({
                id,
                blocks: [{ kind: "text", text }],
              }),
            )
          : [
              {
                seq: 5,
                role: "bot",
                blocks: [
                  { kind: "text", text: options.finalReply ?? "Three venues fit the budget." },
                ],
              },
            ],
      ),
      findFirst: vi.fn(async () => ({
        blocks: [{ kind: "text", text: "next time skip the paid ones" }],
      })),
      findUnique: vi.fn(async () =>
        options.sourceMessage === null ? null : (options.sourceMessage ?? SOURCE_MESSAGE),
      ),
    },
    event: {
      findMany: vi.fn(async ({ where }: { where: { type: unknown } }) =>
        where.type === "run.steering.claimed"
          ? [{ payload: { userMessageIds: (options.steering ?? []).map(({ id }) => id) } }]
          : (options.toolEvents ?? [
              { type: "agent.tool.called", payload: { name: "web_search", executionId: "call-1" } },
              {
                type: "agent.tool.completed",
                payload: {
                  name: "web_search",
                  executionId: "call-1",
                  durationMs: 1200,
                  outcome: "succeeded",
                },
              },
            ]),
      ),
    },
    externalEffect: { findMany: vi.fn(async () => options.denials ?? []) },
    taughtSkill: {
      findFirst: vi.fn(async () => (options.drafts ?? [])[0] ?? null),
      findMany: vi.fn(async () => []),
      create,
      delete: vi.fn(async () => ({})),
    },
    agentSkill: { findMany: vi.fn(async () => []) },
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const events = { notify: vi.fn(async () => undefined) };
  const resolveModel = vi.fn(async () => ({
    provider: "openai-compatible",
    id: "route/model",
    apiKey: "test-key",
  }));
  const saveLesson = vi.fn(
    async (_input: unknown, _context: unknown) => ({ id: "lesson-1", revision: 1 }) as never,
  );
  const list = vi.fn(
    async () =>
      ({
        supported: true,
        items: options.savedLessons ?? [],
        nextCursor: null,
      }) as never,
  );
  const store: ReflectionLessonStore = { saveLesson, list };
  const managedFacts = options.managedFacts === undefined ? true : options.managedFacts;
  const memoryProviders = {
    resolve: vi.fn(async () => (managedFacts === null ? null : managedProvider())),
  };
  return {
    deps: {
      prisma: prisma as never,
      runtime: runtime as unknown as AgentRuntime,
      events: events as never,
      resolveModel,
      memoryProviders: managedFacts === null ? undefined : (memoryProviders as never),
      store,
    },
    prisma,
    runtime,
    runtimeRun,
    create,
    events,
    saveLesson,
    list,
    tx,
  };
}

const originalSelfEvolution = process.env.SELF_EVOLUTION;

beforeEach(() => {
  process.env.SELF_EVOLUTION = "1";
  installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
});

afterEach(() => {
  if (originalSelfEvolution === undefined) delete process.env.SELF_EVOLUTION;
  else process.env.SELF_EVOLUTION = originalSelfEvolution;
});

describe("parseReflection", () => {
  it("reads JSON inside fences and surrounding prose", () => {
    const parsed = parseReflection(
      `Here is the draft:\n\`\`\`json\n${JSON.stringify({ lessons: [], skill: DRAFT })}\n\`\`\``,
    );
    expect(parsed).toEqual({ draft: DRAFT, lessons: [] });
  });

  it("returns null when there is no JSON object", () => {
    expect(parseReflection("I could not think of anything.")).toBeNull();
    expect(parseReflection('{"name": "x"')).toBeNull();
  });

  it("clamps lessons and drops a malformed replacement", () => {
    const parsed = parseReflection(
      JSON.stringify({
        lessons: [
          {
            cue: "c".repeat(300),
            lesson: "l".repeat(900),
            evidence: { kind: "run_failed", quote: "q".repeat(400) },
            replaces: { id: "lesson-1", revision: 0 },
          },
          { cue: "second", lesson: "kept", evidence: { kind: "user_steering", quote: "sorry" } },
          { cue: "third", lesson: "over the cap" },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      lessons: [
        {
          cue: "c".repeat(200),
          lesson: "l".repeat(600),
          evidence: { kind: "run_failed", quote: "q".repeat(300) },
        },
        { cue: "second", lesson: "kept" },
      ],
    });
    if (!parsed || "skip" in parsed) throw new Error("expected parsed lessons");
    expect(parsed.lessons[0]?.replaces).toBeUndefined();
    expect(parsed.lessons).toHaveLength(2);
  });

  it("caps every skill field and its inputs", () => {
    const parsed = parseReflection(
      JSON.stringify({
        lessons: [],
        skill: {
          ...DRAFT,
          playbook: {
            ...DRAFT.playbook,
            whenToUse: "w".repeat(900),
            inputs: Array.from({ length: 20 }, (_, index) => `${index}-${"i".repeat(300)}`),
          },
        },
      }),
    );
    const draft = (parsed as { draft: typeof DRAFT }).draft;
    expect(draft.playbook.whenToUse).toHaveLength(600);
    expect(draft.playbook.inputs).toHaveLength(12);
    expect(draft.playbook.inputs[0]).toHaveLength(200);
  });
});

describe("verifyLessonEvidence", () => {
  it("accepts a quote copied from a shown line and rejects an invented one", () => {
    const sources = [
      "The venues search timed out",
      "- web_search → error (900 ms): venues search timed out",
    ];
    expect(verifyLessonEvidence("venues search timed out", sources)).toBe(true);
    expect(verifyLessonEvidence("the user asked to cancel", sources)).toBe(false);
  });

  it("accepts escaped text the reviewer saw", () => {
    expect(verifyLessonEvidence("a &lt; b", ["a < b"])).toBe(true);
  });
});

describe("reflectRun", () => {
  it("does nothing at all when self-evolution is off", async () => {
    process.env.SELF_EVOLUTION = "off";
    const h = harness();
    await reflectRun(h.deps, { runId: "run-1" });
    expect(h.runtimeRun).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.prisma.run.findUnique).not.toHaveBeenCalled();
  });

  it("treats the reviewer's skip as a normal no-op", async () => {
    const h = harness({ output: '{"skip": true, "reason": "one-off answer"}' });
    await reflectRun(h.deps, { runId: "run-1" });
    expect(h.runtimeRun).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.saveLesson).not.toHaveBeenCalled();
    // The status line still starts and finishes.
    expect(h.events.notify).toHaveBeenCalledTimes(2);
  });

  it("creates one draft skill card from the run's evidence", async () => {
    const h = harness({
      output: `Draft:\n\`\`\`json\n${JSON.stringify({ lessons: [], skill: DRAFT })}\n\`\`\`\nDone.`,
    });
    await reflectRun(h.deps, { runId: "run-1" });

    expect(h.runtimeRun).toHaveBeenCalledOnce();
    const [request] = h.runtimeRun.mock.calls[0]!;
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    expect(request.allowSilentEmpty).toBe(true);
    expect(request.model).toEqual({
      provider: "openai-compatible",
      id: "route/model",
      apiKey: "test-key",
    });
    expect(request.prompt).toContain("<run_task>\ncompare three venues in Lisbon\n</run_task>");
    expect(request.prompt).toContain("- web_search → succeeded (1200 ms)");
    expect(request.prompt).toContain("<final_reply>\nThree venues fit the budget.\n</final_reply>");
    expect(request.prompt).toContain("<user_feedback>\n(none)\n</user_feedback>");
    expect(request.prompt).toContain('<run_outcome status="completed"></run_outcome>');
    expect(request.prompt).toContain("<skill_requested>true</skill_requested>");
    expect(request.instructions).toContain("language of the run task");

    expect(h.create).toHaveBeenCalledOnce();
    const data = h.create.mock.calls[0]![0].data;
    expect(data.id).toBe("reflect-run-1");
    expect(data).toMatchObject({
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      name: DRAFT.name,
      goal: DRAFT.goal,
      status: "draft",
      playbook: DRAFT.playbook,
    });
    expect(data.recording).toMatchObject({
      events: [],
      snapshots: [],
      evidence: { runIds: ["run-1"], origin: "user", quote: "compare three venues in Lisbon" },
    });

    const [, input] = vi.mocked(createThreadMessageInTransaction).mock.lastCall!;
    expect(input.blocks).toEqual([
      expect.objectContaining({ kind: "skill_draft", skillId: "skill-1", status: "draft" }),
    ]);
    const draftEvent = vi
      .mocked(appendEventInTransaction)
      .mock.calls.map(([, appended]) => appended)
      .find((appended) => (appended as { type?: string }).type === "skill.draft.created");
    expect(draftEvent).toMatchObject({
      type: "skill.draft.created",
      payload: { skillId: "skill-1", name: DRAFT.name },
    });
    expect(vi.mocked(recordUsage)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "usage" }),
      expect.objectContaining({ operationId: "reflect:run-1", operationKind: "learning" }),
    );
  });

  it("passes complete task and reply tails to the reviewer with escaped, source-bound evidence", async () => {
    const taskPrefix = "Synthetic task detail.\n".repeat(120);
    const replyPrefix = "Synthetic reply detail.\n".repeat(300);
    const taskTail = "Boundary case: <late-item> arrives after the first count & must be included.";
    const replyTail =
      "Boundary claim: <late-item> will never affect the accumulated count & total.";
    const correction =
      "Correct the claim about <late-item>: later arrivals affect the accumulated total.";
    const h = harness({
      taskPrompt: `  \n${taskPrefix}${taskTail}\n  `,
      finalReply: `  \n${replyPrefix}${replyTail}\n  `,
      feedback: [{ id: "boundary-correction", text: correction }],
      output: JSON.stringify({
        lessons: [
          {
            cue: "Counting late arrivals",
            lesson: "Include late arrivals when checking the final accumulated total.",
            evidence: { kind: "user_feedback", quote: correction, messageId: "made-up" },
          },
        ],
        skill: DRAFT,
      }),
    });

    await reflectRun(h.deps, { runId: "run-1" });

    expect(h.runtimeRun).toHaveBeenCalledOnce();
    const [request] = h.runtimeRun.mock.calls[0]!;
    expect(request.prompt).toContain(
      `<run_task>\n${taskPrefix}Boundary case: &lt;late-item&gt; arrives after the first count &amp; must be included.\n</run_task>`,
    );
    expect(request.prompt).toContain(
      `<final_reply>\n${replyPrefix}Boundary claim: &lt;late-item&gt; will never affect the accumulated count &amp; total.\n</final_reply>`,
    );
    expect(request.prompt).toContain(
      "<user_feedback>\nCorrect the claim about &lt;late-item&gt;: later arrivals affect the accumulated total.\n</user_feedback>",
    );
    expect(h.saveLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({
          runId: "run-1",
          threadId: "thread-1",
          harness: expect.objectContaining({
            evidence: {
              kind: "user_feedback",
              quote: correction,
              messageId: "boundary-correction",
            },
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("saves a clean owner's lesson automatically and shows no card", async () => {
    const h = harness({
      output: JSON.stringify({ lessons: [LESSON], skill: null }),
      toolEvents: failedToolEvents(),
    });
    await reflectRun(h.deps, { runId: "run-1" });

    expect(h.saveLesson).toHaveBeenCalledOnce();
    const [input] = h.saveLesson.mock.calls[0]!;
    expect(input).toMatchObject({
      botId: "bot-1",
      cue: LESSON.cue,
      lesson: LESSON.lesson,
      provenance: {
        kind: "run",
        runId: "run-1",
        threadId: "thread-1",
        harness: {
          domainKey: "research",
          signals: ["tool_error"],
          autoApplied: true,
          evidence: LESSON.evidence,
        },
      },
    });
    const cardCalls = vi
      .mocked(createThreadMessageInTransaction)
      .mock.calls.filter(([, input]) => input.clientNonce?.startsWith("reflect-lesson:"));
    expect(cardCalls).toHaveLength(0);
  });

  it("passes a valid replacement through to the host store", async () => {
    const h = harness({
      output: JSON.stringify({
        lessons: [{ ...LESSON, replaces: { id: "lesson-9", revision: 4 } }],
      }),
      toolEvents: [
        {
          type: "agent.tool.completed",
          payload: {
            name: "web_search",
            executionId: "call-1",
            outcome: "error",
            error: "venues search timed out",
          },
        },
      ],
    });
    await reflectRun(h.deps, { runId: "run-1" });
    expect(h.saveLesson).toHaveBeenCalledWith(
      expect.objectContaining({ replaces: { id: "lesson-9", expectedRevision: 4 } }),
      expect.anything(),
    );
  });

  it("leaves a card instead of a lesson when the run read outside content", async () => {
    const h = harness({
      output: JSON.stringify({
        lessons: [{ ...LESSON, replaces: { id: "old", revision: 4 } }],
        skill: null,
      }),
      tainted: true,
      toolEvents: [
        {
          type: "agent.tool.completed",
          payload: {
            name: "web_search",
            executionId: "call-1",
            outcome: "error",
            error: "venues search timed out",
          },
        },
      ],
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });

    expect(h.saveLesson).not.toHaveBeenCalled();
    const [, card] = vi
      .mocked(createThreadMessageInTransaction)
      .mock.calls.find(([, input]) => input.clientNonce?.startsWith("reflect-lesson:"))!;
    expect(card.blocks).toEqual([
      expect.objectContaining({
        kind: "lesson_draft",
        lessonId: "lesson-draft:run-1:0",
        runId: "run-1",
        cue: LESSON.cue,
        replaces: { id: "old", expectedRevision: 4 },
        domainKey: "research",
        status: "draft",
      }),
    ]);
    expect(card.markUnread).toBe(false);
    // The card the review writes has to survive the thread's own block contract.
    expect(MessageBlock.parse(card.blocks[0])).toEqual(card.blocks[0]);
  });

  it("leaves a card when the run was not started by its owner", async () => {
    const h = harness({
      output: JSON.stringify({ lessons: [LESSON], skill: null }),
      trigger: "routine",
      sourceMessage: { ...SOURCE_MESSAGE, role: "bot" },
      toolEvents: failedToolEvents(),
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.saveLesson).not.toHaveBeenCalled();
    const card = vi
      .mocked(createThreadMessageInTransaction)
      .mock.calls.find(([, input]) => input.clientNonce?.startsWith("reflect-lesson:"));
    expect(card).toBeTruthy();
  });

  it("never drafts a skill for a signal-triggered review", async () => {
    const h = harness({
      output: `Draft:\n\`\`\`json\n${JSON.stringify({ lessons: [], skill: DRAFT })}\n\`\`\``,
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    const [request] = h.runtimeRun.mock.calls[0]!;
    expect(request.prompt).toContain("<skill_requested>false</skill_requested>");
    expect(request.prompt).not.toContain("<user_follow_up>");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("drops a lesson whose quote was never shown", async () => {
    const h = harness({
      output: JSON.stringify({
        lessons: [
          { ...LESSON, evidence: { kind: "tool_error", quote: "the user asked for a refund" } },
        ],
      }),
    });
    await reflectRun(h.deps, { runId: "run-1" });
    expect(h.saveLesson).not.toHaveBeenCalled();
  });

  it("reads the last tool events, newest query first", async () => {
    const h = harness();
    await reflectRun(h.deps, { runId: "run-1" });
    expect(h.prisma.event.findMany).toHaveBeenCalledWith({
      where: { runId: "run-1", type: { in: ["agent.tool.called", "agent.tool.completed"] } },
      orderBy: { seq: "desc" },
      take: 200,
      select: { type: true, payload: true },
    });
  });

  it("reads only linked replies by this owner or the manual request naming this run", async () => {
    const fix = "For this project skip paid venues.";
    const h = harness({
      feedback: [{ id: "message-ask", text: `Review this. ${fix}` }],
      output: JSON.stringify({
        lessons: [
          { ...LESSON, evidence: { kind: "user_feedback", quote: fix, messageId: "made-up" } },
        ],
      }),
    });
    await reflectRun(h.deps, { runId: "run-1", exceptMessageId: "message-ask" });
    expect(h.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          authorUserId: "user-1",
          role: "user",
          OR: [
            {
              threadId: "thread-1",
              replyTo: { is: { threadId: "thread-1", runId: "run-1", role: "bot" } },
            },
            {
              threadId: "thread-1",
              id: "message-ask",
              createdAt: { gte: RUN.completedAt },
              replyToMessageId: null,
            },
          ],
        },
      }),
    );
    expect(h.saveLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({
          harness: expect.objectContaining({
            evidence: { kind: "user_feedback", quote: fix, messageId: "message-ask" },
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("treats a dislike as a signal without inventing its reason, even after an earlier skill", async () => {
    const h = harness({
      drafts: [{ id: "prior", status: "saved", name: "Prior" }],
      feedback: [{ id: "reaction", text: "👎" }],
      output: JSON.stringify({
        lessons: [{ ...LESSON, evidence: { kind: "user_feedback", quote: "👎" } }],
        skill: DRAFT,
      }),
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.runtimeRun.mock.calls[0]![0].prompt).toContain("<review_signals>\nuser_disliked\n");
    expect(h.saveLesson).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("does not misattribute tool output to the user's feedback", async () => {
    const h = harness({
      toolEvents: failedToolEvents(),
      output: JSON.stringify({
        lessons: [{ ...LESSON, evidence: { ...LESSON.evidence, kind: "user_feedback" } }],
      }),
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.saveLesson).not.toHaveBeenCalled();
  });

  it("does not teach a reason from a reaction claimed as steering", async () => {
    const h = harness({
      steering: [{ id: "reaction", text: "👎" }],
      output: JSON.stringify({
        lessons: [{ ...LESSON, evidence: { kind: "user_steering", quote: "👎" } }],
      }),
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.saveLesson).not.toHaveBeenCalled();
  });

  it("does not reuse errors that disappeared from the rendered tool history", async () => {
    const error = failedToolEvents(1)[0]!;
    const h = harness({
      // The query returns newest first. These failures belong to one replayed execution.
      toolEvents: [
        { ...error, payload: { ...error.payload, outcome: "succeeded" } },
        error,
        error,
        error,
      ],
      output: JSON.stringify({ lessons: [LESSON] }),
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.runtimeRun.mock.calls[0]![0].prompt).toContain("<review_signals>\n(none)\n");
    expect(h.saveLesson).not.toHaveBeenCalled();
  });

  it("leaves an unchecked historical run for a person even if tainted is false", async () => {
    const h = harness({
      learningSourceChecked: false,
      toolEvents: failedToolEvents(),
      output: JSON.stringify({ lessons: [LESSON] }),
    });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.saveLesson).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(createThreadMessageInTransaction)
        .mock.calls.some(([, r]) => r.clientNonce?.startsWith("reflect-lesson:")),
    ).toBe(true);
  });

  it("shows a failed run's own error as the outcome", async () => {
    const h = harness({
      status: "failed",
      error: "upstream 400 <bad>",
      output: JSON.stringify({ lessons: [LESSON], skill: null }),
      toolEvents: failedToolEvents(),
    });
    await reflectRun(h.deps, { runId: "run-1" });
    const [request] = h.runtimeRun.mock.calls[0]!;
    expect(request.prompt).toContain(
      '<run_outcome status="failed" error="upstream 400 &lt;bad&gt;"></run_outcome>',
    );
    expect(request.prompt).toContain("<review_signals>\nrun_failed, tool_error\n</review_signals>");
  });

  it("offers existing lessons of the same domain first", async () => {
    const h = harness({
      savedLessons: [
        {
          id: "lesson-a",
          revision: 3,
          content: "cue: same domain\nlesson: keep it short",
          updatedAt: "2026-11-17T09:00:00.000Z",
          provenance: { kind: "run", harness: { domainKey: "research" } },
        },
        {
          id: "lesson-b",
          revision: 1,
          content: "cue: other domain\nlesson: greet first",
          updatedAt: "2026-11-17T10:00:00.000Z",
          provenance: { kind: "run", harness: { domainKey: "chat" } },
        },
      ] as never,
    });
    await reflectRun(h.deps, { runId: "run-1" });
    const [request] = h.runtimeRun.mock.calls[0]!;
    const block = request.prompt.slice(
      request.prompt.indexOf("<existing_lessons>"),
      request.prompt.indexOf("</existing_lessons>"),
    );
    expect(block).toContain("- lesson-a · r3 · research · same domain → keep it short");
    expect(block).toContain("- lesson-b · r1 · chat · other domain → greet first");
    expect(block.indexOf("lesson-a")).toBeLessThan(block.indexOf("lesson-b"));
  });

  it("skips lessons entirely without a managed memory provider", async () => {
    const h = harness({ managedFacts: null });
    await reflectRun(h.deps, { runId: "run-1" });
    const [request] = h.runtimeRun.mock.calls[0]!;
    expect(request.prompt).not.toContain("<existing_lessons>");
    expect(request.instructions).not.toContain("evidence.quote");
    expect(h.create).toHaveBeenCalledOnce();
  });

  it("does not run a signal-triggered review without a lesson surface", async () => {
    const h = harness({ managedFacts: null });
    await reflectRun(h.deps, { runId: "run-1", auto: true });
    expect(h.runtimeRun).not.toHaveBeenCalled();
    expect(h.events.notify).not.toHaveBeenCalled();
  });

  it("skips a run that already produced a skill, saved included", async () => {
    const h = harness({
      drafts: [
        {
          id: "skill-1",
          name: "Compare Venues",
          status: "saved",
          recording: { events: [], snapshots: [], evidence: { runIds: ["run-1"] } },
        },
      ],
    });
    await reflectRun(h.deps, { runId: "run-1" });
    expect(h.runtimeRun).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    // A saved skill still guards its run, so the lookup matches the run id in Postgres without
    // a status or recency filter.
    expect(h.prisma.taughtSkill.findFirst).toHaveBeenCalledWith({
      where: {
        botId: "bot-1",
        recording: { path: ["evidence", "runIds"], array_contains: ["run-1"] },
      },
      select: { id: true, name: true, status: true },
    });
  });

  it("stops quietly when a concurrent review already wrote the draft", async () => {
    const h = harness();
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint"), { code: "P2002" }),
    );
    await expect(reflectRun(h.deps, { runId: "run-1" })).resolves.toBeUndefined();
    const draftEvents = vi
      .mocked(appendEventInTransaction)
      .mock.calls.map(([, appended]) => appended as { type?: string })
      .filter((appended) => appended.type === "skill.draft.created");
    expect(draftEvents).toHaveLength(0);
  });

  it("rejects a run that has not finished, so the job retries once", async () => {
    const h = harness({ status: "running" });
    await expect(reflectRun(h.deps, { runId: "run-1" })).rejects.toThrow(/not finished/);
    expect(h.runtimeRun).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("reports a failed review on the status line and retries", async () => {
    const h = harness({ output: "no draft today" });
    await expect(reflectRun(h.deps, { runId: "run-1" })).rejects.toThrow(/could not parse/);
    expect(h.create).not.toHaveBeenCalled();
    const [update] = h.tx.message.update.mock.calls.at(-1)!;
    expect(update.data.blocks).toEqual([
      {
        kind: "meta",
        text: "Review failed: harness.reflect could not parse a draft for run run-1",
      },
    ]);
  });

  it("deletes the draft row when the card cannot be published", async () => {
    const h = harness();
    // The status line's own transactions never lock the skill row; this rejects only the card.
    h.tx.$executeRaw.mockRejectedValueOnce(new Error("card write failed"));
    await expect(reflectRun(h.deps, { runId: "run-1" })).rejects.toThrow("card write failed");
    expect(h.prisma.taughtSkill.delete).toHaveBeenCalledWith({ where: { id: "skill-1" } });
  });
});
