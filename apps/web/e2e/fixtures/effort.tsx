import { I18nProvider } from "@lingui/react";
import type { BotAvatarSet, ThinkingLevel } from "@rakazo/contracts";
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

const params = new URLSearchParams(location.search);
applyResolvedAppearance(params.get("theme") === "light" ? "light" : "dark");
await bootstrapI18n(params.get("locale") === "en" ? "en" : "zh-CN");

function EffortFixture() {
  const [level, setLevel] = useState<ThinkingLevel>("high");
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
        choices={[{ key: "fixture::balanced", label: "Balanced" }]}
        value="fixture::balanced"
        onModelChange={() => {}}
        effortLevel={level}
        effortLevels={["low", "medium", "high", "xhigh", "max"]}
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
