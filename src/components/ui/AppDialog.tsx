import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ReactNode } from "react";

type AppDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: "xs" | "sm" | "md" | "lg" | "xl";
  actions?: ReactNode;
  submitLabel?: string;
  onSubmit?: () => void;
  isSubmitting?: boolean;
  /** Shown at the start of the footer, before Cancel (e.g. "Send test"). */
  extraAction?: ReactNode;
};

const MAX_WIDTH_CLASS: Record<NonNullable<AppDialogProps["maxWidth"]>, string> = {
  xs: "max-w-xs",
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function AppDialog({
  open,
  onClose,
  title,
  children,
  maxWidth = "sm",
  actions,
  submitLabel = "Save",
  onSubmit,
  isSubmitting = false,
  extraAction,
}: AppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={MAX_WIDTH_CLASS[maxWidth]}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* The stable gutter keeps the scrollbar off the fields. */}
        <div className="flex-1 min-h-0 overflow-y-auto py-4 pl-1 pr-3 [scrollbar-gutter:stable]">{children}</div>

        <DialogFooter>
          {actions ?? (
            <>
              {extraAction && <div className="flex items-center gap-2 sm:mr-auto">{extraAction}</div>}
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              {onSubmit && (
                <Button onClick={onSubmit} disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent mr-2" />
                      Saving…
                    </>
                  ) : (
                    submitLabel
                  )}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
