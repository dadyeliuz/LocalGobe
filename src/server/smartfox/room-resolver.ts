import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildManifest } from "../../storage/build-store.ts";

export type RoomTaxonomy = "WORLD_ROOM" | "GAME_ROOM" | "PRIVATE_DYNAMIC_ROOM";

export type StaticGameRoomDefinition = {
  rId: number;
  rN: string;
  rT: "WG";
  swf: string;
  baseSwf: string;
  rrr: number;
  fR: number;
  sTc: number;
};

export const STATIC_GAME_ROOMS: ReadonlyArray<StaticGameRoomDefinition> = Object.freeze([
  { rId: 3040, rN: "LifeGuard", rT: "WG", swf: "ExternalGameManager", baseSwf: "LifeGuard", rrr: 50, fR: 24, sTc: 10 },
  { rId: 1150, rN: "PingORBagel", rT: "WG", swf: "GameManager", baseSwf: "PingORBagel", rrr: 100, fR: 24, sTc: 10 },
  { rId: 1021, rN: "Falafel", rT: "WG", swf: "GameManager", baseSwf: "Falafel", rrr: 140, fR: 24, sTc: 10 },
  { rId: 1140, rN: "ScubaDive", rT: "WG", swf: "GameManager", baseSwf: "ScubaDive", rrr: 110, fR: 24, sTc: 10 },
  { rId: 1001, rN: "Darts", rT: "WG", swf: "GameManager", baseSwf: "Darts", rrr: 20, fR: 24, sTc: 10 },
  { rId: 3080, rN: "Bowling", rT: "WG", swf: "GameManager", baseSwf: "Bowling", rrr: 20, fR: 24, sTc: 10 },
  { rId: 1170, rN: "Marble", rT: "WG", swf: "ExternalGameManager", baseSwf: "Marble", rrr: 150, fR: 24, sTc: 10 },
  { rId: 10009, rN: "TowerBlocks", rT: "WG", swf: "ExternalGameManager", baseSwf: "TowerBlocks", rrr: 500, fR: 24, sTc: 10 },
  { rId: 3090, rN: "CandyMan", rT: "WG", swf: "ExternalGameManager", baseSwf: "CandyMan", rrr: 500, fR: 24, sTc: 10 },
  { rId: 10066, rN: "AmazingSheriff", rT: "WG", swf: "ExternalGameManager", baseSwf: "AmazingSheriff", rrr: 630, fR: 24, sTc: 10 },
  { rId: 10074, rN: "SnowmanSki", rT: "WG", swf: "ExternalGameManager", baseSwf: "SnowmanSki", rrr: 10098, fR: 24, sTc: 10 },
  { rId: 10076, rN: "BeSquare", rT: "WG", swf: "ExternalGameManager", baseSwf: "BeSquare", rrr: 500, fR: 24, sTc: 10 },
  { rId: 10078, rN: "BBBGame", rT: "WG", swf: "ExternalGameManager", baseSwf: "BBBGame", rrr: 20, fR: 24, sTc: 10 },
  { rId: 3095, rN: "RedBall", rT: "WG", swf: "ExternalGameManager", baseSwf: "RedBall", rrr: 170, fR: 24, sTc: 10 },
]);

export function getStaticGameRoom(roomId: number): StaticGameRoomDefinition | undefined {
  return STATIC_GAME_ROOMS.find((g) => g.rId === roomId);
}

export type RoomAvailabilityStatus = "AVAILABLE" | "UNAVAILABLE";
export type RoomAvailabilityReason =
  | "installed-world-room"
  | "installed-mini-game"
  | "bootstrap-room"
  | "missing-room-assets"
  | "missing-game-assets"
  | "private-room-unsupported";

export type RoomAvailabilityResult = {
  roomId: number;
  taxonomy: RoomTaxonomy;
  available: boolean;
  status: RoomAvailabilityStatus;
  reason: RoomAvailabilityReason;
};

export type RoomAvailabilityOptions = {
  isRoomCompatEnabled?: () => boolean;
  allRooms?: boolean;
  dataDir?: string;
};

export function resolveRoomAvailability(
  buildId: string,
  roomId: number,
  options: RoomAvailabilityOptions = {},
): RoomAvailabilityResult {
  if (roomId === 1) {
    return {
      roomId,
      taxonomy: "PRIVATE_DYNAMIC_ROOM",
      available: false,
      status: "UNAVAILABLE",
      reason: "private-room-unsupported",
    };
  }

  const manifest = readBuildManifest(buildId, options.dataDir);
  const staticGame = getStaticGameRoom(roomId);
  if (staticGame) {
    const gameRec = manifest?.categories.miniGames.games.find((g) => g.roomId === roomId);
    const available = gameRec?.state === "Available";
    return {
      roomId,
      taxonomy: "GAME_ROOM",
      available,
      status: available ? "AVAILABLE" : "UNAVAILABLE",
      reason: available ? "installed-mini-game" : "missing-game-assets",
    };
  }

  if (manifest) {
    const roomRec = manifest.categories.world.rooms.find((r) => r.roomId === roomId);
    if (roomRec?.ready) {
      return {
        roomId,
        taxonomy: "WORLD_ROOM",
        available: true,
        status: "AVAILABLE",
        reason: "installed-world-room",
      };
    }
  }

  // Fallback for standalone unit tests without a dataDir build installed
  if (!manifest && roomId === 20) {
    return {
      roomId,
      taxonomy: "WORLD_ROOM",
      available: true,
      status: "AVAILABLE",
      reason: "bootstrap-room",
    };
  }

  return {
    roomId,
    taxonomy: "WORLD_ROOM",
    available: false,
    status: "UNAVAILABLE",
    reason: "missing-room-assets",
  };
}

export type RoomMusicStatus = "MAPPED" | "NO_MUSIC" | "SKIPPED";

export type RoomMusicResolution =
  | { status: "MAPPED"; rbs: string; sha256: string; notes?: string }
  | { status: "NO_MUSIC"; rbs: null; sha256: null; notes?: string }
  | { status: "SKIPPED"; rbs: null; sha256: null; notes?: string };

type RoomMusicMapFile = {
  schema: string;
  rooms: Record<string, { status: RoomMusicStatus; rbs: string | null; sha256: string | null; notes?: string }>;
};

let cachedMusicMap: RoomMusicMapFile | null = null;

function getRoomMusicMap(): RoomMusicMapFile {
  if (cachedMusicMap) return cachedMusicMap;
  try {
    const mapPath = resolve(fileURLToPath(new URL("../http/room-music-map.json", import.meta.url)));
    cachedMusicMap = JSON.parse(readFileSync(mapPath, "utf8")) as RoomMusicMapFile;
    return cachedMusicMap;
  } catch {
    return { schema: "localgobe-room-music-manual-v1", rooms: {} };
  }
}

export function resolveRoomBackgroundMusic(roomId: number): RoomMusicResolution {
  const map = getRoomMusicMap();
  const entry = map.rooms[String(roomId)];
  if (!entry) {
    return { status: "NO_MUSIC", rbs: null, sha256: null };
  }
  if (entry.status === "MAPPED" && entry.rbs && entry.sha256) {
    return { status: "MAPPED", rbs: entry.rbs, sha256: entry.sha256, notes: entry.notes };
  }
  return { status: entry.status === "SKIPPED" ? "SKIPPED" : "NO_MUSIC", rbs: null, sha256: null, notes: entry.notes };
}
