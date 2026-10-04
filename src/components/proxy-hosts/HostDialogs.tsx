import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useActionState, useEffect } from "react";
import {
    createProxyHostAction,
    deleteProxyHostAction,
    updateProxyHostAction
} from "@/app/(dashboard)/proxy-hosts/actions";
import { INITIAL_ACTION_STATE } from "@/lib/actions";
import { AccessList } from "@/lib/models/access-lists";
import type { CertificatePickerOption } from "@/lib/certificate-api";
import { ProxyHost } from "@/lib/models/proxy-hosts";
import { AuthentikSettings, ForwardAuthSettings } from "@/lib/settings";
import { AppDialog } from "@/components/ui/AppDialog";
import { AuthentikFields } from "./AuthentikFields";
import { ForwardAuthFields } from "./ForwardAuthFields";
import { DnsResolverFields } from "./DnsResolverFields";
import { LoadBalancerFields } from "./LoadBalancerFields";
import { SettingsToggles } from "./SettingsToggles";
import { UpstreamDnsResolutionFields } from "./UpstreamDnsResolutionFields";
import { UpstreamInput } from "./UpstreamInput";
import { GeoBlockFields } from "./GeoBlockFields";
import { WafFields } from "./WafFields";
import { MtlsFields } from "./MtlsConfig";
import { CpmForwardAuthFields } from "./CpmForwardAuthFields";
import { RedirectsFields } from "./RedirectsFields";
import { LocationRulesFields } from "./LocationRulesFields";
import { RewriteFields } from "./RewriteFields";
import { PathAllowsFields } from "./PathAllowsFields";
import { PathBlocksFields } from "./PathBlocksFields";
import { PathRewritesFields } from "./PathRewritesFields";
import { ErrorPagesFields } from "./ErrorPagesFields";
import type { CaCertificate } from "@/lib/models/ca-certificates";
import type { MtlsRole } from "@/lib/models/mtls-roles";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";

type ForwardAuthUser = { id: number; email: string; name: string | null; role: string };
type ForwardAuthGroup = { id: number; name: string; description: string | null; member_count: number };
type ForwardAuthAccessData = { userIds: number[]; groupIds: number[] };

