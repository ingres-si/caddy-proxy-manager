import bcrypt from "bcryptjs";
import { appDb, nowIso } from "./db";
import { config, DEFAULT_ADMIN_PASSWORD, DISALLOWED_ADMIN_PASSWORDS } from "./config";
import { users, accounts, settings } from "./db/schema";
import { and, eq } from "drizzle-orm";
import { CREDENTIAL_ACCOUNT_ISSUER } from "./account-issuer";
import { changeUserPassword, deleteOrphanedUserReferences } from "./models/user";
import { isSignInNameTaken, signInEmailConflict } from "./sign-in-names";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { resetUserMfa } from "./mfa";
import { logAuditEvent } from "./audit";
import { first, resyncIdentity } from "@/src/lib/db/ops";

const BCRYPT_COST = 12;

/**
 * Settings key recording the ADMIN_USERNAME and a bcrypt hash of the
 * ADMIN_PASSWORD last seen in the environment. The environment credentials are
 * re-applied only when they change, so a password changed in the UI is not
 * silently reverted to the environment value on every restart. The key name
 * predates the current format; any other value stored there counts as no marker.
 */
const ADMIN_ENV_MARKER_KEY = "admin_env_credentials_fingerprint";

type AdminEnvMarker = { v: 2; username: string; passwordHash: string };

/** The stored marker, or null when the row is missing or holds anything else. */
async function getAdminEnvMarker(): Promise<AdminEnvMarker | null> {
  const row = await first(appDb.select().from(settings).where(eq(settings.key, ADMIN_ENV_MARKER_KEY)).limit(1));
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<AdminEnvMarker> | null;
    if (
      value && typeof value === "object" && value.v === 2 &&
      typeof value.username === "string" && typeof value.passwordHash === "string"
    ) {
      return { v: 2, username: value.username, passwordHash: value.passwordHash };
    }
  } catch {
    // Not a marker.
  }
  return null;
}

