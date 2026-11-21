import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { atomicWriteFile } from "./build-store.ts";
import { getRuntimeRoot } from "./paths.ts";

export type StoredInventoryItem = {
  id: number;
  typeId: number;
  sts: number;
  sCat: number;
  src: number;
  inStock: boolean;
  s: number;
  pCat?: number;
  mType?: number;
  trd?: number;
  locked?: boolean;
};

export type StoredRelationship = {
  targetUsername: string;
  status: 1 | 2 | 3 | 4; // 1 = requested, 2 = confirmed friend, 3 = blocked, 4 = best/favorite
  direction?: "incoming" | "outgoing";
  updatedAt: string;
};

export type StoredHearts = {
  toGive: number;
  toGiveMax: number;
  received: number;
};

export type StoredWallMessage = {
  id: number;
  fuId: number;
  fuN: string;
  tmId: number;
  tyId: number;
  c: string;
  n: boolean;
  sd: string;
};

export type StoredAccount = {
  id?: number;
  username: string;
  passwordHash: string;
  salt: string;
  color: number;
  registrationState: "completed" | "pending_confirmation";
  createdAt: string;
  email?: string;
  coins?: number;
  inventory?: StoredInventoryItem[];
  relationships?: Record<string, StoredRelationship>;
  hearts?: StoredHearts;
  wallMessages?: StoredWallMessage[];
  nextWallId?: number;
};

type AccountsFileSchema = {
  version: 1;
  accounts: Record<string, StoredAccount>;
};

export function getAccountsPath(dataDir?: string): string {
  if (process.env.LOCALGOBE_ACCOUNTS_FILE) {
    return resolve(process.env.LOCALGOBE_ACCOUNTS_FILE);
  }
  return resolve(getRuntimeRoot(dataDir), "accounts.json");
}

export function ensureAccountId(account: StoredAccount, allAccounts: Record<string, StoredAccount>): number {
  if (account.id && account.id > 0) return account.id;
  let maxId = 1000;
  for (const acc of Object.values(allAccounts)) {
    if (acc.id && acc.id > maxId) maxId = acc.id;
  }
  account.id = maxId + 1;
  return account.id;
}

export function loadAccounts(dataDir?: string): Record<string, StoredAccount> {
  const filePath = getAccountsPath(dataDir);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as AccountsFileSchema;
    const accounts = parsed?.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {};
    let changed = false;
    for (const acc of Object.values(accounts)) {
      if (!acc.id) {
        ensureAccountId(acc, accounts);
        changed = true;
      }
    }
    if (changed) {
      saveAccounts(accounts, dataDir);
    }
    return accounts;
  } catch {
    return {};
  }
}

