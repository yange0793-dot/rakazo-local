import * as z from "zod";

const ComponentIdentitySchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(120),
});

const CapabilityIdSchema = z.string().trim().min(1).max(160);
const ComponentTextSchema = z.string().trim().min(1).max(2_000);
const ToolInputSchema = z.strictObject({ path: z.string().max(300) });

export const ImprovementComponentSchema = z.discriminatedUnion("kind", [
  ComponentIdentitySchema.extend({
    kind: z.literal("task_guidance"),
    text: ComponentTextSchema,
  }),
  ComponentIdentitySchema.extend({
    kind: z.literal("system_strategy"),
    text: ComponentTextSchema,
  }),
  ComponentIdentitySchema.extend({
    kind: z.literal("tool_guidance"),
    capabilityId: CapabilityIdSchema,
    text: z.string().trim().min(1).max(1_000),
  }),
  ComponentIdentitySchema.extend({
    kind: z.literal("plugin"),
    capabilityId: CapabilityIdSchema,
  }),
  ComponentIdentitySchema.extend({
    kind: z.literal("script"),
    language: z.literal("tool-sequence.v1"),
    steps: z
      .array(
        z.strictObject({
          capabilityId: CapabilityIdSchema,
          input: ToolInputSchema,
        }),
      )
      .min(1)
      .max(4),
  }),
]);
export type ImprovementComponent = z.infer<typeof ImprovementComponentSchema>;

export const ImprovementComponentSetSchema = z
  .strictObject({
    schemaVersion: z.literal("improvement-components.v1"),
    items: z.array(ImprovementComponentSchema).min(1).max(8),
  })
  .superRefine(({ items }, context) => {
    const ids = new Set<string>();
    const plugins = new Set<string>();
    let guidanceCharacters = 0;
    let scriptSteps = 0;

    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Component ids must be unique within a revision.",
          path: ["items", index, "id"],
        });
      }
      ids.add(item.id);

      if (item.kind === "task_guidance" || item.kind === "system_strategy") {
        guidanceCharacters += item.text.length;
      } else if (item.kind === "tool_guidance") {
        guidanceCharacters += item.text.length;
      } else if (item.kind === "plugin") {
        if (plugins.has(item.capabilityId)) {
          context.addIssue({
            code: "custom",
            message: "A capability can only be selected once.",
            path: ["items", index, "capabilityId"],
          });
        }
        plugins.add(item.capabilityId);
      } else {
        scriptSteps += item.steps.length;
      }
    }

    if (guidanceCharacters > 8_000) {
      context.addIssue({
        code: "custom",
        message: "Combined component guidance cannot exceed 8000 characters.",
        path: ["items"],
      });
    }
    if (scriptSteps > 4) {
      context.addIssue({
        code: "custom",
        message: "A component revision can execute at most four script steps.",
        path: ["items"],
      });
    }
  });
export type ImprovementComponentSet = z.infer<typeof ImprovementComponentSetSchema>;

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ImprovementComponentExecutionSchema = z.strictObject({
  executionId: z.string().min(1),
  capabilityId: CapabilityIdSchema,
  status: z.enum(["succeeded", "error", "denied"]),
  outputHash: HashSchema,
  observedByRuntime: z.boolean(),
});

export const ImprovementComponentCapabilityReceiptSchema = z.strictObject({
  id: CapabilityIdSchema,
  adapterId: z.string().min(1),
  contractVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  schemaHash: HashSchema,
  toolHash: HashSchema,
});

export const ImprovementComponentReceiptSchema = z.strictObject({
  schemaVersion: z.literal("improvement-component-receipt.v1"),
  componentId: z.string().min(1),
  componentRevision: z.string().min(1),
  componentKind: z.enum(["task_guidance", "system_strategy", "tool_guidance", "plugin", "script"]),
  componentHash: HashSchema,
  status: z.enum(["applied", "executed", "loaded", "unsupported", "unexecuted"]),
  runId: z.string().min(1),
  skillRevision: z.string().min(1),
  skillHash: HashSchema,
  instructionsHash: HashSchema,
  capabilities: z.array(ImprovementComponentCapabilityReceiptSchema),
  executions: z.array(ImprovementComponentExecutionSchema),
});
export type ImprovementComponentReceipt = z.infer<typeof ImprovementComponentReceiptSchema>;
