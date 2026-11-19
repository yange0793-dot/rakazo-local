import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolExecutionResult,
  AgentUsage,
} from "@rakazo/adapter-kit";
import type { SkillPlaybook } from "@rakazo/contracts";
import type { WorkImprovementOutput } from "./work-improvement.js";

export const baselineDeliveryPlaybook: SkillPlaybook = {
  whenToUse: "Verify a file delivery for the selected project.",
  inputs: ["request.json", "manifest.json", "installation.json", "upload.json"],
  steps: ["Read the request and manifest, check installation, then report delivery."],
  howToCheck: "Trust the manifest installation check and selected upload.",
  whatToReturn: "Return the structured delivery checks and directory observations.",
  approvalBoundaries: "Read evidence only.",
  failureHandling: "Keep missing evidence unknown.",
};
export const goodDeliveryPlaybook: SkillPlaybook = {
  ...baselineDeliveryPlaybook,
  steps: [
    "Check project scope first, inspect the complete installed directory against the manifest, exclude only exact allowed runtime paths, and require a completed upload receipt.",
  ],
  howToCheck: "Use complete directory evidence and a completed upload receipt.",
};
export const badDeliveryPlaybook: SkillPlaybook = {
  ...goodDeliveryPlaybook,
  howToCheck: "Reject every extra file including allowed runtime files.",
};

/** Offline API-shaped runtime: answers depend on actual isolated file-tool results, never truth. */
export class OfflineTicketImprovementRuntime implements AgentRuntime {
  proposalCalls = 0;
  comparisonCalls = 0;
  readonly requests: AgentRunRequest[] = [];
  proposal:
    | { kind: "candidate"; quote: string; playbook: SkillPlaybook }
    | { kind: "skip"; reason: string } = {
    kind: "candidate",
    quote:
      "You checked installation but did not inspect the complete directory or confirm upload completion.",
    playbook: goodDeliveryPlaybook,
  };
  proposalError?: Error;
  missingUsage = false;
  missingComparisonUsage = false;
  /** Replaces the proposal call's token buckets, e.g. a provider that reports no total. */
  proposalUsage?: Partial<AgentUsage>;
  constructor(readonly task?: (request: AgentRunRequest) => Promise<string | undefined>) {}

  describe() {
    return {
      id: "deterministic-offline-file-tools",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }
  async abort(_runId: string) {}
  async *run(
    request: AgentRunRequest,
    _context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.requests.push(request);
    if (request.runId.endsWith(":proposal")) {
      this.proposalCalls++;
      if (this.proposalError) throw this.proposalError;
      if (!this.missingUsage) await this.account(request, this.proposalUsage);
      yield { type: "done", text: JSON.stringify(this.proposal) };
      return;
    }
    if (request.usageOperationKind === "learning" && request.tools.length > 0) {
      this.comparisonCalls++;
      const read = async (name: string, path: string) => {
        const result = (await request.executeTool!(
          name,
          { path },
          `${request.runId}:${name}:${path}`,
        )) as AgentToolExecutionResult;
        return result.details;
      };
      const file = async (path: string) =>
        JSON.parse(((await read("read_file", path)) as { content: string }).content);
      const asked = (await file("request.json")) as {
        project: string;
        runtimeExclusions: string[];
      };
      const manifest = (await file("manifest.json")) as {
        project: string;
        files: Array<{ path: string; sha256: string }>;
      };
      const output: WorkImprovementOutput = {
        schemaVersion: "work-improvement.output.v1",
        outcome: "complete",
        checks: { installation: "pass", directory: "pass", upload: "pass" },
        observations: {
          missing_files: [],
          unexpected_files: [],
          hash_mismatches: [],
          excluded_runtime_files: [],
        },
      };
      if (asked.project !== manifest.project) {
        output.outcome = "out_of_scope";
        output.checks = {
          installation: "not_applicable",
          directory: "not_applicable",
          upload: "not_applicable",
        };
      } else {
        const installation = (await file("installation.json")) as {
          checked: Array<{ matches: boolean }>;
        };
        const upload = (await file("upload.json")) as { state: string; receiptId?: string };
        const directory = (await read("list_files", "installed")) as {
          files: Array<{ path: string; sha256: string }>;
        };
        const { playbook } = JSON.parse(request.instructions.split("\n").at(-1)!) as {
          playbook: SkillPlaybook;
        };
        const baseline = JSON.stringify(playbook) === JSON.stringify(baselineDeliveryPlaybook);
        const bad = JSON.stringify(playbook) === JSON.stringify(badDeliveryPlaybook);
        const installed = new Map(
          directory.files.map((entry) => [entry.path.slice("installed/".length), entry.sha256]),
        );
        const expected = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
        for (const [path, hash] of expected) {
          if (!installed.has(path)) output.observations.missing_files!.push(path);
          else if (installed.get(path) !== hash) output.observations.hash_mismatches!.push(path);
        }
        for (const path of installed.keys()) {
          if (expected.has(path)) continue;
          if (!bad && asked.runtimeExclusions.includes(path))
            output.observations.excluded_runtime_files!.push(path);
          else if (!baseline) output.observations.unexpected_files!.push(path);
        }
        if (installation.checked.some((entry) => !entry.matches))
          output.checks.installation = "fail";
        if (
          output.observations.missing_files!.length ||
          output.observations.hash_mismatches!.length ||
          output.observations.unexpected_files!.length
        )
          output.checks.directory = "fail";
        if (!baseline && !(upload.state === "uploaded" && upload.receiptId))
          output.checks.upload = "unknown";
        output.outcome = Object.values(output.checks).includes("fail")
          ? "failed"
          : Object.values(output.checks).includes("unknown")
            ? "unknown"
            : "complete";
      }
      if (!this.missingComparisonUsage) await this.account(request);
      yield { type: "done", text: JSON.stringify(output) };
      return;
    }
    const response = await this.task?.(request);
    await this.account(request);
    yield { type: "done", text: response ?? "Recorded." };
  }
  private async account(request: AgentRunRequest, override?: Partial<AgentUsage>) {
    await request.onUsage?.({
      type: "usage",
      provider: request.model.provider,
      model: request.model.id,
      callId: `${request.runId}:offline-call`,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      costUsd: 0,
      usageSource: "deterministic_offline_fixture",
      ...override,
    });
  }
}
