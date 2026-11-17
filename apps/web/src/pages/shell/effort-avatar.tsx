import type { ThinkingLevel } from "@rakazo/contracts";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { useAvatarMotionVisibility } from "@rakazo/ui-web/hooks/use-avatar-motion-visibility";
import { Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useId } from "react";

const violet = BOT_COLOR_LIST.find((color) => color.id === "violet")!.hex;
const wave = [
  { offset: -0.3, light: 0 },
  { offset: -0.22, light: 32 },
  { offset: -0.14, light: 0 },
  { offset: -0.08, light: 0 },
  { offset: 0, light: 80 },
  { offset: 0.08, light: 0 },
];

/** A surface highlight on the existing silhouette, underneath its unchanged face. */
export function EffortAvatar({
  color,
  level,
  active,
  children,
}: {
  color: string;
  level: ThinkingLevel;
  active: boolean;
  children: ReactNode;
}) {
  const id = `effort-paint-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { ref, visible, reducedMotion } = useAvatarMotionVisibility<HTMLDivElement>(active);
  const intense = level === "xhigh" || level === "max";
  const moving = active && intense && visible && !reducedMotion;
  const paint = level === "max" ? violet : color;
  return (
    <div
      ref={ref}
      className="bot-effort-preview relative flex justify-center pb-4"
      data-active={active}
      data-level={level}
      data-moving={moving}
      style={{ "--effort-body-paint": `url(#${id})` } as CSSProperties}
    >
      <svg width="0" height="0" className="absolute pointer-events-none" aria-hidden="true">
        <defs>
          <radialGradient id={id} cx="100%" cy="0%" r="145%">
            <stop offset="0" stopColor={paint} />
            {wave.map(({ offset, light }) => (
              <stop
                key={offset}
                offset="0"
                stopColor={`color-mix(in srgb, ${paint}, var(--chat-user-foreground) ${light}%)`}
              >
                {moving ? (
                  <animate
                    attributeName="offset"
                    values={Array.from({ length: 24 }, (_, frame) =>
                      Math.max(0, Math.min(1, (frame / 23) * 1.5 + offset)).toFixed(3),
                    ).join(";")}
                    dur="3.072s"
                    calcMode="discrete"
                    repeatCount="indefinite"
                  />
                ) : null}
              </stop>
            ))}
            <stop offset="1" stopColor={paint} />
          </radialGradient>
        </defs>
      </svg>
      {children}
      {active && level === "max" ? (
        <Sparkles
          className="effort-sparkle absolute pointer-events-none size-4 text-warning"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
