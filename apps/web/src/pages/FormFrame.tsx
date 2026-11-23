import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { desktopBridge } from "../lib/desktop";

export const submitClass = "mt-3 h-12 w-full rounded-xl text-body-lg";

export function FormFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  const server = desktopBridge()?.server;
  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <div className="app-drag flex items-center gap-2 px-5 py-[18px]" />
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <form onSubmit={onSubmit} className="flex w-full max-w-[460px] flex-col items-center">
          <h1
            aria-live="polite"
            className="mb-9 mt-7 text-balance text-center text-display font-medium"
          >
            {title}
          </h1>
          {children}
        </form>
      </div>
      {server ? (
        <div className="flex justify-center pb-6">
          <Button type="button" variant="text" size="sm" onClick={() => void server.change()}>
            <Trans>Change server</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
