import { useCallback, useEffect, useRef } from "react";
import { discardPrimedBootstrap, primeSpaceBootstrap } from "../../lib/bootstrap";
import { initialBootstrapTarget } from "../../lib/bootstrap-target";
import { getSnapshot as getCallSnapshot } from "../../lib/call-session";
import { leaveOrganization } from "../../lib/organizations";
import { queryClient, spaceSeedKey } from "../../lib/query";
import { selectSpace } from "../../lib/rpc";
import { remountShellForSpace, spaceSwitchDecision } from "../../lib/space-switch";
import { speaker } from "../../lib/tts";
import { readShellOverlay, searchString, withShellOverlay } from "../shell-overlay";
import type { useShellNavigation } from "./use-shell-navigation";

/**
 * Opens a chat in any of the user's spaces, including another organization's; another space loads
 * first, then the shell remounts into it.
 */
export function useOpenSpaceChat({
  currentSpaceId,
  userId,
  navigate,
  navigationRevision,
  overlayRevision,
  closeMobileSidebar,
}: {
  currentSpaceId: string | null;
  userId: string | undefined;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
  navigationRevision: ReturnType<typeof useShellNavigation>["navigationRevision"];
  overlayRevision: ReturnType<typeof useShellNavigation>["overlayRevision"];
  closeMobileSidebar: () => void;
}) {
  const spaceSwitchRequest = useRef(0);
  useEffect(() => {
    const onPopState = () => {
      spaceSwitchRequest.current += 1;
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      // A switch still loading when this shell goes away (another page, or a
      // newer switch) must not pull the user back to its space afterwards.
      spaceSwitchRequest.current += 1;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  return useCallback(
    (spaceId: string, path: string) => {
      closeMobileSidebar();
      const request = ++spaceSwitchRequest.current;
      const startedNavigation = navigationRevision.current;
      const startedOverlay = overlayRevision.current;
      const startedIndex = window.history.state?.idx;
      const previousEffective = currentSpaceId ?? undefined;
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      if (previousEffective === spaceId) {
        if (selectSpace(spaceId)) navigate(path);
        return;
      }
      const destination = () =>
        overlayRevision.current === startedOverlay
          ? path
          : `${path}${searchString(withShellOverlay(new URLSearchParams(), readShellOverlay(new URLSearchParams(window.location.search))))}`;
      const startedAt = window.location.pathname;
      const decision = () =>
        spaceSwitchDecision(
          request === spaceSwitchRequest.current &&
            startedNavigation === navigationRevision.current &&
            startedIndex === window.history.state?.idx,
          startedAt,
          window.location.pathname,
          Boolean(getCallSnapshot()),
        );
      const current = () => decision() !== "abandon";
      const reload = () => {
        void leaveOrganization(userId ?? null, previousEffective, spaceId).then(() => {
          if (!current()) return;
          if (selectSpace(spaceId)) window.location.assign(destination());
        });
      };
      // Load the new space under its own header before remounting the shell.
      const target = initialBootstrapTarget(path, false);
      if (!target || getCallSnapshot()) {
        reload();
        return;
      }
      // A space visited before opens at once with what it showed then, refreshing behind it.
      const cached = queryClient.getQueryData(spaceSeedKey(userId ?? null, spaceId));
      const primed = primeSpaceBootstrap(spaceId, target.botId, cached);
      const remount = () =>
        remountShellForSpace(() => {
          const action = decision();
          if (action !== "commit") {
            discardPrimedBootstrap(primed);
            if (action === "reload") {
              // Leave the view-transition update before starting a full navigation.
              window.setTimeout(() => {
                if (current()) reload();
              }, 0);
            }
            return false;
          }
          if (!selectSpace(spaceId)) {
            discardPrimedBootstrap(primed);
            return false;
          }
          void leaveOrganization(userId ?? null, previousEffective, spaceId);
          // Playback belongs to the conversation being left.
          speaker.stop();
          navigate(destination());
          return true;
        });
      if (cached) {
        remount();
        return;
      }
      primed.then(
        () => {
          if (!current()) {
            discardPrimedBootstrap(primed);
            return;
          }
          // A call started while the bootstrap loaded belongs to this space.
          if (getCallSnapshot()) {
            discardPrimedBootstrap(primed);
            reload();
            return;
          }
          remount();
        },
        () => {
          discardPrimedBootstrap(primed);
          if (current()) reload();
        },
      );
    },
    [currentSpaceId, navigate, navigationRevision, overlayRevision, userId],
  );
}
