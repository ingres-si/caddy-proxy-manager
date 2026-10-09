"use client";

/**
 * The L4 host editor's tabs: Routing, Load balancing, Security and Advanced,
 * built from the proxy host editor's cards and fields so the two editors
 * look and behave the same.
 */
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/Banner";
import { ChoiceCards } from "@/components/ui/ChoiceCards";
import { AddButton, ChipInput, EditorCard, FieldError, RemoveButton, TextField, ToggleRow, useFieldProps } from "@/src/components/proxy-hosts/editor/fields";
import { SegmentedField, SelectField } from "@/src/components/proxy-hosts/editor/controls";
import { L4_LB_POLICIES, type L4Form, type L4Policy, type L4SectionId } from "./model";

export type L4SectionProps = {
  form: L4Form;
  saved: L4Form;
  update: (recipe: (form: L4Form) => L4Form) => void;
  /** Where the Name and tags card is (Routing for a new host, Advanced for an existing one). */
  nameSection: L4SectionId;
  scopeTags: readonly string[];
};

const grid = "grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] items-start gap-x-5 gap-y-3";

function NameAndTagsCard({ form, saved, update, scopeTags }: L4SectionProps) {
  return (
    <EditorCard id="name-and-tags" title="Name and tags">
      <div className={grid}>
        <TextField id="l4-name" name="name" label="Name" value={form.name} onChange={(name) => update((f) => ({ ...f, name }))} placeholder="PostgreSQL" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium leading-5">Tags</span>
          <ChipInput
            id="l4-tags"
            label="Add tags"
            listLabel="Tags"
            values={form.tags}
            onChange={(tags) => update((f) => ({ ...f, tags }))}
            placeholder="Add a tag"
            addLabel="Add tag"
            normalize={(value) => value.trim().toLowerCase()}
            isNew={(tag) => !saved.tags.includes(tag)}
            testId="host-tags"
            hint={
              scopeTags.length > 0
                ? `Your role manages hosts tagged ${scopeTags.join(", ")}: keep at least one of these tags.`
                : "Letters, digits and . _ : / -"
            }
          />
        </div>
      </div>
    </EditorCard>
  );
}

function UpstreamRow({ index, value, count, onChange, onRemove }: { index: number; value: string; count: number; onChange: (value: string) => void; onRemove: () => void }) {
  const props = useFieldProps(`l4-up-${index}`);
  return (
    <li className="flex flex-col gap-1">
      <div className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-2">
        <Input
          {...props}
          aria-label={`Upstream ${index + 1}`}
          value={value}
          placeholder="10.0.0.5:5432"
          autoComplete="off"
          spellCheck={false}
          className="num"
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            // A pasted list becomes one row each.
            const pasted = event.clipboardData.getData("text");
            if (/[\s,]/.test(pasted.trim())) {
              event.preventDefault();
              onChange(pasted);
            }
          }}
        />
        {count > 1 ? <RemoveButton label={`Remove upstream ${index + 1}`} onClick={onRemove} /> : <span aria-hidden="true" />}
      </div>
      <FieldError id={`l4-up-${index}`} />
    </li>
  );
}

