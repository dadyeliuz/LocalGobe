/**
 * LocalGobe Room Navigation Manifest & Resolver
 *
 * Source-of-truth for room destination resolution across:
 * 1. World Map buttons (p_3.swf / mlPopup_3 / MapPopup.as)
 * 2. Physical Doors / Exits (mcEntryPoint_<ID> / rooms__changeRoom { gCId })
 * 3. Canonical Room Aliases & Special Links
 *
 * Strictly avoids generic fallbacks to Room 20.
 */

export type NavigationTargetSource =
  | "MAP_BUTTON"
  | "PHYSICAL_DOOR"
  | "CANONICAL_ALIAS"
  | "CONTROL_PANEL"
  | "USER_CARD"
  | "NUMERIC_DIRECT";

export interface RoomNavigationEntry {
  readonly nameId: string;
  readonly targetRoomId: number;
  readonly source: NavigationTargetSource;
}

/**
 * Technical routing manifest mapping world map identifiers to room destinations.
 */
export const WORLD_MAP_NAVIGATION_MANIFEST: ReadonlyArray<RoomNavigationEntry> = [
  {
    nameId: "TelAviv",
    targetRoomId: 20,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Jerusalem",
    targetRoomId: 100,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Market",
    targetRoomId: 140,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Eilat",
    targetRoomId: 110,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Haifa",
    targetRoomId: 160,
    source: "MAP_BUTTON",
  },
  {
    nameId: "PrivateRoom",
    targetRoomId: 1,
    source: "MAP_BUTTON",
  },
  {
    nameId: "TelAvivNight",
    targetRoomId: 50,
    source: "MAP_BUTTON",
  },
  {
    nameId: "KingsRoad",
    targetRoomId: 70,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Desertia",
    targetRoomId: 250,
    source: "MAP_BUTTON",
  },
  {
    nameId: "ForestRiver",
    targetRoomId: 430,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Pool",
    targetRoomId: 150,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Arava",
    targetRoomId: 500,
    source: "MAP_BUTTON",
  },
  {
    nameId: "HalavV",
    targetRoomId: 630,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Shugibeach",
    targetRoomId: 660,
    source: "MAP_BUTTON",
  },
  {
    nameId: "Airplane",
    targetRoomId: 730,
    source: "MAP_BUTTON",
  },
  {
    nameId: "NewHousesArea",
    targetRoomId: 10010,
    source: "MAP_BUTTON",
  },
  {
    nameId: "NakikHaNesharim",
    targetRoomId: 760,
    source: "MAP_BUTTON",
  },
];

/**
 * Verified canonical room aliases across the room catalog.
 */
export const CANONICAL_ROOM_ALIASES: Readonly<Record<string, number>> = {
  TelAviv: 20,
  Eilat: 110,
  AzrieliStore: 60,
  KingsRoad: 70,
  Jerusalem: 100,
  HalavV: 630,
  Hotel: 120,
  Market: 140,
  Pool: 150,
  Haifa: 160,
  Mall: 170,
  Desertia: 250, // Cinema/Museum building on map
  Museum: 250,
  Cinema: 250, // Canonical Cinema route in Spring 2013 map
  Library: 310,
  ForestRiver: 430,
  ForestTree: 440,
  TelAvivNight: 50,
  Arava: 500, // Boomag/Dunes destination on map
  SouvenirStore: 620,
  Cave02: 630,
  ShugiBeach: 660,
  ShugoArea: 730,
  Airplane: 730,
  PalaceClothStore: 760,
  NakikHaNesharim: 760,
  NewHousesArea: 10010,
  WorldAdventure: 10017,
  CampArea: 10022,
  AmusementPark: 10030,
  CastleGate: 10033,
  IndependenceHall: 10064,
  Arcade: 10085,
  SkiResort: 10098,
  DressingRoom: 10100,
  BeautySalon: 10101,
  VillageBar: 10109,
  PurimCarnival: 10112,
  ScienceMuseum: 10115,
  TrainStation: 10130,
  SecretLair: 10162,
  HalloweenCastle: 10168,
  SoccerStadium: 10240,
  BasketballCourt: 10241,
  SpaceStation: 10246,
  PassoverVillage: 10268,
  // Games
  LifeGuard: 3040,
  PingORBagel: 1150,
  Falafel: 1021,
  ScubaDive: 1140,
  Darts: 1001,
  Bowling: 3080,
  Marble: 1170,
  TowerBlocks: 10009,
  CandyMan: 3090,
  AmazingSheriff: 10066,
  SnowmanSki: 10074,
  BeSquare: 10076,
  BBBGame: 10078,
  RedBall: 3095,
  GoldFishing: 3097,
  Hangman: 3098,
  CarRaceing: 3099,
  Crusade: 3105,
  GroundHog: 3102,
  MotorRush: 3103,
  TrickyCups: 3104,
  TornadoRiderGame: 3106,
  BrickShex: 3110,
  GalaxyExplorer: 3130,
  BubbleFun: 10117,
  HiddenObjects: 1040,
  Hoops: 1090,
};

