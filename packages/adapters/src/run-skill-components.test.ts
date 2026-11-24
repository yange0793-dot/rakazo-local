import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { FILE_DELIVERY_PLAYBOOKS } from "./fixtures/work-improvement.js";
import { runSkillComponents } from "./run-skill-components.js";
import type { TaughtSkillRevision } from "./taught-skill-revisions.js";

const set = {
  schemaVersion: "improvement-components.v1" as const,
  items: [
    {
      id: "task",
      revision: "2",
      kind: "task_guidance" as const,
      text: "Inspect all listed paths.",
    },
    {
      id: "strategy",
      revision: "1",
      kind: "system_strategy" as const,
      text: "Keep missing evidence unknown.",
    },
    {
      id: "reader",
      revision: "3",
      kind: "plugin" as const,
      capabilityId: "isolated.snapshot.read_file",
    },
    {
      id: "listing",
      revision: "1",
      kind: "plugin" as const,
      capabilityId: "isolated.snapshot.list_files",
    },
    {
      id: "read-guidance",
      revision: "4",
      kind: "tool_guidance" as const,
      capabilityId: "isolated.snapshot.read_file",
      text: "Read the receipt before concluding.",
    },
    {
      id: "prefetch",
      revision: "2",
      kind: "script" as const,
      language: "tool-sequence.v1" as const,
      steps: [
        {
          capabilityId: "isolated.snapshot.list_files",
          input: { path: "installed" },
        },
        {
          capabilityId: "isolated.snapshot.read_file",
          input: { path: "upload.json" },
        },
      ],
    },
  ],
};

const revision = {
  id: "pinned-revision-7",
  snapshot: {
    name: "Verify delivery",
    goal: "Verify a retained package.",
    playbook: FILE_DELIVERY_PLAYBOOKS.candidate.playbook,
    components: set,
    scope: {},
  },
} as TaughtSkillRevision;

const tool = (name: string, route?: ConnectorTool["route"]): ConnectorTool => ({
  name,
  description: `Real ${name} description`,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: name === "read_file" ? 1 : 0 } },
    required: ["path"],
  },
  ...(route ? { route } : {}),
});

const attempt = {
  runId: "active-run",
  attemptId: "attempt-1",
  phase: "before_model",
  runtimeCapabilities: { tools: true, scripted: false },
} as const;