export function RoutingSection(props: L4SectionProps) {
  const { form, update, nameSection } = props;
  const setUpstream = (index: number, value: string) =>
    update((f) => {
      const parts = value.split(/[\s,]+/).filter(Boolean);
      // A pasted list fills this row and adds the rest after it.
      const replacement = parts.length > 1 ? parts : [value];
      return { ...f, upstreams: [...f.upstreams.slice(0, index), ...replacement, ...f.upstreams.slice(index + 1)] };
    });
  const named = form.matcherType === "tls_sni" || form.matcherType === "http_host";
  return (
    <>
      {nameSection === "routing" && <NameAndTagsCard {...props} />}
      <EditorCard id="listener" title="Listener" description="The port Caddy accepts connections on, and how.">
        <div className={grid}>
          <SegmentedField<L4Form["protocol"]>
            id="l4-protocol"
            label="Protocol"
            value={form.protocol}
            onChange={(protocol) => update((f) => ({ ...f, protocol }))}
            options={[
              { value: "tcp", label: "TCP" },
              { value: "udp", label: "UDP" },
            ]}
          />
          <TextField
            id="l4-listen"
            name="listenAddress"
            label="Listen address"
            value={form.listenAddress}
            onChange={(listenAddress) => update((f) => ({ ...f, listenAddress }))}
            placeholder=":5432"
            hint=":PORT or HOST:PORT. Ports 80, 443 and 2019 are Caddy's own."
            mono
          />
        </div>
      </EditorCard>

      <EditorCard id="upstreams" title="Upstreams" description="Where connections go, as host:port. With more than one, Load balancing picks between them.">
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {form.upstreams.map((value, index) => (
            <UpstreamRow
              key={index}
              index={index}
              value={value}
              count={form.upstreams.length}
              onChange={(next) => setUpstream(index, next)}
              onRemove={() => update((f) => ({ ...f, upstreams: f.upstreams.filter((_, i) => i !== index) }))}
            />
          ))}
        </ol>
        <div>
          <AddButton onClick={() => update((f) => ({ ...f, upstreams: [...f.upstreams, ""] }))}>Add upstream</AddButton>
        </div>
      </EditorCard>

      <EditorCard id="matching" title="Matching" description="Which connections on the port this host takes. Hosts on the same port need different matchers.">
        <div className={grid}>
          <SelectField id="l4-matcher" label="Matcher" value={form.matcherType} onChange={(value) => update((f) => ({ ...f, matcherType: value as L4Form["matcherType"] }))}>
            <option value="none">None, every {form.protocol === "udp" ? "datagram" : "connection"}</option>
            <option value="tls_sni">TLS SNI</option>
            <option value="http_host">HTTP host</option>
            <option value="proxy_protocol">PROXY protocol header</option>
          </SelectField>
          {named && (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[13px] font-medium leading-5">{form.matcherType === "tls_sni" ? "SNI hostnames" : "HTTP hostnames"}</span>
              <ChipInput
                id="l4-matcher-value"
                label={form.matcherType === "tls_sni" ? "Add an SNI hostname" : "Add an HTTP hostname"}
                listLabel="Hostnames"
                values={form.matcherValue}
                onChange={(matcherValue) => update((f) => ({ ...f, matcherValue }))}
                placeholder="db.example.com"
                addLabel="Add"
                normalize={(value) => value.trim().toLowerCase()}
              />
            </div>
          )}
        </div>
      </EditorCard>

      <EditorCard id="tls-and-proxy-protocol" title="TLS and PROXY protocol">
        <div className="flex flex-col divide-y divide-line">
          <ToggleRow
            id="l4-tls"
            label="TLS termination"
            description={
              form.protocol === "udp"
                ? "Not available for UDP."
                : "Caddy decrypts TLS with a certificate for the client's server name and forwards plain TCP."
            }
            checked={form.protocol === "tcp" && form.tlsTermination}
            disabled={form.protocol === "udp"}
            onChange={(tlsTermination) => update((f) => ({ ...f, tlsTermination }))}
          />
          <ToggleRow
            id="l4-pp-receive"
            label="Accept inbound PROXY protocol"
            description="For connections from a load balancer that sends the client's address in a PROXY header."
            checked={form.proxyProtocolReceive}
            onChange={(proxyProtocolReceive) => update((f) => ({ ...f, proxyProtocolReceive }))}
          />
          <div className="pt-3">
            <SelectField
              id="l4-pp-send"
              label="Send PROXY protocol to the upstream"
              value={form.proxyProtocolVersion}
              onChange={(value) => update((f) => ({ ...f, proxyProtocolVersion: value as L4Form["proxyProtocolVersion"] }))}
              className="max-w-sm"
            >
              <option value="">None</option>
              <option value="v1">v1</option>
              <option value="v2">v2</option>
            </SelectField>
          </div>
        </div>
      </EditorCard>
    </>
  );
}

