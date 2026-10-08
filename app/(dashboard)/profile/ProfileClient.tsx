"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/src/lib/auth-client";
import { Camera, LogIn, LogOut, Trash2, Unlink } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import type { ApiToken } from "@/lib/models/api-tokens";
import type { PasswordSignInBlocker } from "@/src/lib/models/user";
import type { SessionView } from "@/src/lib/models/sessions";
import type { PasskeyView } from "@/src/lib/passkeys";
import type { Permission } from "@/src/lib/permissions";
import { passwordPolicyMessage } from "@/src/lib/password-policy";
import type { MfaStatus } from "@/src/lib/mfa";
import SignInSecurity from "./SignInSecurity";
import SessionsSection from "./SessionsSection";
import TokensSection from "./TokensSection";
import InterfaceSection from "./InterfaceSection";

interface UserData {
  id: number;
  email: string;
  name: string | null;
  provider: string | null;
  subject: string | null;
  hasPassword: boolean;
  /** The login page username, or null when the user cannot sign in there without OAuth. */
  signInUsername: string | null;
  /** Why signInUsername is null. */
  passwordSignInBlocker: PasswordSignInBlocker | null;
  role: string;
  /** The role as people read it: Administrator, User, or the custom role's name. */
  roleLabel?: string;
  avatarUrl: string | null;
}

/**
 * What keeps the login page from accepting the user's password and how to fix
 * it, or null when it accepts it or the user has not set one (which needs no
 * explanation).
 */
export function passwordSignInProblem(user: Pick<UserData, "signInUsername" | "passwordSignInBlocker" | "hasPassword">): string | null {
  if (user.signInUsername) return null;
  if (user.passwordSignInBlocker === "no-username") {
    const prefix = "Your account has no sign-in username the login page can use, so you cannot sign in there with a password. " +
      "An administrator has to set a sign-in username for your account";
    return user.hasPassword
      ? `${prefix}. This page then shows it.`
      : `${prefix}, then you can set your password here.`;
  }
  if (user.hasPassword) {
    return "Your password cannot be used on the sign-in page yet. Change it once here to enable password sign-in.";
  }
  return null;
}

function providerLabel(provider: string): string {
  if (provider === "credentials" || provider === "credential") return "Password";
  if (provider.startsWith("ldap:")) return "LDAP directory";
  if (provider.startsWith("saml:")) return "SAML provider";
  return provider;
}

function initialsOf(name: string | null, email: string): string {
  const source = (name ?? "").trim() || email.split("@")[0];
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2)).toUpperCase();
}

interface ProfileClientProps {
  user: UserData;
  /** Linked OAuth identities, read from the authoritative accounts table (#261). */
  linkedProviders: Array<{ providerId: string; accountId: string }>;
  enabledProviders: Array<{ id: string; name: string; autoLink: boolean; host?: string | null }>;
  apiTokens: ApiToken[];
  maxApiTokens?: number;
  sessions: SessionView[];
  /** Multi-factor authentication state; never holds the secret or the backup codes. */
  mfa: MfaStatus;
  passkeys?: PasskeyView[];
  /** Why the account cannot add a passkey now; null when it can. */
  passkeyBlocker?: string | null;
  /** Enforced SSO: whether it is on and whether this account is a break-glass account. */
  sso?: { enforced: boolean; breakGlass: boolean };
  /** What the user's role holds: the permissions an API token can be limited to. */
  heldPermissions?: Permission[];
}

