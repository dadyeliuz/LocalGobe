import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFile } from "./build-store.ts";
import { getRuntimeRoot } from "./paths.ts";

export type LeaderboardEntry = {
  userId: number;
  userName: string;
  score: number;
  updatedAt: string;
  color?: number;
  items?: Array<{ typeId: number }>;
};

type LeaderboardFileSchema = {
  version: 1;
  games: Record<string, LeaderboardEntry[]>;
};

export function getLeaderboardsPath(dataDir?: string): string {
  if (process.env.LOCALGOBE_LEADERBOARDS_FILE) {
    return resolve(process.env.LOCALGOBE_LEADERBOARDS_FILE);
  }
  return resolve(getRuntimeRoot(dataDir), "leaderboards.json");
}

export function loadLeaderboards(dataDir?: string): LeaderboardFileSchema {
  const filePath = getLeaderboardsPath(dataDir);
  if (!existsSync(filePath)) return { version: 1, games: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as LeaderboardFileSchema;
    return parsed?.games && typeof parsed.games === "object"
      ? { version: 1, games: parsed.games }
      : { version: 1, games: {} };
  } catch {
    return { version: 1, games: {} };
  }
}

export function saveLeaderboards(data: LeaderboardFileSchema, dataDir?: string): void {
  atomicWriteFile(getLeaderboardsPath(dataDir), JSON.stringify(data, null, 2) + "\n");
}

export function recordScore(
  gameKey: string,
  entry: Omit<LeaderboardEntry, "updatedAt">,
  dataDir?: string,
): { isNewHighScore: boolean; rank: number } {
  const data = loadLeaderboards(dataDir);
  const list = data.games[gameKey] ?? [];
  const key = entry.userName.trim().toLowerCase();
  const existingIdx = list.findIndex((e) => e.userName.trim().toLowerCase() === key);
  let isNewHighScore = false;

  if (existingIdx >= 0) {
    if (entry.score > list[existingIdx].score) {
      list[existingIdx] = { ...entry, updatedAt: new Date().toISOString() };
      isNewHighScore = true;
    }
  } else {
    list.push({ ...entry, updatedAt: new Date().toISOString() });
    isNewHighScore = true;
  }

  list.sort((a, b) => b.score - a.score || a.userName.localeCompare(b.userName));
  data.games[gameKey] = list.slice(0, 50);
  saveLeaderboards(data, dataDir);

  const rank = data.games[gameKey].findIndex((e) => e.userName.trim().toLowerCase() === key) + 1;
  return { isNewHighScore, rank };
}

export function getTopTen(gameKey: string, dataDir?: string): {
  result: Array<{ userName: string; score: number }>;
  winnerColor: number;
  winnerItems: Array<{ typeId: number }>;
} {
  const data = loadLeaderboards(dataDir);
  const top = (data.games[gameKey] ?? []).slice(0, 10);
  const winner = top[0];
  return {
    result: top.map((e) => ({ userName: e.userName, score: e.score })),
    winnerColor: winner?.color ?? 0,
    winnerItems: winner?.items ?? [],
  };
}