export interface RoomResolutionResult {
  readonly roomId: number | null;
  readonly rule: string;
  readonly rawDestination: string;
}

/**
 * Resolves room destination from any client transition request (rooms__jumpToRoom, rooms__changeRoom).
 * Returns null if the destination is unresolved. NEVER defaults to Room 20.
 */
export function resolveTargetRoomIdDetailed(
  payload: Record<string, unknown> | undefined,
  currentRoomId?: number,
): RoomResolutionResult {
  if (!payload || typeof payload !== "object") {
    return { roomId: null, rule: "EMPTY_PAYLOAD", rawDestination: "undefined" };
  }

  // Support both direct payload and nested .d container
  const actualPayload =
    payload.d && typeof payload.d === "object" && !Array.isArray(payload.d)
      ? (payload.d as Record<string, unknown>)
      : payload;

  // 1. Direct physical exit / door graphic component ID: gCId / grfCompunentId
  // In ActionScript: AvatarsManger.onHitExitPoint -> RequestHandler.avatarChangeRoom -> payload.gCId
  const rawGCId = actualPayload.gCId ?? actualPayload.grfCompunentId;
  if (rawGCId !== undefined && rawGCId !== null) {
    const num = Number(rawGCId);
    if (!Number.isNaN(num) && num > 0) {
      return {
        roomId: num,
        rule: `PHYSICAL_DOOR_GCID(${num})`,
        rawDestination: String(rawGCId),
      };
    }
  }

  // 2. Direct numeric room IDs: roomId / rId / id / targetRoomId / destinationRoomId
  const directId =
    actualPayload.roomId ??
    actualPayload.rId ??
    actualPayload.id ??
    actualPayload.targetRoomId ??
    actualPayload.destinationRoomId;
  if (directId !== undefined && directId !== null) {
    const num = Number(directId);
    if (!Number.isNaN(num) && num > 0) {
      return {
        roomId: num,
        rule: `DIRECT_NUMERIC_ID(${num})`,
        rawDestination: String(directId),
      };
    }
  }

  // 3. String identifier: nameId / roomName / name / room / r
  const rawCandidate =
    actualPayload.nameId ??
    actualPayload.roomName ??
    actualPayload.name ??
    actualPayload.room ??
    actualPayload.r;
  if (rawCandidate !== undefined && rawCandidate !== null) {
    const raw = String(rawCandidate).trim();
    if (!raw) {
      return { roomId: null, rule: "BLANK_STRING", rawDestination: "" };
    }

    // Pure numeric string ("70", "160", "20")
    if (/^\d+$/.test(raw)) {
      const num = Number(raw);
      if (num > 0) {
        return {
          roomId: num,
          rule: `NUMERIC_STRING(${num})`,
          rawDestination: raw,
        };
      }
    }

    // "room_70" or "room_20" format
    const matchRoomNum = raw.match(/^room_(\d+)$/i);
    if (matchRoomNum) {
      const num = Number(matchRoomNum[1]);
      return {
        roomId: num,
        rule: `ROOM_PREFIX(${num})`,
        rawDestination: raw,
      };
    }

    // Check Map navigation manifest first
    const mapEntry = WORLD_MAP_NAVIGATION_MANIFEST.find(
      (m) => m.nameId.toLowerCase() === raw.toLowerCase(),
    );
    if (mapEntry) {
      return {
        roomId: mapEntry.targetRoomId,
        rule: `MAP_BUTTON(${mapEntry.nameId}->${mapEntry.targetRoomId})`,
        rawDestination: raw,
      };
    }

    // Check canonical room aliases
    const rawLower = raw.toLowerCase();
    for (const [key, id] of Object.entries(CANONICAL_ROOM_ALIASES)) {
      if (key.toLowerCase() === rawLower) {
        return {
          roomId: id,
          rule: `CANONICAL_ALIAS(${key}->${id})`,
          rawDestination: raw,
        };
      }
    }

    return {
      roomId: null,
      rule: "UNKNOWN_STRING_IDENTIFIER",
      rawDestination: raw,
    };
  }

  return { roomId: null, rule: "UNRECOGNIZED_PAYLOAD", rawDestination: JSON.stringify(payload) };
}

/**
 * Concise resolver returning number | null (null for unresolved).
 */
export function resolveTargetRoomId(
  payload: Record<string, unknown> | undefined,
  currentRoomId?: number,
): number | null {
  return resolveTargetRoomIdDetailed(payload, currentRoomId).roomId;
}