export default function ProfileClient({
  user,
  linkedProviders,
  enabledProviders,
  apiTokens,
  maxApiTokens = 10,
  sessions,
  mfa,
  passkeys = [],
  passkeyBlocker = null,
  sso = { enforced: false, breakGlass: false },
  heldPermissions = [],
}: ProfileClientProps) {
  const router = useRouter();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [unlinkDialogOpen, setUnlinkDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.avatarUrl);

  const hasPassword = user.hasPassword;
  const canUnlinkOAuth = user.signInUsername !== null;
  const signInProblem = passwordSignInProblem(user);
  const linked = linkedProviders.map((link) => {
    const provider = enabledProviders.find((p) => p.id === link.providerId);
    return { id: link.providerId, name: provider?.name ?? providerLabel(link.providerId), host: provider?.host ?? null };
  });
  const hasOAuth = linked.length > 0;
  // While SSO is enforced only a break-glass account's password still works.
  const passwordRefused = sso.enforced && !sso.breakGlass;

  const openPasswordDialog = () => {
    setPasswordError(null);
    setPasswordDialogOpen(true);
  };

  const handlePasswordChange = async () => {
    setPasswordError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }

    // Mirrors the server-side policy so most mistakes show up without a round trip.
    const policyError = passwordPolicyMessage(newPassword);
    if (policyError) {
      setPasswordError(policyError);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        setPasswordError(data.error || "Failed to change password");
        setLoading(false);
        return;
      }
      setSuccess(data.message || "Password changed.");
      setPasswordDialogOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setLoading(false);
      // Picks up hasPassword for a first password and drops the revoked sessions.
      router.refresh();
    } catch {
      setPasswordError("An error occurred while changing password");
      setLoading(false);
    }
  };

  const handleUnlinkOAuth = async () => {
    if (!canUnlinkOAuth) {
      setError("Cannot unlink OAuth: You must set a password first");
      return;
    }
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const response = await fetch("/api/user/unlink-oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Failed to unlink OAuth");
        setLoading(false);
        return;
      }
      setSuccess("Unlinked. Reloading…");
      setUnlinkDialogOpen(false);
      setLoading(false);
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setError("An error occurred while unlinking OAuth");
      setLoading(false);
    }
  };

  const handleLinkOAuth = async (providerId: string) => {
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      // linkSocial (not signIn.social) binds the identity to the session user
      // and requires the provider email to match, so an unrelated IdP account
      // cannot silently swap the browser onto a different Ingressi user.
      const { error: linkError } = await authClient.linkSocial({ provider: providerId, callbackURL: "/profile" });
      if (linkError) {
        setError(linkError.message || "Failed to start OAuth linking. Enable \"Auto-link accounts\" for this provider first.");
        setLoading(false);
      }
      // On success the client follows the provider redirect.
    } catch {
      setError("An error occurred while linking OAuth");
      setLoading(false);
    }
  };

  const uploadAvatar = async (value: string | null, done: string) => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/user/update-avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: value }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Failed to update the picture");
        setLoading(false);
        return;
      }
      setAvatarUrl(value);
      setSuccess(done);
      setLoading(false);
      setTimeout(() => window.location.reload(), 1000);
    } catch {
      setError("An error occurred while updating the picture");
      setLoading(false);
    }
  };

  const handleAvatarUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Image must be smaller than 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => void uploadAvatar(reader.result as string, "Picture updated. Refreshing…");
    reader.readAsDataURL(file);
  };

  const unlinkedProviders = enabledProviders.filter((provider) => !linked.some((link) => link.id === provider.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        breadcrumb={["Account", "Profile"]}
        title="Profile"
        actions={
          <form action="/api/auth/logout" method="POST">
            <Button type="submit" variant="outline">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </form>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {error}
            <Button variant="ghost" size="sm" onClick={() => setError(null)} className="h-auto p-0 text-xs">Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-2">
            {success}
            <Button variant="ghost" size="sm" onClick={() => setSuccess(null)} className="h-auto p-0 text-xs">Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="acct-title" className="flex flex-col gap-5 rounded-xl border bg-card p-6">
          <h2 id="acct-title" className="text-base font-semibold">Account</h2>

          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={avatarUrl || undefined} alt={user.name || user.email} />
              <AvatarFallback className="text-lg font-semibold">{initialsOf(user.name, user.email)}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild disabled={loading}>
                  <label className="cursor-pointer">
                    <Camera className="h-4 w-4" />
                    Upload picture
                    <input type="file" className="sr-only" accept="image/*" onChange={handleAvatarUpload} />
                  </label>
                </Button>
                {avatarUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void uploadAvatar(null, "Picture removed. Refreshing…")}
                    disabled={loading}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                )}
              </div>
              <span className="text-xs text-muted-foreground">Square image, up to 2 MB.</span>
            </div>
          </div>

          <dl className="grid gap-4 text-sm sm:grid-cols-[minmax(0,10rem)_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.name || "Not set"}</dd>
            <dt className="text-muted-foreground">E-mail</dt>
            <dd className="break-all">{user.email}</dd>
            {user.signInUsername && (
              <>
                <dt className="text-muted-foreground">Sign-in username</dt>
                <dd className="flex flex-col gap-0.5">
                  <span className="font-mono">{user.signInUsername}</span>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Role</dt>
            <dd>{user.roleLabel ?? user.role}</dd>
            <dt className="text-muted-foreground">Signs in with</dt>
            <dd className="flex flex-col gap-1">
              <span>
                {[
                  ...(hasPassword ? ["Password"] : []),
                  ...linked.map((link) => (link.host ? `${link.name}, through ${link.host}` : link.name)),
                ].join(" · ") || "No sign-in method yet"}
              </span>
              {passwordRefused && hasPassword && (
                <span className="text-xs text-muted-foreground">Password sign-in is off while single sign-on is enforced.</span>
              )}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">Only an administrator can change your name and e-mail.</p>

          {(enabledProviders.length > 0 || hasOAuth) && (
            <div className="flex flex-col gap-3 border-t pt-4">
              <h3 className="text-sm font-medium">Identity providers</h3>
              {hasOAuth && (
                canUnlinkOAuth ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Your account is linked to {linked.map((link) => link.name).join(", ")}.
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setUnlinkDialogOpen(true)}>
                      <Unlink className="h-4 w-4" />
                      Unlink OAuth Account
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {signInProblem
                      ? `${signInProblem} OAuth can be unlinked once password sign-in works.`
                      : "To unlink OAuth, you must first set a password as a fallback authentication method."}
                  </p>
                )
              )}
              {!hasOAuth && unlinkedProviders.length > 0 && (
                <div className="flex flex-col gap-2">
                  {unlinkedProviders.map((provider) => (
                    <div key={provider.id} className="flex flex-col gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        onClick={() => handleLinkOAuth(provider.id)}
                        disabled={!provider.autoLink || loading}
                      >
                        <LogIn className="h-4 w-4" />
                        Link {provider.name}
                      </Button>
                      {!provider.autoLink && (
                        <p className="text-xs text-muted-foreground">
                          Enable &quot;Auto-link accounts&quot; for {provider.name} in Sign-in and directories → OAuth providers to allow linking.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <SignInSecurity
          hasPassword={hasPassword}
          signInProblem={signInProblem}
          oauthOnlyNote={!hasPassword && !signInProblem}
          passwordRefused={passwordRefused}
          ssoEnforced={sso.enforced}
          ssoHost={linked.find((link) => link.host)?.host ?? enabledProviders.find((p) => p.host)?.host ?? null}
          mfa={mfa}
          passkeys={passkeys}
          passkeyBlocker={passkeyBlocker}
          onChangePassword={openPasswordDialog}
        />
      </div>

      <SessionsSection sessions={sessions} />

      <TokensSection tokens={apiTokens} maxTokens={maxApiTokens} heldPermissions={heldPermissions} />

      <InterfaceSection />

      {/* Change password dialog */}
      <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{hasPassword ? "Change password" : "Set password"}</DialogTitle>
            <DialogDescription>
              {hasPassword
                ? "Signing in again is needed everywhere else: your other sessions end."
                : "A password lets you sign in on the login page as well as through your identity provider."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 flex flex-col gap-3">
            {passwordError && (
              <Alert variant="destructive">
                <AlertDescription>{passwordError}</AlertDescription>
              </Alert>
            )}
            {hasPassword && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currentPassword">Current password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">Minimum 12 characters.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordDialogOpen(false)}>Cancel</Button>
            <Button onClick={handlePasswordChange} disabled={loading}>
              {loading ? "Saving…" : hasPassword ? "Change password" : "Set password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlink OAuth dialog */}
      <Dialog open={unlinkDialogOpen} onOpenChange={setUnlinkDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unlink your identity provider</DialogTitle>
            <DialogDescription>
              Unlink your {linked.map((link) => link.name).join(", ")} account? You will only be able to sign in with your
              username ({user.signInUsername}) and password after this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlinkDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleUnlinkOAuth} variant="destructive" disabled={loading}>
              {loading ? "Unlinking…" : "Unlink OAuth"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