export function LoadBalancingSection({ form, update }: L4SectionProps) {
  const lb = form.lb;
  const setLb = (patch: Partial<L4Form["lb"]>) => update((f) => ({ ...f, lb: { ...f.lb, ...patch } }));
  const policy = L4_LB_POLICIES.find((entry) => entry.value === lb.policy);
  const upstreams = form.upstreams.filter((value) => value.trim()).length;
  return (
    <EditorCard
      id="load-balancing"
      title="Load balancing"
      description={upstreams > 1 ? `How connections are spread over the ${upstreams} upstreams.` : "With one upstream there is nothing to spread connections over."}
    >
      {lb.enabled && lb.passive.enabled && upstreams === 1 && (
        <p role="note" className="m-0 rounded-[10px] border border-warn/40 bg-warn-tint px-3 py-2.5 text-[13px]">
          <span className="font-semibold">One upstream with passive health checks:</span>{" "}
          {Number(lb.passive.maxFails) > 1 ? `${lb.passive.maxFails} failed connections take` : "a single failed connection takes"} it out, and with no other
          upstream every connection is refused for {lb.passive.failDuration || "the fail duration"}. Turn passive health checks off, or add another upstream.
        </p>
      )}
      <div className="flex flex-col divide-y divide-line">
        <ToggleRow
          id="l4-lb"
          label="Load balancing and health checks"
          description="Off: each connection goes to a random upstream, without retries."
          checked={lb.enabled}
          onChange={(enabled) => setLb({ enabled })}
        />
        {lb.enabled && (
          <div className="flex flex-col gap-4 py-4">
            <div className={grid}>
              <SelectField id="l4-lb-policy" label="Policy" value={lb.policy} onChange={(value) => setLb({ policy: value as L4Policy })}>
                {L4_LB_POLICIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </SelectField>
              <p className="m-0 text-[13px] text-muted-foreground sm:pt-7">{policy?.description}</p>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-x-4 gap-y-3">
              <TextField id="l4-lb-try-duration" label="Keep trying for" value={lb.tryDuration} onChange={(tryDuration) => setLb({ tryDuration })} placeholder="5s" mono />
              <TextField id="l4-lb-try-interval" label="Wait between tries" value={lb.tryInterval} onChange={(tryInterval) => setLb({ tryInterval })} placeholder="250ms" mono />
            </div>
          </div>
        )}
        {lb.enabled && (
          <div>
            <ToggleRow
              id="l4-lb-active"
              label="Active health checks"
              description="Connect to each upstream on a schedule."
              checked={lb.active.enabled}
              onChange={(enabled) => setLb({ active: { ...lb.active, enabled } })}
            />
            {lb.active.enabled && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-x-4 gap-y-3 pb-3">
                <TextField id="l4-lb-active-port" label="Port" value={lb.active.port} onChange={(port) => setLb({ active: { ...lb.active, port } })} placeholder="Upstream's" inputMode="numeric" mono />
                <TextField id="l4-lb-active-interval" label="Every" value={lb.active.interval} onChange={(interval) => setLb({ active: { ...lb.active, interval } })} placeholder="30s" mono />
                <TextField id="l4-lb-active-timeout" label="Timeout" value={lb.active.timeout} onChange={(timeout) => setLb({ active: { ...lb.active, timeout } })} placeholder="5s" mono />
              </div>
            )}
          </div>
        )}
        {lb.enabled && (
          <div>
            <ToggleRow
              id="l4-lb-passive"
              label="Passive health checks"
              description="Judge each upstream by the connections it fails."
              checked={lb.passive.enabled}
              onChange={(enabled) => setLb({ passive: { ...lb.passive, enabled, failDuration: enabled && !lb.passive.failDuration ? "30s" : lb.passive.failDuration } })}
            />
            {lb.passive.enabled && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-x-4 gap-y-3 pb-1">
                <TextField id="l4-lb-passive-duration" label="Remember failures for" value={lb.passive.failDuration} onChange={(failDuration) => setLb({ passive: { ...lb.passive, failDuration } })} placeholder="30s" mono />
                <TextField id="l4-lb-passive-max" label="Failures before unhealthy" value={lb.passive.maxFails} onChange={(maxFails) => setLb({ passive: { ...lb.passive, maxFails } })} placeholder="1" inputMode="numeric" mono />
              </div>
            )}
          </div>
        )}
      </div>
    </EditorCard>
  );
}

type GeoList = Exclude<keyof L4Form["geo"], "enabled" | "mode">;

const GEO_FIELDS: { key: GeoList; label: string; placeholder: string; upper?: boolean }[][] = [
  [
    { key: "blockCountries", label: "Countries", placeholder: "CN", upper: true },
    { key: "blockContinents", label: "Continents", placeholder: "AS", upper: true },
    { key: "blockAsns", label: "Networks (ASN)", placeholder: "13335" },
    { key: "blockCidrs", label: "Address ranges", placeholder: "192.0.2.0/24" },
    { key: "blockIps", label: "Addresses", placeholder: "203.0.113.1" },
  ],
  [
    { key: "allowCountries", label: "Countries", placeholder: "DE", upper: true },
    { key: "allowContinents", label: "Continents", placeholder: "EU", upper: true },
    { key: "allowAsns", label: "Networks (ASN)", placeholder: "3320" },
    { key: "allowCidrs", label: "Address ranges", placeholder: "10.0.0.0/8" },
    { key: "allowIps", label: "Addresses", placeholder: "198.51.100.7" },
  ],
];

const GEO_ID: Record<GeoList, string> = {
  blockCountries: "l4-geo-block-countries",
  blockContinents: "l4-geo-block-continents",
  blockAsns: "l4-geo-block-asns",
  blockCidrs: "l4-geo-block-cidrs",
  blockIps: "l4-geo-block-ips",
  allowCountries: "l4-geo-allow-countries",
  allowContinents: "l4-geo-allow-continents",
  allowAsns: "l4-geo-allow-asns",
  allowCidrs: "l4-geo-allow-cidrs",
  allowIps: "l4-geo-allow-ips",
};

