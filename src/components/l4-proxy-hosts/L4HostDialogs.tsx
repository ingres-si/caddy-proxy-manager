"use client";

/*
 * Creating and changing an L4 host happen in the L4 host editor
 * (src/components/l4-proxy-hosts/editor: /l4-proxy-hosts/new, and the tabs of
 * a host's page). Deleting stays a confirmation dialog.
 */

import { useActionState, useEffect, useRef } from "react";
import { deleteL4ProxyHostAction } from "@/app/(dashboard)/l4-proxy-hosts/actions";
import { INITIAL_ACTION_STATE } from "@/lib/actions";
import type { L4ProxyHost } from "@/lib/models/l4-proxy-hosts";
import { AppDialog } from "@/components/ui/AppDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { ActionState } from "@/lib/actions";
import { ProtectedChangeNotice } from "@/ee/approvals/ui/ProtectedChangeNotice";
import type { HostApprovalContext } from "@/ee/approvals/types";

/** A clear toast when a change approval policy turned the change into a change request (ee/approvals). */
function useChangeRequestToast(state: ActionState) {
  useEffect(() => {
    if (state.status !== "success" || !state.changeRequest) return;
    if (state.changeRequest.status === "applied") toast.success(state.message ?? "Emergency change applied.");
    else toast.info(state.message ?? "Submitted for approval.", { duration: 10000 });
  }, [state]);
}

/**
 * Schedule onClose after a successful action exactly once. Without the ref
 * guard the effect re-arms on every parent render (onClose is a new function
 * identity each render) while status stays "success", producing stray onClose
 * calls that can close a dialog the user has just reopened (#241).
 */
function useCloseOnSuccess(state: { status: string }, onClose: () => void) {
  const scheduledRef = useRef(false);
  useEffect(() => {
    if (state.status === "success" && !scheduledRef.current) {
      scheduledRef.current = true;
      const timer = setTimeout(onClose, 1000);
      return () => clearTimeout(timer);
    }
  }, [state.status, onClose]);
}

export function DeleteL4HostDialog({
  open,
  host,
  onClose,
  approval = null,
}: {
  open: boolean;
  host: L4ProxyHost;
  onClose: () => void;
  /** Change approval policies (ee/approvals), to say before deleting that the host is protected. */
  approval?: HostApprovalContext | null;
}) {
  const [state, formAction] = useActionState(
    deleteL4ProxyHostAction.bind(null, host.id),
    INITIAL_ACTION_STATE
  );

  useCloseOnSuccess(state, onClose);
  useChangeRequestToast(state);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Delete L4 host"
      maxWidth="lg"
      submitLabel="Delete"
      onSubmit={() => {
        (
          document.getElementById("delete-l4-host-form") as HTMLFormElement
        )?.requestSubmit();
      }}
    >
      <form
        id="delete-l4-host-form"
        action={formAction}
        className="flex flex-col gap-4"
      >
        {state.status !== "idle" && state.message && (
          <Alert
            variant={state.status === "error" ? "destructive" : "default"}
          >
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm">
          Delete <strong>{host.name}</strong>?
        </p>
        <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">Protocol</span>
            <Badge variant={host.protocol === "tcp" ? "info" : "warning"} className="text-[10px] px-1.5 py-0">
              {host.protocol.toUpperCase()}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">Listen</span>
            <span className="font-mono text-xs">{host.listenAddress}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground w-20 shrink-0">Upstreams</span>
            <span className="font-mono text-xs">{host.upstreams.join(", ")}</span>
          </div>
        </div>
        <p className="text-sm text-destructive font-medium">
          This cannot be undone.
        </p>
        <ProtectedChangeNotice approval={approval} targetType="l4_proxy_host" tags={host.tags} operations={["delete"]} />
      </form>
    </AppDialog>
  );
}
