import { I18nProvider } from "@lingui/react";
import type { ApprovalMode, BotAvatarSet, ThinkingLevel } from "@rakazo/contracts";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { botLookState, organicAvatarSampleIdentity } from "@rakazo/core";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { AvatarStudioPopover } from "../../src/pages/shell/avatar-studio-popover";
import { ModelSection } from "../../src/pages/shell/bot-settings-sections";
import { EffortAvatar } from "../../src/pages/shell/effort-avatar";
import "../../src/styles.css";

const MODEL_CHOICES = [
  {
    key: "openrouter::anthropic/claude-sonnet",
    label: "Claude Sonnet (OpenRouter)",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    modelLabel: "Claude Sonnet",
    modelId: "anthropic/claude-sonnet",
  },
  {
    key: "openrouter::anthropic/claude-opus",
    label: "Claude Opus (OpenRouter)",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    modelLabel: "Claude Opus",
    modelId: "anthropic/claude-opus",
  },
  {
    key: "openai-compatible::gpt-mini",
    label: "GPT mini (OpenAI-compatible)",
    provider: "openai-compatible",
    providerLabel: "OpenAI-compatible",
    modelLabel: "GPT mini",
    modelId: "gpt-mini",
  },
] as const;

const params = new URLSearchParams(location.search);
applyResolvedAppearance(params.get("theme") === "light" ? "light" : "dark");
await bootstrapI18n(params.get("locale") === "en" ? "en" : "zh-CN");

function EffortFixture() {
  const [model, setModel] = useState<string>(MODEL_CHOICES[0]!.key);
  const [level, setLevel] = useState<ThinkingLevel>("high");
  const [approval, setApproval] = useState<{ mode: ApprovalMode; saves: number }>({
    mode: "ask",
    saves: 0,
  });
  const [preview, setPreview] = useState<ThinkingLevel | null>(null);
  const [saves, setSaves] = useState(0);
  const [color, setColor] = useState(BOT_COLOR_LIST.find((entry) => entry.id === "orange")!.hex);
  const [avatarSet, setAvatarSet] = useState<BotAvatarSet>("organic");
  const modelRef = useRef<HTMLDivElement>(null);
  const glowLevel = preview ?? level;
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-96 flex-col px-5 py-12"
      data-saved-level={level}
      data-save-count={saves}
      data-saved-approval={approval.mode}
      data-approval-save-count={approval.saves}
      style={{ "--effort-color": botLookState(color).color } as CSSProperties}
    >
      <EffortAvatar color={botLookState(color).color} level={glowLevel} active>
        <AvatarStudioPopover
          value={color}
          avatarSet={avatarSet}
          identity={organicAvatarSampleIdentity(3)}
          size={76}
          onChange={(nextColor, nextSet) => {
            setColor(nextColor);
            if (nextSet) setAvatarSet(nextSet);
          }}
        />
      </EffortAvatar>
      <h1 className="mb-8 text-center text-heading2 font-semibold">Chief</h1>
      <ModelSection
        ids="effort-fixture"
        containerRef={modelRef}
        choices={MODEL_CHOICES}
        value={model}
        onModelChange={(next) => setModel(next)}
        effortLevel={level}
        approvalMode={approval.mode}
        approvalScope="account"
        onApprovalModeChange={(mode) => setApproval(({ saves }) => ({ mode, saves: saves + 1 }))}
        onEffortChange={(next) => {
          setLevel(next);
          setSaves((count) => count + 1);
        }}
        onEffortPreview={setPreview}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <EffortFixture />
  </I18nProvider>,
);
