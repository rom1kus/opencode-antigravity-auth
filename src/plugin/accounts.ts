import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts, type AccountStorage, type RateLimitState, type ModelFamily } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";

export type { ModelFamily } from "./storage";

export interface ManagedAccount {
  index: number;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitState;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

function nowMs(): number {
  return Date.now();
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : Math.floor(value);
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
  const resetTime = account.rateLimitResetTimes[family];
  return resetTime !== undefined && nowMs() < resetTime;
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  if (account.rateLimitResetTimes.claude !== undefined && now >= account.rateLimitResetTimes.claude) {
    delete account.rateLimitResetTimes.claude;
  }
  if (account.rateLimitResetTimes.gemini !== undefined && now >= account.rateLimitResetTimes.gemini) {
    delete account.rateLimitResetTimes.gemini;
  }
}

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private cursor = 0;
  private currentAccountIndex = -1;
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    const stored = await loadAccounts();
    return new AccountManager(authFallback, stored);
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorage | null) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;

    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursor = 0;
      return;
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = nowMs();
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
            return null;
          }
          const matchesFallback = !!(
            authFallback &&
            authParts &&
            authParts.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          );

          return {
            index,
            email: acc.email,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            access: matchesFallback ? authFallback?.access : undefined,
            expires: matchesFallback ? authFallback?.expires : undefined,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
          };
        })
        .filter((a): a is ManagedAccount => a !== null);

      this.cursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        this.cursor = this.cursor % this.accounts.length;
        this.currentAccountIndex = this.cursor;
      }

      return;
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = nowMs();
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            rateLimitResetTimes: {},
          },
        ];
        this.cursor = 0;
        this.currentAccountIndex = 0;
      }
    }
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({ ...a, parts: { ...a.parts }, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
  }

  getCurrentAccount(): ManagedAccount | null {
    if (this.currentAccountIndex >= 0 && this.currentAccountIndex < this.accounts.length) {
      return this.accounts[this.currentAccountIndex] ?? null;
    }
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation"): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndex = account.index;
  }

  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs();
    if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
      return false;
    }
    return true;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = nowMs();
  }

  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    const current = this.getCurrentAccount();
    if (current) {
      clearExpiredRateLimits(current);
      if (!isRateLimitedForFamily(current, family)) {
        current.lastUsed = nowMs();
        return current;
      }
    }

    const next = this.getNextForFamily(family);
    if (next) {
      this.currentAccountIndex = next.index;
    }
    return next;
  }

  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });

    if (available.length === 0) {
      return null;
    }

    const account = available[this.cursor % available.length];
    if (!account) {
      return null;
    }

    this.cursor++;
    account.lastUsed = nowMs();
    return account;
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily): void {
    account.rateLimitResetTimes[family] = nowMs() + retryAfterMs;
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) {
      return false;
    }

    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => {
      acc.index = index;
    });

    if (this.accounts.length === 0) {
      this.cursor = 0;
      this.currentAccountIndex = -1;
      return true;
    }

    if (this.cursor > idx) {
      this.cursor -= 1;
    }
    this.cursor = this.cursor % this.accounts.length;

    if (this.currentAccountIndex > idx) {
      this.currentAccountIndex -= 1;
    }
    if (this.currentAccountIndex >= this.accounts.length) {
      this.currentAccountIndex = -1;
    }

    return true;
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    const parts = parseRefreshParts(auth.refresh);
    account.parts = parts;
    account.access = auth.access;
    account.expires = auth.expires;
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  getMinWaitTimeForFamily(family: ModelFamily): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes = this.accounts
      .map((a) => a.rateLimitResetTimes[family])
      .filter((t): t is number => t !== undefined)
      .map((t) => Math.max(0, t - nowMs()));

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  async saveToDisk(): Promise<void> {
    const storage: AccountStorage = {
      version: 2,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        lastSwitchReason: a.lastSwitchReason,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
      })),
      activeIndex: Math.max(0, this.currentAccountIndex),
    };

    await saveAccounts(storage);
  }
}