describe("run skill components", () => {
  it("uses the pinned component set and actual offered read tools", async () => {
    const offeredTools = [
      tool("read_file"),
      tool("list_files"),
      tool("write_file"),
      tool("read_file", { connectorId: "fixture", toolName: "read_file" }),
    ];
    const executeTool = vi.fn(
      async (name: string, args: Record<string, unknown>, executionId: string) => ({
        kind: "agent_tool_result" as const,
        content: [],
        details: { name, args, executionId, observation: "synthetic file result ".repeat(1_000) },
      }),
    );
    const result = await runSkillComponents({
      ...attempt,
      revision,
      instructions: "Fixed host instructions.",
      offeredTools,
      executeTool,
      capabilityMetadata: {
        "isolated.snapshot.read_file": {
          adapterId: "manifest-adapter",
          contractVersion: "manifest-contract",
          adapterVersion: "manifest-version",
        },
      },
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["list_files", { path: "installed" }],
      ["read_file", { path: "upload.json" }],
    ]);
    expect(JSON.parse(executeTool.mock.calls[0]![2])).toEqual([
      "skill-component",
      "active-run",
      "attempt-1",
      revision.id,
      "prefetch",
      0,
    ]);
    expect(result.instructions).toContain("Fixed host instructions.");
    expect(result.instructions).toContain("untrusted task data");
    expect(result.instructions).toContain("synthetic file result");
    expect(result.instructions).toContain('"truncated":true');
    expect(result.instructions.length).toBeLessThan(12_000);
    expect(result.tools.find((entry) => entry.name === "read_file")?.description).toContain(
      "Read the receipt before concluding.",
    );
    expect(result.tools.find((entry) => entry.name === "write_file")?.description).toBe(
      "Real write_file description",
    );
    expect(
      result.tools.find((entry) => entry.name === "read_file" && entry.route)?.description,
    ).toBe("Real read_file description");
    expect(result.receipts.map((receipt) => receipt.status)).toEqual([
      "applied",
      "applied",
      "loaded",
      "loaded",
      "applied",
      "executed",
    ]);
    expect(result.receipts.every((receipt) => receipt.skillRevision === revision.id)).toBe(true);
    expect(result.receipts.every((receipt) => receipt.componentSetHash.length === 64)).toBe(true);
    expect(result.receipts[2]?.capabilities[0]).toMatchObject({
      toolName: "read_file",
      adapterId: "manifest-adapter",
      contractVersion: "manifest-contract",
      adapterVersion: "manifest-version",
    });
    expect(result.receipts[5]?.executions).toHaveLength(2);
    expect(JSON.stringify(result.receipts)).not.toContain("synthetic file result");
    expect(result.eligible).toBe(true);
    expect(result.paused).toBe(false);
  });

  it("puts mid-turn guidance in the tool result and receipts the unchanged tool definition", async () => {
    const offeredTools = [tool("read_file"), tool("list_files")];
    const executeTool = vi.fn(async () => ({ content: "Tool observation." }));
    const result = await runSkillComponents({
      ...attempt,
      phase: "tool_result",
      revision,
      instructions: "",
      offeredTools,
      executeTool,
    });
    const noGuidance = await runSkillComponents({
      ...attempt,
      revision: {
        ...revision,
        snapshot: {
          ...revision.snapshot,
          components: { ...set, items: set.items.filter((item) => item.kind === "plugin") },
        },
      },
      instructions: "",
      offeredTools,
    });
    expect(result.instructions).toContain(
      '"toolGuidance":[{"toolName":"read_file","text":["Read the receipt before concluding."]}]',
    );
    expect(result.tools).toEqual(offeredTools);
    expect(
      result.receipts.find((receipt) => receipt.componentKind === "tool_guidance"),
    ).toMatchObject({
      status: "applied",
      capabilities: noGuidance.receipts.find((receipt) => receipt.componentId === "reader")
        ?.capabilities,
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the tool list on checkpoint resume without replaying scripts or replacing saved instructions", async () => {
    const executeTool = vi.fn();
    const result = await runSkillComponents({
      ...attempt,
      attemptId: "attempt-2",
      phase: "restored_turn",
      revision,
      instructions: "Saved instructions and observations.",
      offeredTools: [tool("read_file"), tool("list_files")],
      executeTool,
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.instructions).toBe("Saved instructions and observations.");
    expect(result.tools[0]?.description).toContain("Read the receipt before concluding.");
    expect(result.receipts.find((receipt) => receipt.componentKind === "script")).toMatchObject({
      status: "unexecuted",
      executions: [],
    });
  });

  it("does not treat a same-named connector as an offered builtin capability", async () => {
    const missing = {
      ...revision,
      snapshot: {
        ...revision.snapshot,
        components: {
          schemaVersion: "improvement-components.v1" as const,
          items: [
            {
              id: "missing",
              revision: "1",
              kind: "plugin" as const,
              capabilityId: "isolated.snapshot.read_file",
            },
          ],
        },
      },
    };
    const result = await runSkillComponents({
      ...attempt,
      revision: missing,
      instructions: "Fixed host instructions.",
      offeredTools: [tool("read_file", { connectorId: "fixture", toolName: "read_file" })],
    });

    expect(result.receipts[0]?.status).toBe("unsupported");
    expect(result.eligible).toBe(false);
  });

  it("stops a script at the existing approval pause without invoking later steps", async () => {
    const scriptRevision = {
      ...revision,
      snapshot: {
        ...revision.snapshot,
        components: {
          schemaVersion: "improvement-components.v1" as const,
          items: [
            {
              id: "reader",
              revision: "1",
              kind: "plugin" as const,
              capabilityId: "isolated.snapshot.read_file",
            },
            {
              id: "script",
              revision: "1",
              kind: "script" as const,
              language: "tool-sequence.v1" as const,
              steps: [
                {
                  capabilityId: "isolated.snapshot.read_file",
                  input: { path: "first.json" },
                },
                {
                  capabilityId: "isolated.snapshot.read_file",
                  input: { path: "second.json" },
                },
              ],
            },
          ],
        },
      },
    };
    const executeTool = vi.fn(async () => approvalPausedToolResult());
    const result = await runSkillComponents({
      ...attempt,
      revision: scriptRevision,
      instructions: "Fixed host instructions.",
      offeredTools: [tool("read_file")],
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledOnce();
    expect(result.paused).toBe(true);
    expect(result.receipts[1]?.status).toBe("unexecuted");
    expect(result.eligible).toBe(false);
  });

  it("keeps legacy playbook-only runs byte-for-byte unchanged", async () => {
    const legacy = {
      ...revision,
      snapshot: { ...revision.snapshot, components: undefined },
    };
    const instructions = "Original instructions.";
    const tools = [tool("read_file")];
    const executeTool = vi.fn();
    const result = await runSkillComponents({
      ...attempt,
      revision: legacy,
      instructions,
      offeredTools: tools,
      executeTool,
    });

    expect(result.instructions).toBe(instructions);
    expect(result.tools).toEqual(tools);
    expect(result.receipts).toEqual([]);
    expect(result.eligible).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
  });
});
