import { Alert, AlertDescription } from "@/components/ui/alert";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteProxyHostAction } from "@/app/(dashboard)/proxy-hosts/actions";
import { INITIAL_ACTION_STATE } from "@/lib/actions";
import { ProxyHost } from "@/lib/models/proxy-hosts";
import { AppDialog } from "@/components/ui/AppDialog";
import type { ActionState } from "@/lib/actions";
import { ProtectedChangeNotice } from "@/ee/approvals/ui/ProtectedChangeNotice";
import type { HostApprovalContext } from "@/ee/approvals/types";

/*
 * Creating, editing and copying a proxy host happen in the host editor
 * (src/components/proxy-hosts/editor: /proxy-hosts/new, and the tabs of
 * a host's page). Deleting stays a confirmation dialog.
 */

/** Props the create and edit dialogs took; the form props are accepted and unused. */
type LegacyDialogProps = { open: boolean; onClose?: () => void; [prop: string]: unknown };

/**
 * The create dialog's place in a page: opening it opens the host editor for
 * a new host instead (a copy with initialData, a first domain with
 * initialDomain). Renders nothing.
 */
export function CreateHostDialog({ open, initialData, initialDomain }: LegacyDialogProps & { initialData?: ProxyHost | null; initialDomain?: string | null }) {
    const router = useRouter();
    useEffect(() => {
        if (!open) return;
        if (initialData) router.push(`/proxy-hosts/new?from=${initialData.id}`);
        else if (initialDomain) router.push(`/proxy-hosts/new?domain=${encodeURIComponent(initialDomain)}`);
        else router.push("/proxy-hosts/new");
    }, [open, initialData, initialDomain, router]);
    return null;
}

/** The edit dialog's place in a page: opening it opens the host editor of `host`. Renders nothing. */
export function EditHostDialog({ open, host }: LegacyDialogProps & { host: ProxyHost }) {
    const router = useRouter();
    useEffect(() => {
        if (open) router.push(`/proxy-hosts/${host.id}#routing`);
    }, [open, host.id, router]);
    return null;
}

/** A clear toast when a change approval policy turned the change into a change request (ee/approvals). */
function useChangeRequestToast(state: ActionState) {
    useEffect(() => {
        if (state.status !== "success" || !state.changeRequest) return;
        if (state.changeRequest.status === "applied") toast.success(state.message ?? "Emergency change applied.");
        else toast.info(state.message ?? "Submitted for approval.", { duration: 10000 });
    }, [state]);
}

export function DeleteHostDialog({
    open,
    host,
    onClose,
    approval = null,
}: {
    open: boolean;
    host: ProxyHost;
    onClose: () => void;
    /** Change approval policies (ee/approvals), to say before deleting that the host is protected. */
    approval?: HostApprovalContext | null;
}) {
    const [state, formAction] = useActionState(deleteProxyHostAction.bind(null, host.id), INITIAL_ACTION_STATE);
    useChangeRequestToast(state);

    useEffect(() => {
        if (state.status === "success") {
            setTimeout(onClose, 1000);
        }
    }, [state.status, onClose]);

    return (
        <AppDialog
            open={open}
            onClose={onClose}
            title="Delete proxy host"
            maxWidth="sm"
            submitLabel="Delete"
            onSubmit={() => {
                (document.getElementById("delete-host-form") as HTMLFormElement)?.requestSubmit();
            }}
        >
            <form id="delete-host-form" action={formAction} className="flex flex-col gap-4">
                {state.status !== "idle" && state.message && (
                    <Alert variant={state.status === "error" ? "destructive" : "default"}>
                        <AlertDescription>{state.message}</AlertDescription>
                    </Alert>
                )}
                <p className="text-sm">
                    <strong>{host.name}</strong> stops serving <span className="num [overflow-wrap:anywhere]">{host.domains.join(", ")}</span>.
                </p>
                <p className="text-sm text-destructive font-medium">
                    This cannot be undone.
                </p>
                <ProtectedChangeNotice approval={approval} targetType="proxy_host" tags={host.tags} operations={["delete"]} />
            </form>
        </AppDialog>
    );
}
