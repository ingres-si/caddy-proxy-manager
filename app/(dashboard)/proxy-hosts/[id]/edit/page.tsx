import { redirect } from "next/navigation";
import { isSectionId } from "@/src/components/proxy-hosts/editor/changes";

type PageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ section?: string }> };

/**
 * The editor is part of the host's page now (its tabs). Old links land
 * there: ?section=security opens that tab; an anchor (#waf) carries over,
 * since the redirect names none.
 */
export default async function EditProxyHostPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { section } = await searchParams;
  redirect(`/proxy-hosts/${encodeURIComponent(id)}${section && isSectionId(section) ? `#${section}` : ""}`);
}