export function saveAccounts(accounts: Record<string, StoredAccount>, dataDir?: string): void {
  const filePath = getAccountsPath(dataDir);
  const schema: AccountsFileSchema = { version: 1, accounts };
  atomicWriteFile(filePath, JSON.stringify(schema, null, 2) + "\n");
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export function hasAccount(username: string, dataDir?: string): boolean {
  const key = username.trim().toLowerCase();
  return Boolean(loadAccounts(dataDir)[key]);
}

export function getAccount(username: string, dataDir?: string): StoredAccount | undefined {
  const key = username.trim().toLowerCase();
  return loadAccounts(dataDir)[key];
}

export function createOrEnsureAccount(
  username: string,
  password: string,
  color = 0,
  dataDir?: string,
): StoredAccount {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  const existing = accounts[key];
  if (existing) return existing;

  const salt = randomBytes(16).toString("hex");
  const account: StoredAccount = {
    id: ensureAccountId({} as StoredAccount, accounts),
    username: username.trim(),
    passwordHash: hashPassword(password, salt),
    salt,
    color,
    registrationState: "completed",
    createdAt: new Date().toISOString(),
    coins: 500,
    inventory: [],
  };
  accounts[key] = account;
  saveAccounts(accounts, dataDir);
  return account;
}

export type RegistrationResult =
  | { success: true; account: StoredAccount }
  | { success: false; error: "ALREADY_EXISTS" | "INVALID_USERNAME" | "INVALID_PASSWORD" | "INVALID_COLOR" };

export function createRegisteredAccount(
  username: string,
  password: string,
  color: number,
  email?: string,
  dataDir?: string,
): RegistrationResult {
  const accounts = loadAccounts(dataDir);
  const cleanUser = username.trim();
  const key = cleanUser.toLowerCase();

  if (accounts[key]) {
    return { success: false, error: "ALREADY_EXISTS" };
  }

  if (cleanUser.length < 4 || cleanUser.length > 16 || !/^[a-zA-Z0-9]+$/.test(cleanUser)) {
    return { success: false, error: "INVALID_USERNAME" };
  }

  if (password.length < 4 || password.length > 32 || cleanUser.toLowerCase() === password.toLowerCase()) {
    return { success: false, error: "INVALID_PASSWORD" };
  }

  const cleanColor = Math.floor(Number(color));
  const validColor = Number.isFinite(cleanColor) && cleanColor >= 1 && cleanColor <= 12 ? cleanColor : 1;

  const salt = randomBytes(16).toString("hex");
  const account: StoredAccount = {
    id: ensureAccountId({} as StoredAccount, accounts),
    username: cleanUser,
    passwordHash: hashPassword(password, salt),
    salt,
    color: validColor,
    registrationState: "completed",
    createdAt: new Date().toISOString(),
    email: email?.trim() || undefined,
    coins: 500,
    inventory: [],
  };

  accounts[key] = account;
  saveAccounts(accounts, dataDir);
  return { success: true, account };
}

export function generateAvailableUsernames(baseUsername: string, count = 3, dataDir?: string): string[] {
  const accounts = loadAccounts(dataDir);
  const cleanBase = baseUsername.trim().replace(/[^a-zA-Z0-9]/g, "");
  const base = cleanBase.length >= 3 ? cleanBase.slice(0, 14) : "mogo";
  const suggestions: string[] = [];

  let candidateNum = 1;
  while (suggestions.length < count && candidateNum < 1000) {
    const candidate = `${base}${candidateNum}`;
    const key = candidate.toLowerCase();
    if (!accounts[key] && !suggestions.includes(candidate)) {
      suggestions.push(candidate);
    }
    candidateNum++;
  }

  return suggestions;
}

export function verifyAccountCredentials(username: string, password: string, dataDir?: string): boolean {
  const account = getAccount(username, dataDir);
  if (!account) return false;
  const candidate = Buffer.from(hashPassword(password, account.salt), "hex");
  const stored = Buffer.from(account.passwordHash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function updateAccountPlayerState(
  username: string,
  state: { color?: number; coins?: number; inventory?: StoredInventoryItem[] },
  dataDir?: string,
): boolean {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  if (!accounts[key]) return false;
  if (state.color !== undefined) accounts[key].color = state.color;
  if (state.coins !== undefined) accounts[key].coins = state.coins;
  if (state.inventory !== undefined) accounts[key].inventory = [...state.inventory];
  saveAccounts(accounts, dataDir);
  return true;
}

export function updateTwoAccountsTrade(
  userA: string,
  stateA: { coins?: number; inventory?: StoredInventoryItem[] },
  userB: string,
  stateB: { coins?: number; inventory?: StoredInventoryItem[] },
  dataDir?: string,
): boolean {
  const accounts = loadAccounts(dataDir);
  const keyA = userA.trim().toLowerCase();
  const keyB = userB.trim().toLowerCase();
  if (!accounts[keyA] || !accounts[keyB]) return false;
  if (stateA.coins !== undefined) accounts[keyA].coins = stateA.coins;
  if (stateA.inventory !== undefined) accounts[keyA].inventory = [...stateA.inventory];
  if (stateB.coins !== undefined) accounts[keyB].coins = stateB.coins;
  if (stateB.inventory !== undefined) accounts[keyB].inventory = [...stateB.inventory];
  saveAccounts(accounts, dataDir);
  return true;
}

export function getAccountById(id: number, dataDir?: string): StoredAccount | undefined {
  const accounts = loadAccounts(dataDir);
  for (const acc of Object.values(accounts)) {
    if (acc.id === id) return acc;
  }
  return undefined;
}

export function getAccountId(username: string, dataDir?: string): number {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  const acc = accounts[key];
  if (acc) {
    if (!acc.id) {
      ensureAccountId(acc, accounts);
      saveAccounts(accounts, dataDir);
    }
    return acc.id!;
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0x7fffffff;
  }
  return 10000 + (hash % 80000);
}

export function getAccountRelationships(username: string, dataDir?: string): Record<string, StoredRelationship> {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  return accounts[key]?.relationships ?? {};
}

export function addBuddyRequest(
  fromUsername: string,
  toUsername: string,
  dataDir?: string,
): { success: boolean; error?: string } {
  const fromKey = fromUsername.trim().toLowerCase();
  const toKey = toUsername.trim().toLowerCase();
  if (fromKey === toKey) return { success: false, error: "CANNOT_ADD_SELF" };

  const accounts = loadAccounts(dataDir);
  const fromAcc = accounts[fromKey] ?? createOrEnsureAccount(fromUsername, "pass", 10, dataDir);
  const toAcc = accounts[toKey] ?? createOrEnsureAccount(toUsername, "pass", 10, dataDir);

  if (!fromAcc.relationships) fromAcc.relationships = {};
  if (!toAcc.relationships) toAcc.relationships = {};

  if (fromAcc.relationships[toKey]?.status === 3 || toAcc.relationships[fromKey]?.status === 3) {
    return { success: false, error: "BLOCKED" };
  }

  if (fromAcc.relationships[toKey]?.status === 2 || fromAcc.relationships[toKey]?.status === 4) {
    return { success: false, error: "ALREADY_FRIENDS" };
  }

  const now = new Date().toISOString();
  fromAcc.relationships[toKey] = {
    targetUsername: toAcc.username,
    status: 1,
    direction: "outgoing",
    updatedAt: now,
  };
  toAcc.relationships[fromKey] = {
    targetUsername: fromAcc.username,
    status: 1,
    direction: "incoming",
    updatedAt: now,
  };

  saveAccounts(accounts, dataDir);
  return { success: true };
}

export function acceptBuddyRequest(
  userA: string,
  userB: string,
  dataDir?: string,
): { success: boolean } {
  const keyA = userA.trim().toLowerCase();
  const keyB = userB.trim().toLowerCase();
  const accounts = loadAccounts(dataDir);
  const accA = accounts[keyA] ?? createOrEnsureAccount(userA, "pass", 10, dataDir);
  const accB = accounts[keyB] ?? createOrEnsureAccount(userB, "pass", 10, dataDir);

  if (!accA.relationships) accA.relationships = {};
  if (!accB.relationships) accB.relationships = {};

  const now = new Date().toISOString();
  accA.relationships[keyB] = {
    targetUsername: accB.username,
    status: 2,
    updatedAt: now,
  };
  accB.relationships[keyA] = {
    targetUsername: accA.username,
    status: 2,
    updatedAt: now,
  };

  saveAccounts(accounts, dataDir);
  return { success: true };
}

export function rejectBuddyRequest(
  userA: string,
  userB: string,
  dataDir?: string,
): { success: boolean } {
  const keyA = userA.trim().toLowerCase();
  const keyB = userB.trim().toLowerCase();
  const accounts = loadAccounts(dataDir);
  const accA = accounts[keyA];
  const accB = accounts[keyB];
  let changed = false;

  if (accA?.relationships?.[keyB]) {
    delete accA.relationships[keyB];
    changed = true;
  }
  if (accB?.relationships?.[keyA]) {
    delete accB.relationships[keyA];
    changed = true;
  }

  if (changed) saveAccounts(accounts, dataDir);
  return { success: true };
}

export function deleteBuddy(
  userA: string,
  userB: string,
  dataDir?: string,
): { success: boolean } {
  const keyA = userA.trim().toLowerCase();
  const keyB = userB.trim().toLowerCase();
  const accounts = loadAccounts(dataDir);
  const accA = accounts[keyA];
  const accB = accounts[keyB];
  let changed = false;

  if (accA?.relationships?.[keyB]) {
    delete accA.relationships[keyB];
    changed = true;
  }
  if (accB?.relationships?.[keyA]) {
    delete accB.relationships[keyA];
    changed = true;
  }

  if (changed) saveAccounts(accounts, dataDir);
  return { success: true };
}

export function setBestBuddy(
  username: string,
  targetUsername: string,
  isBest: boolean,
  dataDir?: string,
): { success: boolean } {
  const key = username.trim().toLowerCase();
  const targetKey = targetUsername.trim().toLowerCase();
  const accounts = loadAccounts(dataDir);
  const acc = accounts[key];
  if (!acc || !acc.relationships?.[targetKey]) return { success: false };

  const current = acc.relationships[targetKey];
  if (current.status !== 2 && current.status !== 4) return { success: false };

  current.status = isBest ? 4 : 2;
  current.updatedAt = new Date().toISOString();
  saveAccounts(accounts, dataDir);
  return { success: true };
}

export function blockBuddy(
  username: string,
  targetUsername: string,
  dataDir?: string,
): { success: boolean } {
  const key = username.trim().toLowerCase();
  const targetKey = targetUsername.trim().toLowerCase();
  if (key === targetKey) return { success: false };

  const accounts = loadAccounts(dataDir);
  const acc = accounts[key] ?? createOrEnsureAccount(username, "pass", 10, dataDir);
  const targetAcc = accounts[targetKey] ?? createOrEnsureAccount(targetUsername, "pass", 10, dataDir);

  if (!acc.relationships) acc.relationships = {};
  acc.relationships[targetKey] = {
    targetUsername: targetAcc.username,
    status: 3,
    updatedAt: new Date().toISOString(),
  };

  if (targetAcc.relationships?.[key] && targetAcc.relationships[key].status !== 3) {
    delete targetAcc.relationships[key];
  }

  saveAccounts(accounts, dataDir);
  return { success: true };
}

export function getAccountHearts(username: string, dataDir?: string): StoredHearts {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  const acc = accounts[key];

  if (!acc) {
    return { toGive: 5, toGiveMax: 5, received: 0 };
  }

  if (!acc.hearts) {
    acc.hearts = { toGive: 5, toGiveMax: 5, received: 0 };
    saveAccounts(accounts, dataDir);
  }

  return { ...acc.hearts };
}

export function giveAccountHearts(
  fromUsername: string,
  targetIdsOrUsernames: (string | number)[],
  dataDir?: string,
): { success: boolean; status: boolean | number; maxMsg?: number; hearts: StoredHearts } {
  const accounts = loadAccounts(dataDir);
  const fromKey = fromUsername.trim().toLowerCase();
  const sender = accounts[fromKey] ?? createOrEnsureAccount(fromUsername, "pass", 10, dataDir);

  if (!sender.hearts) {
    sender.hearts = { toGive: 5, toGiveMax: 5, received: 0 };
  }

  const validTargets: StoredAccount[] = [];

  for (const item of targetIdsOrUsernames) {
    let targetAcc: StoredAccount | undefined;
    if (typeof item === "number") {
      targetAcc = Object.values(accounts).find((a) => a.id === item);
    } else {
      targetAcc = accounts[item.trim().toLowerCase()];
    }
    if (targetAcc && targetAcc.username.toLowerCase() !== fromKey) {
      validTargets.push(targetAcc);
    }
  }

  if (validTargets.length === 0) {
    return { success: false, status: 2, hearts: { ...sender.hearts } };
  }

  if (sender.hearts.toGive < validTargets.length) {
    return { success: false, status: 1, maxMsg: sender.hearts.toGive, hearts: { ...sender.hearts } };
  }

  for (const target of validTargets) {
    if (!target.hearts) {
      target.hearts = { toGive: 5, toGiveMax: 5, received: 0 };
    }
    target.hearts.received = (target.hearts.received ?? 0) + 1;
    sender.hearts.toGive = Math.max(0, sender.hearts.toGive - 1);
  }

  saveAccounts(accounts, dataDir);
  return { success: true, status: true, hearts: { ...sender.hearts } };
}

export function getAccountWallMessages(username: string, dataDir?: string): StoredWallMessage[] {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  return accounts[key]?.wallMessages ?? [];
}

export function addAccountWallMessage(
  targetUsername: string,
  fromUserId: number,
  fromUserName: string,
  content: string,
  dataDir?: string,
): StoredWallMessage {
  const accounts = loadAccounts(dataDir);
  const key = targetUsername.trim().toLowerCase();
  const acc = accounts[key] ?? createOrEnsureAccount(targetUsername, "pass", 10, dataDir);
  if (!acc.wallMessages) acc.wallMessages = [];
  const nextId = acc.nextWallId ?? (acc.wallMessages.length > 0 ? Math.max(...acc.wallMessages.map((m) => m.id)) + 1 : 1);
  acc.nextWallId = nextId + 1;

  const msg: StoredWallMessage = {
    id: nextId,
    fuId: fromUserId,
    fuN: fromUserName,
    tmId: 1,
    tyId: 1,
    c: content,
    n: true,
    sd: new Date().toISOString().slice(0, 10),
  };
  acc.wallMessages.push(msg);
  saveAccounts(accounts, dataDir);
  return msg;
}

export function markAccountWallMessageRead(
  username: string,
  messageId: number,
  dataDir?: string,
): boolean {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  const acc = accounts[key];
  if (!acc?.wallMessages) return false;
  const msg = acc.wallMessages.find((m) => m.id === messageId);
  if (msg) {
    msg.n = false;
    saveAccounts(accounts, dataDir);
    return true;
  }
  return false;
}

export function deleteAccountWallMessage(
  username: string,
  messageId: number,
  dataDir?: string,
): boolean {
  const accounts = loadAccounts(dataDir);
  const key = username.trim().toLowerCase();
  const acc = accounts[key];
  if (!acc?.wallMessages) return false;
  acc.wallMessages = acc.wallMessages.filter((m) => m.id !== messageId);
  saveAccounts(accounts, dataDir);
  return true;
}
