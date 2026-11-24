import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FILE_DELIVERY_PLAYBOOKS } from "./fixtures/work-improvement.js";
import { taughtSkillPlaybookHash as storedPlaybookHash } from "./taught-skill-revisions.js";
import {
  capabilityToolName,
  prepareWorkImprovementComponents,
  workImprovementComponentHash,
  workImprovementComponentPrompt,
  workImprovementComponentReceipts,
  workImprovementTaughtSkillPlaybookHash,
} from "./work-improvement-components.js";

const runtime = { scripted: false, tools: true };

describe("work-improvement components", () => {
  it("maps only the two production read-only capabilities", () => {
    expect(capabilityToolName("isolated.snapshot.read_file")).toBe("read_file");
    expect(capabilityToolName("isolated.snapshot.list_files")).toBe("list_files");
    expect(capabilityToolName("isolated.snapshot.write_file")).toBeUndefined();
    expect(capabilityToolName("read_file")).toBeUndefined();
  });

  it("keeps the taught-skill playbook hash and component hashes stable", () => {
    const playbook = FILE_DELIVERY_PLAYBOOKS.candidate.playbook;
    const component = {
      id: "guidance",
      revision: "2",
      kind: "task_guidance" as const,
      text: "Compare exact paths.",
    };
    expect(workImprovementTaughtSkillPlaybookHash(playbook)).toBe(storedPlaybookHash(playbook));
    expect(workImprovementComponentHash(component)).toBe(
      workImprovementComponentHash(structuredClone(component)),
    );
    expect(workImprovementComponentHash({ ...component, revision: "3" })).not.toBe(
      workImprovementComponentHash(component),
    );
    expect(workImprovementComponentHash({ ...component, text: "Compare every path." })).not.toBe(
      workImprovementComponentHash(component),
    );
  });

  it("limits component-selected tools to registered capabilities and applies tool guidance", () => {
    const set = {
      schemaVersion: "improvement-components.v1" as const,
      items: [
        {
          id: "reader",
          revision: "1",
          kind: "plugin" as const,
          capabilityId: "isolated.snapshot.read_file",
        },
        {
          id: "listing",
          revision: "4",
          kind: "plugin" as const,
          capabilityId: "isolated.snapshot.list_files",
        },
        {
          id: "listing-guidance",
          revision: "2",
          kind: "tool_guidance" as const,
          capabilityId: "isolated.snapshot.list_files",
          text: "List the complete installed tree.",
        },
      ],
    };
    const plan = prepareWorkImprovementComponents(set, runtime);
    const tools = plan.tools as ConnectorTool[];
    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "list_files"]);
    expect(tools[1]!.description).toContain("List the complete installed tree.");
    expect(plan.components.every((item) => !item.unsupported)).toBe(true);
    expect(
      prepareWorkImprovementComponents(
        {
          schemaVersion: "improvement-components.v1",
          items: [
            {
              id: "unknown",
              revision: "1",
              kind: "plugin",
              capabilityId: "isolated.snapshot.not-installed",
            },
          ],
        },
        runtime,
      ).components[0]!.unsupported,
    ).toBe(true);
  });

  it("requires observed script output and a real plugin invocation for qualifying receipts", () => {
    const set = {
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
          revision: "2",
          kind: "script" as const,
          language: "tool-sequence.v1" as const,
          steps: [
            {
              capabilityId: "isolated.snapshot.read_file",
              input: { path: "request.json" },
            },
          ],
        },
      ],
    };
    const plan = prepareWorkImprovementComponents(set, runtime);
    const scriptExecutionId = "trial:component:script:0";
    const execution = {
      executionId: scriptExecutionId,
      name: "read_file",
      status: "succeeded" as const,
      result: { path: "request.json", content: "synthetic" },
    };
    const receipts = workImprovementComponentReceipts({
      plan,
      runId: "trial",
      skillRevision: "skill-rev-2",
      skillHash: "a".repeat(64),
      instructionsHash: "b".repeat(64),
      runtimeInvoked: true,
      executions: [execution],
      scriptExecutionIds: new Map([["script", [scriptExecutionId]]]),
    });
    expect(receipts.map((receipt) => receipt.status)).toEqual(["loaded", "executed"]);
    expect(receipts[1]!.executions[0]).toMatchObject({
      executionId: scriptExecutionId,
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedByRuntime: true,
    });

    const unloaded = workImprovementComponentReceipts({
      plan,
      runId: "trial-2",
      skillRevision: "skill-rev-2",
      skillHash: "a".repeat(64),
      instructionsHash: "b".repeat(64),
      runtimeInvoked: true,
      executions: [],
      scriptExecutionIds: new Map(),
    });
    expect(unloaded.map((receipt) => receipt.status)).toEqual(["unexecuted", "unexecuted"]);

    expect(
      workImprovementComponentPrompt(plan, [
        {
          componentId: "script",
          executions: [
            {
              executionId: scriptExecutionId,
              capabilityId: "isolated.snapshot.read_file",
              status: "succeeded",
              result: execution.result,
            },
          ],
        },
      ]),
    ).toMatchObject({
      scriptOutputs: [
        {
          componentId: "script",
          executions: [{ result: { content: "synthetic" } }],
        },
      ],
    });
  });
});
