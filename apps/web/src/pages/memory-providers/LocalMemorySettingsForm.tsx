import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderSettingsFormProps } from "./registry";

export function LocalMemorySettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const endpointId = useId();
  const tokenId = useId();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");

  async function connect() {
    if (busy || !baseUrl.trim() || !token.trim()) return;
    if (
      await onConnect({
        settings: { baseUrl: baseUrl.trim() },
        credentials: { token: token.trim() },
      })
    ) {
      setToken("");
    }
  }

  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={endpointId}>
          <Trans>Endpoint</Trans>
        </FieldLabel>
        <Input
          id={endpointId}
          type="url"
          value={baseUrl}
          disabled={busy}
          onChange={(event) => setBaseUrl(event.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field className="mt-4">
        <FieldLabel htmlFor={tokenId}>
          <Trans>Token</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          type="password"
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !baseUrl.trim() || !token.trim()}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