export function CreateHostDialog({
    open,
    onClose,
    certificates,
    accessLists,
    authentikDefaults,
    forwardAuthDefaults,
    initialData,
    caCertificates = [],
    mtlsRoles = [],
    issuedClientCerts = [],
    forwardAuthUsers = [],
    forwardAuthGroups = [],
}: {
    open: boolean;
    onClose: () => void;
    certificates: CertificatePickerOption[];
    accessLists: AccessList[];
    authentikDefaults: AuthentikSettings | null;
    forwardAuthDefaults?: ForwardAuthSettings | null;
    initialData?: ProxyHost | null;
    caCertificates?: CaCertificate[];
    mtlsRoles?: MtlsRole[];
    issuedClientCerts?: IssuedClientCertificate[];
    forwardAuthUsers?: ForwardAuthUser[];
    forwardAuthGroups?: ForwardAuthGroup[];
}) {
    const [state, formAction] = useActionState(createProxyHostAction, INITIAL_ACTION_STATE);

    useEffect(() => {
        if (state.status === "success") {
            setTimeout(onClose, 1000);
        }
    }, [state.status, onClose]);

    return (
        <AppDialog
            open={open}
            onClose={onClose}
            title={initialData ? "Duplicate Proxy Host" : "Create Proxy Host"}
            maxWidth="lg"
            submitLabel="Create"
            onSubmit={() => {
                (document.getElementById("create-host-form") as HTMLFormElement)?.requestSubmit();
            }}
        >
            <form id="create-host-form" action={formAction} className="flex flex-col gap-5">
                {state.status !== "idle" && state.message && (
                    <Alert variant={state.status === "error" ? "destructive" : "default"}>
                        <AlertDescription>{state.message}</AlertDescription>
                    </Alert>
                )}
                <SettingsToggles
                    sslForced={initialData?.sslForced}
                    hstsSubdomains={initialData?.hstsSubdomains}
                    skipHttpsValidation={initialData?.skipHttpsHostnameValidation}
                    enabled={true}
                />
                <div>
                    <label htmlFor="name" className="text-sm font-medium mb-1 block">Name</label>
                    <Input
                        id="name"
                        name="name"
                        placeholder="My Service"
                        defaultValue={initialData ? `${initialData.name} (Copy)` : ""}
                        required
                    />
                </div>
                <div>
                    <label htmlFor="domains" className="text-sm font-medium mb-1 block">Domains</label>
                    <Textarea
                        id="domains"
                        name="domains"
                        placeholder="app.example.com"
                        defaultValue={initialData?.domains.join("\n") ?? ""}
                        required
                        rows={2}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                        One per line or comma-separated. Wildcards like *.example.com are supported.
                    </p>
                </div>
                <UpstreamInput defaultUpstreams={initialData?.upstreams} />
                <div>
                    <label className="text-sm font-medium mb-1 block">Certificate</label>
                    <Select name="certificateId" defaultValue={String(initialData?.certificateId ?? "__none__")}>
                        <SelectTrigger aria-label="Certificate">
                            <SelectValue placeholder="Managed by Caddy (Auto)" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">Managed by Caddy (Auto)</SelectItem>
                            {certificates.map((cert) => (
                                <SelectItem key={cert.id} value={String(cert.id)}>
                                    {cert.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <label className="text-sm font-medium mb-1 block">Access List</label>
                    <Select name="accessListId" defaultValue={String(initialData?.accessListId ?? "__none__")}>
                        <SelectTrigger aria-label="Access List">
                            <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {accessLists.map((list) => (
                                <SelectItem key={list.id} value={String(list.id)}>
                                    {list.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <RedirectsFields initialData={initialData?.redirects} />
                <LocationRulesFields initialData={initialData?.locationRules} />
                <RewriteFields initialData={initialData?.rewrite} />
                <PathAllowsFields initialData={initialData?.pathAllows} />
                <PathBlocksFields initialData={initialData?.pathBlocks} />
                <PathRewritesFields initialData={initialData?.pathRewrites} />
                <ErrorPagesFields initialData={initialData?.errorPages} />
                <div>
                    <label className="text-sm font-medium mb-1 block">Custom Pre-Handlers (JSON)</label>
                    <Textarea
                        name="customPreHandlersJson"
                        placeholder='[{"handler": "headers", ...}]'
                        defaultValue={initialData?.customPreHandlersJson ?? ""}
                        rows={3}
                    />
                    <p className="text-xs text-muted-foreground mt-1">Optional JSON array of Caddy handlers</p>
                </div>
                <div>
                    <label className="text-sm font-medium mb-1 block">Custom Reverse Proxy (JSON)</label>
                    <Textarea
                        name="customReverseProxyJson"
                        placeholder='{"headers": {"request": {...}}}'
                        defaultValue={initialData?.customReverseProxyJson ?? ""}
                        rows={3}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                        Deep-merge into reverse_proxy handler (only applies in proxy mode)
                    </p>
                </div>
                <AuthentikFields defaults={authentikDefaults} authentik={initialData?.authentik} />
                <ForwardAuthFields forwardAuth={initialData?.forwardAuth} defaults={forwardAuthDefaults ?? null} />
                <CpmForwardAuthFields
                    cpmForwardAuth={initialData?.cpmForwardAuth}
                    users={forwardAuthUsers}
                    groups={forwardAuthGroups}
                />
                <LoadBalancerFields loadBalancer={initialData?.loadBalancer} />
                <DnsResolverFields dnsResolver={initialData?.dnsResolver} />
                <UpstreamDnsResolutionFields upstreamDnsResolution={initialData?.upstreamDnsResolution} />
                <GeoBlockFields />
                <WafFields value={initialData?.waf} />
                <MtlsFields
                    value={initialData?.mtls}
                    caCertificates={caCertificates}
                    mtlsRoles={mtlsRoles}
                    issuedClientCerts={issuedClientCerts}
                />
            </form>
        </AppDialog>
    );
}

export function EditHostDialog({
    open,
    host,
    onClose,
    certificates,
    accessLists,
    authentikDefaults,
    forwardAuthDefaults,
    caCertificates = [],
    mtlsRoles = [],
    issuedClientCerts = [],
    forwardAuthUsers = [],
    forwardAuthGroups = [],
    forwardAuthAccess,
}: {
    open: boolean;
    host: ProxyHost;
    onClose: () => void;
    certificates: CertificatePickerOption[];
    accessLists: AccessList[];
    // Required, matching CreateHostDialog — see AuthentikFields (#232).
    authentikDefaults: AuthentikSettings | null;
    forwardAuthDefaults?: ForwardAuthSettings | null;
    caCertificates?: CaCertificate[];
    mtlsRoles?: MtlsRole[];
    issuedClientCerts?: IssuedClientCertificate[];
    forwardAuthUsers?: ForwardAuthUser[];
    forwardAuthGroups?: ForwardAuthGroup[];
    forwardAuthAccess?: ForwardAuthAccessData | null;
}) {
    const [state, formAction] = useActionState(updateProxyHostAction.bind(null, host.id), INITIAL_ACTION_STATE);

    useEffect(() => {
        if (state.status === "success") {
            setTimeout(onClose, 1000);
        }
    }, [state.status, onClose]);

    return (
        <AppDialog
            open={open}
            onClose={onClose}
            title="Edit Proxy Host"
            maxWidth="lg"
            submitLabel="Save Changes"
            onSubmit={() => {
                (document.getElementById("edit-host-form") as HTMLFormElement)?.requestSubmit();
            }}
        >
            <form id="edit-host-form" action={formAction} className="flex flex-col gap-5">
                {state.status !== "idle" && state.message && (
                    <Alert variant={state.status === "error" ? "destructive" : "default"}>
                        <AlertDescription>{state.message}</AlertDescription>
                    </Alert>
                )}
                <SettingsToggles
                    sslForced={host.sslForced}
                    hstsSubdomains={host.hstsSubdomains}
                    skipHttpsValidation={host.skipHttpsHostnameValidation}
                    enabled={host.enabled}
                />
                <div>
                    <label htmlFor="name" className="text-sm font-medium mb-1 block">Name</label>
                    <Input id="name" name="name" defaultValue={host.name} required />
                </div>
                <div>
                    <label htmlFor="domains" className="text-sm font-medium mb-1 block">Domains</label>
                    <Textarea
                        id="domains"
                        name="domains"
                        defaultValue={host.domains.join("\n")}
                        rows={2}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                        One per line or comma-separated. Wildcards like *.example.com are supported.
                    </p>
                </div>
                <UpstreamInput defaultUpstreams={host.upstreams} />
                <div>
                    <label className="text-sm font-medium mb-1 block">Certificate</label>
                    <Select name="certificateId" defaultValue={String(host.certificateId ?? "__none__")}>
                        <SelectTrigger aria-label="Certificate">
                            <SelectValue placeholder="Managed by Caddy (Auto)" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">Managed by Caddy (Auto)</SelectItem>
                            {certificates.map((cert) => (
                                <SelectItem key={cert.id} value={String(cert.id)}>
                                    {cert.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <label className="text-sm font-medium mb-1 block">Access List</label>
                    <Select name="accessListId" defaultValue={String(host.accessListId ?? "__none__")}>
                        <SelectTrigger aria-label="Access List">
                            <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {accessLists.map((list) => (
                                <SelectItem key={list.id} value={String(list.id)}>
                                    {list.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <RedirectsFields initialData={host.redirects} />
                <LocationRulesFields initialData={host.locationRules} />
                <RewriteFields initialData={host.rewrite} />
                <PathAllowsFields initialData={host.pathAllows} />
                <PathBlocksFields initialData={host.pathBlocks} />
                <PathRewritesFields initialData={host.pathRewrites} />
                <ErrorPagesFields initialData={host.errorPages} />
                <div>
                    <label className="text-sm font-medium mb-1 block">Custom Pre-Handlers (JSON)</label>
                    <Textarea
                        name="customPreHandlersJson"
                        defaultValue={host.customPreHandlersJson ?? ""}
                        rows={3}
                    />
                    <p className="text-xs text-muted-foreground mt-1">Optional JSON array of Caddy handlers</p>
                </div>
                <div>
                    <label className="text-sm font-medium mb-1 block">Custom Reverse Proxy (JSON)</label>
                    <Textarea
                        name="customReverseProxyJson"
                        defaultValue={host.customReverseProxyJson ?? ""}
                        rows={3}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                        Deep-merge into reverse_proxy handler (only applies in proxy mode)
                    </p>
                </div>
                <AuthentikFields authentik={host.authentik} defaults={authentikDefaults} />
                <ForwardAuthFields forwardAuth={host.forwardAuth} defaults={forwardAuthDefaults ?? null} />
                <CpmForwardAuthFields
                    cpmForwardAuth={host.cpmForwardAuth}
                    users={forwardAuthUsers}
                    groups={forwardAuthGroups}
                    currentAccess={forwardAuthAccess}
                />
                <LoadBalancerFields loadBalancer={host.loadBalancer} />
                <DnsResolverFields dnsResolver={host.dnsResolver} />
                <UpstreamDnsResolutionFields upstreamDnsResolution={host.upstreamDnsResolution} />
                <GeoBlockFields
                    initialValues={{
                        geoblock: host.geoblock,
                        geoblock_mode: host.geoblockMode,
                    }}
                />
                <WafFields value={host.waf} />
                <MtlsFields
                    value={host.mtls}
                    caCertificates={caCertificates}
                    proxyHostId={host.id}
                    mtlsRoles={mtlsRoles}
                    issuedClientCerts={issuedClientCerts}
                />
            </form>
        </AppDialog>
    );
}

export function DeleteHostDialog({
    open,
    host,
    onClose
}: {
    open: boolean;
    host: ProxyHost;
    onClose: () => void;
}) {
    const [state, formAction] = useActionState(deleteProxyHostAction.bind(null, host.id), INITIAL_ACTION_STATE);

    useEffect(() => {
        if (state.status === "success") {
            setTimeout(onClose, 1000);
        }
    }, [state.status, onClose]);

    return (
        <AppDialog
            open={open}
            onClose={onClose}
            title="Delete Proxy Host"
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
                    Are you sure you want to delete the proxy host <strong>{host.name}</strong>?
                </p>
                <p className="text-sm text-muted-foreground">
                    This will remove the configuration for:
                </p>
                <div className="pl-4">
                    <p className="text-sm text-muted-foreground">• Domains: {host.domains.join(", ")}</p>
                    <p className="text-sm text-muted-foreground">• Upstreams: {host.upstreams.join(", ")}</p>
                </div>
                <p className="text-sm text-destructive font-medium">
                    This action cannot be undone.
                </p>
            </form>
        </AppDialog>
    );
}
