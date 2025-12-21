import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountManager, type ModelFamily } from "./accounts";
import type { AccountStorage } from "./storage";
import type { OAuthAuthDetails } from "./types";

describe("AccountManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("treats on-disk storage as source of truth, even when empty", () => {
    const fallback: OAuthAuthDetails = {
      type: "oauth",
      refresh: "r1|p1",
      access: "access",
      expires: 123,
    };

    const stored: AccountStorage = {
      version: 2,
      accounts: [],
      activeIndex: 0,
    };

    const manager = new AccountManager(fallback, stored);
    expect(manager.getAccountCount()).toBe(0);
  });

  it("returns current account when not rate-limited for family", () => {
    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";

    const account = manager.getCurrentOrNextForFamily(family);

    expect(account).not.toBeNull();
    expect(account?.index).toBe(0);
  });

  it("switches to next account when current is rate-limited for family", () => {
    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";

    const firstAccount = manager.getCurrentOrNextForFamily(family);
    manager.markRateLimited(firstAccount!, 60000, family);

    const secondAccount = manager.getCurrentOrNextForFamily(family);
    expect(secondAccount?.index).toBe(1);
  });

  it("returns null when all accounts are rate-limited for family", () => {
    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";

    const accounts = manager.getAccounts();
    accounts.forEach((acc) => manager.markRateLimited(acc, 60000, family));

    const next = manager.getCurrentOrNextForFamily(family);
    expect(next).toBeNull();
  });

  it("un-rate-limits accounts after timeout expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";
    const account = manager.getCurrentOrNextForFamily(family);

    account!.rateLimitResetTimes[family] = Date.now() - 10000;

    const next = manager.getCurrentOrNextForFamily(family);
    expect(next?.parts.refreshToken).toBe("r1");
  });

  it("returns minimum wait time for family", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";
    const accounts = manager.getAccounts();

    manager.markRateLimited(accounts[0]!, 30000, family);
    manager.markRateLimited(accounts[1]!, 60000, family);

    expect(manager.getMinWaitTimeForFamily(family)).toBe(30000);
  });

  it("tracks rate limits per model family independently", () => {
    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);

    const account = manager.getCurrentOrNextForFamily("claude");
    expect(account?.index).toBe(0);

    manager.markRateLimited(account!, 60000, "claude");

    expect(manager.getMinWaitTimeForFamily("claude")).toBeGreaterThan(0);
    expect(manager.getMinWaitTimeForFamily("gemini")).toBe(0);

    const geminiOnAccount0 = manager.getNextForFamily("gemini");
    expect(geminiOnAccount0?.index).toBe(0);

    const claudeBlocked = manager.getNextForFamily("claude");
    expect(claudeBlocked).toBeNull();
  });

  it("getCurrentOrNextForFamily sticks to same account until rate-limited", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";

    const first = manager.getCurrentOrNextForFamily(family);
    expect(first?.parts.refreshToken).toBe("r1");

    const second = manager.getCurrentOrNextForFamily(family);
    expect(second?.parts.refreshToken).toBe("r1");

    const third = manager.getCurrentOrNextForFamily(family);
    expect(third?.parts.refreshToken).toBe("r1");

    manager.markRateLimited(first!, 60_000, family);

    const fourth = manager.getCurrentOrNextForFamily(family);
    expect(fourth?.parts.refreshToken).toBe("r2");

    const fifth = manager.getCurrentOrNextForFamily(family);
    expect(fifth?.parts.refreshToken).toBe("r2");
  });

  it("removes an account and keeps cursor consistent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r3", projectId: "p3", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 1,
    };

    const manager = new AccountManager(undefined, stored);
    const family: ModelFamily = "claude";

    const picked = manager.getCurrentOrNextForFamily(family);
    expect(picked?.parts.refreshToken).toBe("r2");

    manager.removeAccount(picked!);
    expect(manager.getAccountCount()).toBe(2);

    const next = manager.getNextForFamily(family);
    expect(next?.parts.refreshToken).toBe("r3");
  });

  it("attaches fallback access tokens only to the matching stored account", () => {
    const fallback: OAuthAuthDetails = {
      type: "oauth",
      refresh: "r2|p2",
      access: "access-2",
      expires: 123,
    };

    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(fallback, stored);
    const snapshot = manager.getAccountsSnapshot();

    expect(snapshot[0]?.access).toBeUndefined();
    expect(snapshot[0]?.expires).toBeUndefined();
    expect(snapshot[1]?.access).toBe("access-2");
    expect(snapshot[1]?.expires).toBe(123);
  });

  it("debounces toast display for same account", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const stored: AccountStorage = {
      version: 2,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);

    expect(manager.shouldShowAccountToast(0)).toBe(true);
    manager.markToastShown(0);

    expect(manager.shouldShowAccountToast(0)).toBe(false);

    expect(manager.shouldShowAccountToast(1)).toBe(true);

    vi.setSystemTime(new Date(31000));
    expect(manager.shouldShowAccountToast(0)).toBe(true);
  });
});
