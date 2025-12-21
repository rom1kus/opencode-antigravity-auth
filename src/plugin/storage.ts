import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type ModelFamily = "claude" | "gemini";

export interface RateLimitState {
  claude?: number;
  gemini?: number;
}

export interface AccountMetadataV1 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

export interface AccountStorageV1 {
  version: 1;
  accounts: AccountMetadataV1[];
  activeIndex: number;
}

export interface AccountMetadata {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
}

export interface AccountStorage {
  version: 2;
  accounts: AccountMetadata[];
  activeIndex: number;
}

type AnyAccountStorage = AccountStorageV1 | AccountStorage;

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

export function getStoragePath(): string {
  return join(getConfigDir(), "antigravity-accounts.json");
}

export function deduplicateAccountsByEmail(accounts: AccountMetadata[]): AccountMetadata[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();
  
  // First pass: find the newest account for each email (by lastUsed, then addedAt)
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc) continue;
    
    if (!acc.email) {
      // No email - keep this account (can't deduplicate without email)
      indicesToKeep.add(i);
      continue;
    }
    
    const existingIndex = emailToNewestIndex.get(acc.email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }
    
    // Compare to find which is newer
    const existing = accounts[existingIndex];
    if (!existing) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }
    
    // Prefer higher lastUsed, then higher addedAt
    // Compare fields separately to avoid integer overflow with large timestamps
    const currLastUsed = acc.lastUsed || 0;
    const existLastUsed = existing.lastUsed || 0;
    const currAddedAt = acc.addedAt || 0;
    const existAddedAt = existing.addedAt || 0;

    const isNewer = currLastUsed > existLastUsed ||
      (currLastUsed === existLastUsed && currAddedAt > existAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(acc.email, i);
    }
  }
  
  // Add all the newest email-based indices to the keep set
  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }
  
  // Build the deduplicated list, preserving original order for kept items
  const result: AccountMetadata[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i];
      if (acc) {
        result.push(acc);
      }
    }
  }
  
  return result;
}

function migrateV1ToV2(v1: AccountStorageV1): AccountStorage {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (acc.isRateLimited && acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

export async function loadAccounts(): Promise<AccountStorage | null> {
  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      console.warn("[opencode-antigravity-auth] Invalid storage format, ignoring");
      return null;
    }

    let storage: AccountStorage;

    if (data.version === 1) {
      console.info("[opencode-antigravity-auth] Migrating account storage from v1 to v2");
      storage = migrateV1ToV2(data);
      try {
        await saveAccounts(storage);
        console.info("[opencode-antigravity-auth] Migration to v2 complete");
      } catch (saveError) {
        console.warn("[opencode-antigravity-auth] Failed to persist migrated storage:", saveError);
      }
    } else if (data.version === 2) {
      storage = data;
    } else {
      console.warn("[opencode-antigravity-auth] Unknown storage version, ignoring", {
        version: (data as { version?: unknown }).version,
      });
      return null;
    }

    // Validate accounts have required fields
    const validAccounts = storage.accounts.filter((a): a is AccountMetadata => {
      return !!a && typeof a === "object" && typeof (a as AccountMetadata).refreshToken === "string";
    });

    // Deduplicate accounts by email (keeps newest entry for each email)
    const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts);

    // Clamp activeIndex to valid range after deduplication
    let activeIndex = typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex) ? storage.activeIndex : 0;
    if (deduplicatedAccounts.length > 0) {
      activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
      activeIndex = Math.max(activeIndex, 0);
    } else {
      activeIndex = 0;
    }

    return {
      version: 2,
      accounts: deduplicatedAccounts,
      activeIndex,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    console.error("[opencode-antigravity-auth] Failed to load account storage:", error);
    return null;
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const path = getStoragePath();
  await fs.mkdir(dirname(path), { recursive: true });

  const content = JSON.stringify(storage, null, 2);
  await fs.writeFile(path, content, "utf-8");
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath();
    await fs.unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[opencode-antigravity-auth] Failed to clear account storage:", error);
    }
  }
}
