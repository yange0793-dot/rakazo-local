import { createHash } from "node:crypto";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import type {
  ImprovementComponent,
  ImprovementComponentReceipt,
  ImprovementComponentSet,
  SkillPlaybook,
} from "@rakazo/contracts";
import { ImprovementComponentReceiptSchema } from "@rakazo/contracts";

const TOOL_ADAPTER = {
  id: "work-improvement-isolated-tools",
  contractVersion: "1",
  adapterVersion: "1",
} as const;

/** Production can only bind these existing read-only builtins. */
export function capabilityToolName(capabilityId: string): "read_file" | "list_files" | undefined {
  switch (capabilityId) {
    case "isolated.snapshot.read_file":
      return "read_file";
    case "isolated.snapshot.list_files":
      return "list_files";
    default:
      return undefined;
  }
}

interface RegisteredCapability {
  id: string;
  tool: ConnectorTool;
}

const registeredCapabilities: RegisteredCapability[] = [
  {
    id: "isolated.snapshot.read_file",
    tool: {
      name: "read_file",
      readOnly: true,
      description:
        "Read one file in this isolated snapshot; returns content, SHA-256 and byte size.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    id: "isolated.snapshot.list_files",
    tool: {
      name: "list_files",
      readOnly: true,
      description:
        "Recursively list actual files in this isolated snapshot with SHA-256 and byte size. The root path is an empty string.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

interface PreparedComponent {
  component: ImprovementComponent;
  hash: string;
  unsupported: boolean;
  capabilities: RegisteredCapability[];
}

export interface WorkImprovementComponentPlan {
  components: PreparedComponent[];
  tools: ConnectorTool[];
  scripts: Array<Extract<ImprovementComponent, { kind: "script" }>>;
  legacyTools: boolean;
}

export interface WorkImprovementComponentExecution {
  executionId: string;
  name: string;
  status: "succeeded" | "denied" | "error";
  result: unknown;
}

export type WorkImprovementCapability = RegisteredCapability;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function workImprovementTaughtSkillPlaybookHash(playbook: SkillPlaybook): string {
  const {
    whenToUse,
    inputs,
    steps,
    howToCheck,
    whatToReturn,
    approvalBoundaries,
    failureHandling,
  } = playbook;
  return sha256(
    JSON.stringify({
      whenToUse,
      inputs,
      steps,
      howToCheck,
      whatToReturn,
      approvalBoundaries,
      failureHandling,
    }),
  );
}

export function workImprovementComponentHash(component: ImprovementComponent): string {
  return sha256(canonical(component));
}

function capabilityReceipt(capability: RegisteredCapability, offeredTool: ConnectorTool) {
  return {
    id: capability.id,
    adapterId: TOOL_ADAPTER.id,
    contractVersion: TOOL_ADAPTER.contractVersion,
    adapterVersion: TOOL_ADAPTER.adapterVersion,
    schemaHash: sha256(canonical(capability.tool.inputSchema)),
    toolHash: sha256(canonical(offeredTool)),
  };
}

function registered(id: string): RegisteredCapability | undefined {
  return registeredCapabilities.find((capability) => capability.id === id);
}

export function prepareWorkImprovementComponents(
  set: ImprovementComponentSet | undefined,
  runtime: { scripted: boolean; tools: boolean },
): WorkImprovementComponentPlan {
  if (!set) {
    return {
      components: [],
      tools: registeredCapabilities.map(({ tool }) => structuredClone(tool)),
      scripts: [],
      legacyTools: true,
    };
  }

  const selected = new Map<string, RegisteredCapability>();
  const prepared = set.items.map((component): PreparedComponent => {
    const capabilities: RegisteredCapability[] = [];
    let unsupported = runtime.scripted;

    if (component.kind === "plugin") {
      const capability = registered(component.capabilityId);
      if (capability) capabilities.push(capability);
      if (!capability || !runtime.tools) unsupported = true;
      else selected.set(capability.id, capability);
    } else if (component.kind === "tool_guidance") {
      const capability = registered(component.capabilityId);
      if (capability) capabilities.push(capability);
      if (!capability || !runtime.tools) unsupported = true;
    } else if (component.kind === "script") {
      for (const step of component.steps) {
        const capability = registered(step.capabilityId);
        if (capability && !capabilities.some(({ id }) => id === capability.id))
          capabilities.push(capability);
        if (!capability || !runtime.tools) unsupported = true;
      }
    }

    return {
      component,
      hash: workImprovementComponentHash(component),
      unsupported,
      capabilities,
    };
  });

  for (const item of prepared) {
    if (item.component.kind === "tool_guidance" && !selected.has(item.component.capabilityId))
      item.unsupported = true;
    if (
      item.component.kind === "script" &&
      item.component.steps.some((step) => !selected.has(step.capabilityId))
    )
      item.unsupported = true;
  }

  const toolGuidance = new Map<string, string[]>();
  for (const item of prepared) {
    if (item.component.kind !== "tool_guidance" || item.unsupported) continue;
    const fragments = toolGuidance.get(item.component.capabilityId) ?? [];
    fragments.push(item.component.text);
    toolGuidance.set(item.component.capabilityId, fragments);
  }

  const tools = [...selected.values()].map(({ id, tool }) => {
    const guidance = toolGuidance.get(id);
    return {
      ...structuredClone(tool),
      ...(guidance
        ? { description: `${tool.description}\n\nCandidate guidance: ${guidance.join("\n")}` }
        : {}),
    };
  });

  return {
    components: prepared,
    tools,
    scripts: prepared
      .filter(
        (
          item,
        ): item is PreparedComponent & {
          component: Extract<ImprovementComponent, { kind: "script" }>;
        } => item.component.kind === "script" && !item.unsupported,
      )
      .map((item) => item.component),
    legacyTools: false,
  };
}

export function workImprovementPlanCapability(
  plan: WorkImprovementComponentPlan,
  capabilityId: string,
): WorkImprovementCapability | undefined {
  const capability = registered(capabilityId);
  return capability && plan.tools.some((tool) => tool.name === capability.tool.name)
    ? capability
    : undefined;
}

export function workImprovementComponentPrompt(
  plan: WorkImprovementComponentPlan,
  scriptOutputs: Array<{
    componentId: string;
    executions: Array<{
      executionId: string;
      capabilityId: string;
      status: WorkImprovementComponentExecution["status"];
      result: unknown;
    }>;
  }>,
): unknown {
  if (plan.legacyTools) return undefined;
  return {
    guidance: plan.components
      .filter(
        (
          item,
        ): item is PreparedComponent & {
          component: Extract<ImprovementComponent, { kind: "task_guidance" | "system_strategy" }>;
        } =>
          !item.unsupported &&
          (item.component.kind === "task_guidance" || item.component.kind === "system_strategy"),
      )
      .map(({ component, hash }) => ({
        kind: component.kind,
        id: component.id,
        revision: component.revision,
        hash,
        text: component.text,
      })),
    scriptOutputs,
  };
}

export function workImprovementComponentReceipts(input: {
  plan: WorkImprovementComponentPlan;
  runId: string;
  skillRevision: string;
  skillHash: string;
  instructionsHash: string;
  runtimeInvoked: boolean;
  executions: WorkImprovementComponentExecution[];
  scriptExecutionIds: Map<string, string[]>;
}): ImprovementComponentReceipt[] {
  return input.plan.components.map(({ component, hash, unsupported, capabilities }) => {
    const capabilityIds = new Set(capabilities.map(({ id }) => id));
    const scriptExecutionIds =
      component.kind === "script"
        ? new Set(input.scriptExecutionIds.get(component.id) ?? [])
        : undefined;
    const executions = input.executions
      .filter(
        (execution) =>
          capabilities.some(({ tool }) => tool.name === execution.name) &&
          (!scriptExecutionIds || scriptExecutionIds.has(execution.executionId)),
      )
      .map((execution) => {
        const capability = capabilities.find(({ tool }) => tool.name === execution.name)!;
        return {
          executionId: execution.executionId,
          capabilityId: capability.id,
          status: execution.status,
          outputHash: sha256(canonical(execution.result)),
          observedByRuntime: input.runtimeInvoked && execution.status !== "denied",
        };
      });

    let status: ImprovementComponentReceipt["status"];
    if (unsupported) status = "unsupported";
    else if (component.kind === "task_guidance" || component.kind === "system_strategy") {
      status = input.runtimeInvoked ? "applied" : "unexecuted";
    } else if (component.kind === "tool_guidance") {
      status = input.runtimeInvoked ? "applied" : "unexecuted";
    } else if (component.kind === "plugin") {
      status =
        input.runtimeInvoked && executions.some((execution) => execution.status !== "denied")
          ? "loaded"
          : "unexecuted";
    } else {
      const plannedIds = input.scriptExecutionIds.get(component.id) ?? [];
      status =
        input.runtimeInvoked &&
        plannedIds.length === component.steps.length &&
        plannedIds.every((executionId) =>
          executions.some(
            (execution) =>
              execution.executionId === executionId &&
              execution.status !== "denied" &&
              execution.observedByRuntime,
          ),
        )
          ? "executed"
          : "unexecuted";
    }

    return ImprovementComponentReceiptSchema.parse({
      schemaVersion: "improvement-component-receipt.v1",
      componentId: component.id,
      componentRevision: component.revision,
      componentKind: component.kind,
      componentHash: hash,
      status,
      runId: input.runId,
      skillRevision: input.skillRevision,
      skillHash: input.skillHash,
      instructionsHash: input.instructionsHash,
      capabilities: [...capabilityIds]
        .map((id) => registered(id))
        .filter((capability): capability is RegisteredCapability => capability !== undefined)
        .map((capability) =>
          capabilityReceipt(
            capability,
            input.plan.tools.find((tool) => tool.name === capability.tool.name) ?? capability.tool,
          ),
        ),
      executions,
    });
  });
}
