/**
 * The profile page shows the username the login page accepts and, when there
 * is none, why: advice to change the password only where that fixes it, and
 * otherwise that an administrator has to set a sign-in username. It never
 * promises a username made from the email address.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/profile',
  useSearchParams: () => navigation.search,
}));
vi.mock('@/src/lib/auth-client', () => ({ authClient: { signIn: { social: vi.fn() } } }));

import ProfileClient from '@/app/(dashboard)/profile/ProfileClient';
import { textContent } from '../helpers/text';

type Props = Parameters<typeof ProfileClient>[0];

const CHANGE_ONCE = 'Change it once here to enable password sign-in';
const NO_USERNAME = 'Your account has no sign-in username the login page can use';
const ADMIN_SETS = 'An administrator has to set a sign-in username for your account';
const SET_FIRST = 'you must first set a password';

function render(user: Partial<Props['user']>, mfa: Partial<Props['mfa']> = {}, extra: Partial<Props> = {}) {
  const props: Props = {
    user: {
      id: 7,
      email: 'alice+ingressi@example.com',
      name: 'Alice',
      provider: 'dex',
      subject: 'dex-7',
      hasPassword: true,
      signInUsername: null,
      passwordSignInBlocker: null,
      role: 'user',
      avatarUrl: null,
      ...user,
    },
    linkedProviders: [{ providerId: 'dex', accountId: 'dex-7' }],
    enabledProviders: [{ id: 'dex', name: 'Dex', autoLink: true }],
    apiTokens: [],
    sessions: [],
    mfa: {
      enabled: false, authenticatorApp: false, passkeys: 0, backupCodesRemaining: null, hasPassword: true, required: false,
      gate: 'none', deadline: null,
      ...mfa,
    },
    ...extra,
  };
  return renderToStaticMarkup(createElement(ProfileClient, props));
}

describe('profile multi-factor authentication', () => {
  it('offers to set it up for an account with a password', () => {
    const html = render({ signInUsername: 'alice' });
    expect(html).toContain('Sign-in security');
    expect(html).toContain('Multi-factor off');
    expect(html).toContain('Set up authenticator app');
    expect(html).toContain('Add a passkey');
  });

  it('shows how many backup codes are left, never the codes', () => {
    const html = render({ signInUsername: 'alice' }, { enabled: true, authenticatorApp: true, backupCodesRemaining: 2 });
    expect(html).toContain('2 of 10 left');
    expect(html).toContain('Generate new backup codes');
    expect(html).toContain('Turn off');
    expect(html).not.toContain('Set up authenticator app');
  });

  it('keeps it on when the policy requires it, and shows the deadline while it is off', () => {
    const on = render({ signInUsername: 'alice' }, { enabled: true, authenticatorApp: true, backupCodesRemaining: 9, required: true });
    expect(on).toContain('cannot be turned off');
    const off = render({ signInUsername: 'alice' }, { required: true, gate: 'prompt', deadline: '2026-10-09T12:00:00.000Z' });
    expect(off).toContain('Your administrator requires multi-factor authentication');
    expect(off).toContain('Required');
  });

  it('explains that an account without a password uses its identity provider', () => {
    const html = render({ hasPassword: false }, { hasPassword: false });
    expect(html).toContain('Your identity provider handles multi-factor authentication.');
    expect(html).not.toContain('Set up authenticator app');
  });
});

describe('profile password sign-in', () => {
  it('shows the sign-in username and the unlink button when password sign-in works', () => {
    const html = render({ signInUsername: 'alice' });
    expect(html).toContain('Sign-in username');
    expect(html).toContain('>alice<');
    expect(html).toContain('Unlink OAuth Account');
    expect(html).not.toContain(CHANGE_ONCE);
    expect(html).not.toContain(NO_USERNAME);
  });

  it('suggests changing the password once when that sets up password sign-in', () => {
    const html = render({ passwordSignInBlocker: 'no-credential' });
    expect(html).toContain(CHANGE_ONCE);
    expect(html).not.toContain(NO_USERNAME);
    expect(html).not.toContain('Unlink OAuth Account');
    expect(html).not.toContain('Sign-in username');
  });

  it('explains a missing username instead of suggesting a password change', () => {
    const html = render({ passwordSignInBlocker: 'no-username' });
    expect(html).toContain(NO_USERNAME);
    expect(html).toContain(ADMIN_SETS);
    expect(html).toContain('This page then shows it.');
    expect(html).not.toContain('then you can set your password here');
    expect(html).not.toContain(CHANGE_ONCE);
    expect(html).not.toContain('Unlink OAuth Account');
    expect(html).not.toContain('Sign-in username</p>');
  });

  it('never says a username is made from the email address', () => {
    for (const hasPassword of [true, false]) {
      const html = render({ hasPassword, passwordSignInBlocker: 'no-username' });
      expect(html).not.toMatch(/made from|could be made|generated|change your email address/i);
    }
  });

  it('asks an OAuth-only user to set a password first', () => {
    const html = render({ hasPassword: false, passwordSignInBlocker: 'no-credential' });
    expect(html).toContain(SET_FIRST);
    expect(html).toContain('You sign in through your identity provider.');
    expect(html).not.toContain(CHANGE_ONCE);
    expect(html).not.toContain(NO_USERNAME);
  });

  it('tells an OAuth-only user without a usable username before they set a password', () => {
    const html = render({ hasPassword: false, passwordSignInBlocker: 'no-username' });
    expect(html).toContain(NO_USERNAME);
    expect(html).toContain(`${ADMIN_SETS}, then you can set your password here`);
    expect(html).not.toContain('This page then shows it');
    expect(html).not.toContain('You sign in through your identity provider.');
  });
});

describe('profile passkeys, sessions, tokens and enforced SSO', () => {
  const passkey = {
    id: 3, name: 'Security key', authenticator: null, deviceType: 'singleDevice', backedUp: false,
    createdAt: '2026-10-01T08:00:00.000Z', lastUsedAt: null,
  };

  it('lists passkeys without anything secret and keeps the last required factor', () => {
    const html = render({ signInUsername: 'alice' }, { enabled: true, passkeys: 1, required: true }, { passkeys: [passkey] });
    expect(html).toContain('Security key');
    expect(html).toContain('not used yet');
    expect(html).toContain('Multi-factor on');
    expect(html).toMatch(/aria-label="Remove passkey Security key"[^>]*disabled=""|disabled=""[^>]*aria-label="Remove passkey Security key"/);
  });

  it('says why a passkey cannot be added', () => {
    const html = render({ signInUsername: 'alice' }, {}, { passkeyBlocker: 'Single sign-on is enforced, so only break-glass accounts can add a passkey.' });
    expect(html).toContain('only break-glass accounts can add a passkey');
    expect(html).not.toContain('Add a passkey');
  });

  it('shows sessions with device and place, the current one marked', () => {
    const now = new Date().toISOString();
    const session = (id: number, current: boolean) => ({
      id, current, createdAt: now, updatedAt: now, expiresAt: now, signedInAt: now, lastSeenAt: now,
      ipAddress: '203.0.113.24', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      device: { browser: 'Firefox', os: 'Linux', kind: 'desktop' as const, label: 'Firefox on Linux' },
      location: { countryCode: 'IT', country: 'Italy', asn: 64500, network: 'Example Telecom' },
    });
    const html = render({ signInUsername: 'alice' }, {}, { sessions: [session(1, true), session(2, false)] });
    expect(html).toContain('Active sessions');
    expect(html).toContain('This device');
    expect(html).toContain('Firefox on Linux');
    expect(html).toContain('Italy');
    expect(html).toContain('AS64500 Example Telecom');
    expect(html).toContain('Sign out all other sessions');
  });

  it('pages a long list of sessions, the page in the address', () => {
    const now = new Date().toISOString();
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1, current: index === 0, createdAt: now, updatedAt: now, expiresAt: now, signedInAt: now, lastSeenAt: now,
      ipAddress: `203.0.113.${index + 1}`, userAgent: null,
      device: { browser: null, os: null, kind: 'unknown' as const, label: `Device ${index + 1}` },
      location: null,
    }));
    const first = render({ signInUsername: 'alice' }, {}, { sessions: sessions as never });
    expect(first).toContain('aria-label="Sign out Device 25"');
    expect(first).not.toContain('aria-label="Sign out Device 26"');
    expect(textContent(first)).toContain('1–25 of 30 sessions');
    expect(first).toContain('href="/profile?sessions=2"');

    navigation.search = new URLSearchParams('sessions=2');
    try {
      const second = render({ signInUsername: 'alice' }, {}, { sessions: sessions as never });
      expect(second).toContain('aria-label="Sign out Device 26"');
      expect(second).not.toContain('aria-label="Sign out Device 25"');
      expect(textContent(second)).toContain('26–30 of 30 sessions');
    } finally {
      navigation.search = new URLSearchParams();
    }
  });

  it('shows token scopes, or that a token has its owner\'s role', () => {
    const token = (id: number, scopes: string[] | null) => ({
      id, name: `token-${id}`, createdBy: 7, createdAt: '2026-08-12T00:00:00.000Z', lastUsedAt: null, expiresAt: null, scopes,
    });
    const html = render({ signInUsername: 'alice' }, {}, {
      apiTokens: [token(1, ['proxy_hosts:write', 'certificates:read']), token(2, null)] as never,
      heldPermissions: ['proxy_hosts:read', 'proxy_hosts:write', 'certificates:read'],
    });
    expect(html).toContain('proxy_hosts:write');
    expect(html).toContain('Same as my role');
    expect(html).toContain('2 of 10');
    expect(html).toContain('Choose permissions');
  });

  it('tells a non-break-glass account under enforced SSO that its password is not accepted', () => {
    const html = render({ signInUsername: 'alice' }, {}, { sso: { enforced: true, breakGlass: false } });
    expect(html).toContain('Set, but not accepted while single sign-on is enforced.');
    expect(html).toContain('Single sign-on is enforced');
  });
});
