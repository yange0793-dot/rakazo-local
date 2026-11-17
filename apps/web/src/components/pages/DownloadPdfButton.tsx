import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Spinner, toast } from "@rakazo/ui-web";
import { Download } from "lucide-react";
import { useState } from "react";
import { printPage } from "../../lib/print-page";

/**
 * Saves the open page as a PDF through the browser's print dialog. Whatever surrounds the page
 * marks itself `data-page-print`, so only the page reaches the paper (styles.css).
 */
export function DownloadPdfButton({
  className,
  iconClassName = "size-4",
  labelClassName,
}: {
  className: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  const { t } = useLingui();
  const [printing, setPrinting] = useState(false);
  return (
    <Button
      variant="ghost"
      className={className}
      title={t`Opens your browser's print dialog. Choose Save as PDF as the destination.`}
      disabled={printing}
      aria-busy={printing || undefined}
      onClick={async (event) => {
        const page = event.currentTarget.closest<HTMLElement>("[data-page-print]");
        if (!page) return;
        setPrinting(true);
        try {
          await printPage(page);
        } catch {
          toast(t`Could not prepare PDF. Try again.`);
        } finally {
          setPrinting(false);
        }
      }}
    >
      {printing ? (
        <Spinner className={iconClassName} />
      ) : (
        <Download className={iconClassName} strokeWidth={1.5} />
      )}
      <span className={labelClassName}>
        <Trans>Download PDF</Trans>
      </span>
    </Button>
  );
}