async function storeAdminEnvMarker(passwordHash: string): Promise<void> {
  const now = nowIso();
  const marker: AdminEnvMarker = { v: 2, username: config.adminUsername, passwordHash };
  const value = JSON.stringify(marker);
  await appDb
    .insert(settings)
    .values({ key: ADMIN_ENV_MARKER_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

async function passwordMatches(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Whether the hash is of 'admin' or of an example password from the docs. */
async function isKnownPublicPassword(hash: string): Promise<boolean> {
  for (const candidate of [DEFAULT_ADMIN_PASSWORD, ...DISALLOWED_ADMIN_PASSWORDS]) {
    if (await passwordMatches(candidate, hash)) return true;
  }
  return false;
}

/**
 * Throws unless the primary admin can take the username and email address in
 * `identity`: no other account may sign in with either or have it as its
 * email address (see sign-in-names.ts), or one name would reach two accounts.
 * Nothing is written then, and the next start tries again.
 */
async function assertAdminIdentityAvailable(adminId: number, identity: { username: string; email: string }): Promise<void> {
  if (await isSignInNameTaken(appDb, adminId, identity.username) || await signInEmailConflict(appDb, adminId, identity.email)) {
    throw new Error(
      `ADMIN_USERNAME ${JSON.stringify(config.adminUsername)} is not applied: another account already signs in with it ` +
      "or has it as its email address. Give that account a different username or email address on the Users page, " +
      "or choose another ADMIN_USERNAME."
    );
  }
}

/**
 * Enforced SSO (ee/sso) also applies to the primary admin: applying
 * ADMIN_USERNAME/ADMIN_PASSWORD resets the password but is no way around
 * enforcement, or every install would keep a password sign-in that the
 * break-glass list does not show. The env reset restores password sign-in
 * only when the primary admin is a break-glass account; say so when it is not.
 */
async function warnWhenSsoEnforcementBlocksAdmin(adminId: number): Promise<void> {
  try {
    const enforcement = await readSsoEnforcement(appDb);
    if (!enforcement.enabled || enforcement.breakGlassUserIds.includes(adminId)) return;
    console.warn(
      `Enforced SSO is on and ${config.adminUsername} is not a break-glass account, so ADMIN_PASSWORD does not let it ` +
      "sign in with a password. Sign in through the identity provider or with a break-glass account, or turn " +
      "enforcement off as described in ee/docs/sso-enforcement.md."
    );
  } catch {
    // Informational only.
  }
}

/**
 * Changed ADMIN_USERNAME/ADMIN_PASSWORD are the documented account recovery,
 * so they also turn off the primary admin's multi-factor authentication: an
 * operator who lost the admin's authenticator and backup codes can get back
 * in with the new password and set MFA up again. Whoever can change the
 * environment of the web container already controls the installation.
 */
async function clearAdminMfaForRecovery(adminId: number): Promise<void> {
  if (!await resetUserMfa(adminId)) return;
  console.log(
    `Turned off multi-factor authentication for ${config.adminUsername} because the environment credentials ` +
    "changed (account recovery). Set it up again from Profile."
  );
  await logAuditEvent({
    userId: null,
    action: "mfa_reset",
    entityType: "user",
    entityId: adminId,
    summary: "Reset multi-factor authentication of the primary admin: ADMIN_USERNAME/ADMIN_PASSWORD changed",
  });
}

/**
 * Creates the primary admin from the environment variables on a fresh
 * install, and applies changed environment credentials to it (account
 * recovery). A primary admin that was deleted is not created again on a
 * restart, only when the environment credentials change. Called during
 * application startup. Before that, it clears rows left under the ids of
 * deleted users, so neither the primary admin nor any later user inherits them.
 */

//Todo: this could probably be handled better, especially for the adminid.
export async function ensureAdminUser(): Promise<void> {
  const adminId = 1; // Must match the hardcoded ID in auth.ts
  const adminEmail = `${config.adminUsername}@localhost`;
  const provider = "credentials";
  const subject = config.adminUsername;

  const clearedUserIds = await deleteOrphanedUserReferences();
  if (clearedUserIds.length > 0) {
    console.log(`Cleared rows left by deleted user id(s) ${clearedUserIds.join(", ")}`);
  }

  // Check if admin user already exists
  const existingUser = await appDb.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, adminId)
  });

  if (existingUser) {
    const storedHash = existingUser.passwordHash;
    let envMatchesStored: boolean | undefined;
    const envPasswordIsStored = async () =>
      (envMatchesStored ??= !!storedHash && await passwordMatches(config.adminPassword, storedHash));

    const marker = await getAdminEnvMarker();
    let applyEnvCredentials: boolean;
    if (marker) {
      applyEnvCredentials = marker.username !== config.adminUsername ||
        !(await passwordMatches(config.adminPassword, marker.passwordHash));
    } else if (!storedHash || await envPasswordIsStored() || await isKnownPublicPassword(storedHash)) {
      // No marker: the first start after the upgrade that introduced it
      // (until then every start re-applied the environment). Apply the
      // environment when the stored password is the environment one or a
      // publicly known one; any other password was changed in the UI.
      applyEnvCredentials = true;
    } else {
      applyEnvCredentials = false;
      console.warn(
        "ADMIN_PASSWORD differs from the stored admin password; keeping the stored password because it was " +
        "probably changed in the UI. Change ADMIN_PASSWORD again and recreate the web container (docker compose up -d) " +
        "to force it."
      );
    }

    const identity = {
      email: adminEmail,
      subject,
      username: config.adminUsername.toLowerCase(),
      displayUsername: config.adminUsername,
    };
    const appliesIdentity = applyEnvCredentials || (!marker && existingUser.username !== identity.username);
    if (appliesIdentity && (existingUser.username !== identity.username || existingUser.email !== identity.email)) {
      await assertAdminIdentityAvailable(adminId, identity);
    }
    if (applyEnvCredentials) {
      const passwordChanged = !(await envPasswordIsStored());
      const passwordHash = storedHash && !passwordChanged
        ? storedHash
        : await bcrypt.hash(config.adminPassword, BCRYPT_COST);
      if (passwordChanged) {
        // Sets the password and ends every sign-in made with the previous one
        // in one transaction, so a failure leaves the old password in place
        // and the next start tries again.
        await changeUserPassword(adminId, passwordHash, null);
      }
      // Changed environment credentials are the documented recovery path, so
      // they also make the primary admin active again. Re-applying unchanged
      // ones (the first start without a marker) leaves the status alone.
      const envChanged = marker !== null || passwordChanged || existingUser.username !== identity.username;
      await appDb
        .update(users)
        .set({
          ...identity,
          role: "admin",
          ...(envChanged ? { status: "active" } : {}),
          updatedAt: nowIso()
        })
        .where(eq(users.id, adminId));
      // Ensure credential account row exists for Better Auth
      await ensureCredentialAccount(adminId, passwordHash);
      if (envChanged) await clearAdminMfaForRecovery(adminId);
      await storeAdminEnvMarker(passwordHash);
      console.log(`Applied admin credentials from environment: ${config.adminUsername}`);
      await warnWhenSsoEnforcementBlocksAdmin(adminId);
    } else {
      // Keep the stored password and role.
      if (!marker && existingUser.username !== identity.username) {
        // Without a marker, ADMIN_USERNAME was applied on every start, so a
        // changed one is applied even though the password is kept.
        await appDb
          .update(users)
          .set({ ...identity, updatedAt: nowIso() })
          .where(eq(users.id, adminId));
        console.log(`Applied admin username from environment: ${config.adminUsername}`);
      }
      if (storedHash) {
        await ensureCredentialAccount(adminId, storedHash, { overwrite: false });
      }
      if (!marker) {
        // Record the current environment so that changing it again applies it.
        await storeAdminEnvMarker(await bcrypt.hash(config.adminPassword, BCRYPT_COST));
      }
      console.log(`Admin user present: ${config.adminUsername}`);
    }
    return;
  }

  // No primary admin. On a fresh install (no accounts, no marker) it is
  // created. Otherwise it was deleted on purpose, and stays deleted until the
  // environment credentials change: the documented recovery path creates it
  // again, an unchanged environment on a restart does not.
  const marker = await getAdminEnvMarker();
  if (marker) {
    const envChanged = marker.username !== config.adminUsername ||
      !(await passwordMatches(config.adminPassword, marker.passwordHash));
    if (!envChanged) {
      console.log(
        "The primary admin was deleted and is not created again. To create it again, change ADMIN_PASSWORD " +
        "(or ADMIN_USERNAME) and recreate the web container (docker compose up -d)."
      );
      return;
    }
  } else if (await first(appDb.select({ id: users.id }).from(users).limit(1))) {
    // Accounts but no marker: the primary admin was deleted before releases
    // recorded the environment. Record it now, so that changing it creates
    // the admin again.
    await storeAdminEnvMarker(await bcrypt.hash(config.adminPassword, BCRYPT_COST));
    console.log(
      "There is no primary admin (it was deleted), so none is created. To create it, change ADMIN_PASSWORD " +
      "(or ADMIN_USERNAME) and recreate the web container (docker compose up -d)."
    );
    return;
  }

  const username = config.adminUsername.toLowerCase();

  // Hash the admin password for secure storage (before the transaction:
  // only database work runs inside one).
  const passwordHash = await bcrypt.hash(config.adminPassword, BCRYPT_COST);

  // Check the names and create the admin, its credential account and the
  // marker in one transaction: nothing is half-created, and a second process
  // starting at the same time finds the admin there.
  const created = await appDb.transaction(async (tx) => {
    if (await first(tx.select({ id: users.id }).from(users).where(eq(users.id, adminId)).limit(1))) return false;
    await assertAdminIdentityAvailable(adminId, { username, email: adminEmail });
    const now = nowIso();
    await tx.insert(users).values({
      id: adminId,
      email: adminEmail,
      name: config.adminUsername,
      passwordHash,
      role: "admin",
      provider,
      subject,
      username,
      displayUsername: config.adminUsername,
      avatarUrl: null,
      status: "active",
      createdAt: now,
      updatedAt: now
    });
    // The id was given: on PostgreSQL the next generated user id must follow it.
    await resyncIdentity(users, tx);
    // Ensure credential account row exists for Better Auth
    await ensureCredentialAccount(adminId, passwordHash);
    await storeAdminEnvMarker(passwordHash);
    return true;
  });

  if (created) console.log(`Created admin user: ${config.adminUsername}`);
}

/**
 * Ensures a credential account row exists in the accounts table for Better Auth.
 * Better Auth requires an accounts row with providerId="credential" and the password hash.
 */
async function ensureCredentialAccount(
  userId: number,
  passwordHash: string,
  { overwrite = true }: { overwrite?: boolean } = {}
): Promise<void> {
  const now = nowIso();
  const existing = await first(appDb.select().from(accounts).where(
    and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, "credential"),
      eq(accounts.issuer, CREDENTIAL_ACCOUNT_ISSUER)
    )
  ).limit(1));

  if (existing) {
    if (!overwrite) return;
    // Update password hash if changed
    await appDb.update(accounts).set({
      password: passwordHash,
      updatedAt: now,
    }).where(eq(accounts.id, existing.id));
  } else {
    await appDb.insert(accounts).values({
      userId,
      issuer: CREDENTIAL_ACCOUNT_ISSUER,
      accountId: userId.toString(),
      providerId: "credential",
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }
}