export function SecuritySection({ form, saved, update }: L4SectionProps) {
  const geo = form.geo;
  const setGeo = (patch: Partial<L4Form["geo"]>) => update((f) => ({ ...f, geo: { ...f.geo, ...patch } }));
  return (
    <EditorCard id="geo-blocking" title="Geo blocking" description="Close connections by the client's country, continent, network or address.">
      <div className="flex flex-col gap-4">
        <ToggleRow id="l4-geo" label="This host's own rules" checked={geo.enabled} onChange={(enabled) => setGeo({ enabled })} className="py-0" />
        <ChoiceCards<L4Form["geo"]["mode"]>
          label="How the host's rules combine with the global ones"
          value={geo.mode}
          onChange={(mode) => setGeo({ mode })}
          options={[
            { value: "merge", label: "Add to the global rules", description: "The global geo blocking rules apply too." },
            { value: "override", label: "Replace the global rules", description: geo.enabled ? "Only this host's rules apply." : "No geo blocking for this host." },
          ]}
        />
        {geo.enabled &&
          GEO_FIELDS.map((fields, group) => (
            <div key={group} className="flex flex-col gap-3 border-t border-line pt-4">
              <h4 className="m-0 text-sm font-semibold">{group === 0 ? "Block" : "Allow (wins over block)"}</h4>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-5 gap-y-3">
                {fields.map((field) => (
                  <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-[13px] font-medium leading-5">{field.label}</span>
                    <ChipInput
                      id={GEO_ID[field.key]}
                      label={`${group === 0 ? "Block" : "Allow"} ${field.label.toLowerCase()}`}
                      values={geo[field.key]}
                      onChange={(values) => setGeo({ [field.key]: values } as Partial<L4Form["geo"]>)}
                      placeholder={field.placeholder}
                      normalize={(value) => (field.upper ? value.trim().toUpperCase() : value.trim())}
                      isNew={(value) => !saved.geo[field.key].includes(value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        <Banner tone="info" icon={null} title="Geo blocking at L4 sees the client's direct address.">
          There is no X-Forwarded-For at L4: behind another proxy, accept inbound PROXY protocol (Routing) so the client&apos;s address is known.
        </Banner>
      </div>
    </EditorCard>
  );
}

export function AdvancedSection(props: L4SectionProps) {
  const { form, update, nameSection } = props;
  const dns = form.dns;
  const setDns = (patch: Partial<L4Form["dns"]>) => update((f) => ({ ...f, dns: { ...f.dns, ...patch } }));
  return (
    <>
      {nameSection === "advanced" && <NameAndTagsCard {...props} />}
      <EditorCard id="dns-resolvers" title="DNS resolvers" description="Which servers resolve upstream names. Off: the global resolvers.">
        <div className="flex flex-col gap-3">
          <ToggleRow id="l4-dns" label="Own resolvers for this host" checked={dns.enabled} onChange={(enabled) => setDns({ enabled })} className="py-0" />
          {dns.enabled && (
            <div className={grid}>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13px] font-medium leading-5">Resolvers</span>
                <ChipInput id="l4-dns-resolvers" label="Add a resolver" values={dns.resolvers} onChange={(resolvers) => setDns({ resolvers })} placeholder="1.1.1.1" />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13px] font-medium leading-5">Fallbacks</span>
                <ChipInput id="l4-dns-fallbacks" label="Add a fallback resolver" values={dns.fallbacks} onChange={(fallbacks) => setDns({ fallbacks })} placeholder="8.8.8.8" />
              </div>
              <TextField id="l4-dns-timeout" label="Timeout" value={dns.timeout} onChange={(timeout) => setDns({ timeout })} placeholder="5s" mono className="max-w-[200px]" />
            </div>
          )}
        </div>
      </EditorCard>
      <EditorCard id="upstream-dns-pinning" title="Upstream DNS pinning" description="Resolve upstream names when the configuration is applied and connect to the addresses found.">
        <div className={grid}>
          <SelectField
            id="l4-pinning"
            label="Resolution"
            value={form.pinning.mode}
            onChange={(mode) => update((f) => ({ ...f, pinning: { ...f.pinning, mode: mode as L4Form["pinning"]["mode"] } }))}
          >
            <option value="inherit">As in Host defaults</option>
            <option value="enabled">On</option>
            <option value="disabled">Off</option>
          </SelectField>
          <SelectField
            id="l4-pinning-family"
            label="Address family"
            value={form.pinning.family}
            onChange={(family) => update((f) => ({ ...f, pinning: { ...f.pinning, family: family as L4Form["pinning"]["family"] } }))}
          >
            <option value="inherit">As in Host defaults</option>
            <option value="both">IPv6 and IPv4</option>
            <option value="ipv6">IPv6 only</option>
            <option value="ipv4">IPv4 only</option>
          </SelectField>
        </div>
      </EditorCard>
    </>
  );
}
