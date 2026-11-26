import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { NativeSelect, NativeSelectOption, Spinner } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { selectedSpaceId } from "../lib/rpc";
import { SpaceRpcProvider, useSpaceRpc } from "../lib/space-rpc";

export function IntegrationSetupPage() {
  const [spaceId] = useState(selectedSpaceId);
  return (
    <SpaceRpcProvider spaceId={spaceId}>
      <IntegrationSetupContent />
    </SpaceRpcProvider>
  );
}

function IntegrationSetupContent() {
  const navigate = useNavigate();
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setReady(false);
    setError(false);
    let cancelled = false;
    void rpc.bots
      .list()
      .then((rows) => {
        if (cancelled) return;
        if (!rows.length) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setBots(rows);
        setBotId(rows[0]?.id ?? "");
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, rpc]);
  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto max-w-[560px]">
        {bots.length > 1 ? (
          <NativeSelect
            aria-label={t`Bot`}
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            className="mb-6 w-full"
          >
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {ready ? (
          <IntegrationSetup
            botId={botId || undefined}
            onDone={() => navigate(bots.length ? "/app" : "/onboarding")}
          />
        ) : (
          <p>
            {error ? (
              t`Could not load bots. Reload to try again.`
            ) : (
              <Spinner aria-label={t`Loading…`} />
            )}
          </p>
        )}
      </div>
    </div>
  );
}
