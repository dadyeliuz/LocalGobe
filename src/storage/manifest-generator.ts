import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BuildDefinition,
  BuildSourceType,
  ContentCategory,
  ItemFamily,
  MiniGameAvailabilityState,
} from "../builds/types.ts";
import { ITEM_FAMILIES } from "../builds/types.ts";
import { getCategoryDir } from "./paths.ts";
import { readRevisionsRecord } from "./revisions-store.ts";
import {
  getRoomPlayableRevisions,
  getSelectedRoomRevision,
  resolveRoomRevision,
  type PlayableRevisionInfo,
} from "./room-resolver.ts";

export type StoredAssetRecord = {
  logicalId: string;
  category: ContentCategory;
  storagePath: string;
  runtimeUrl?: string;
  sha256: string;
  size: number;
  required: boolean;
  feature?: string;
  matchedBy: "apk-whitelist" | "sha256" | "canonical-path" | "structural" | "filename";
  originalFilename: string;
  importedAt: string;
  hashVerified?: boolean;
};

export type LanguageStatusRecord = {
  present: boolean;
  active?: boolean;
  compatible?: boolean;
  compatibilityLevel?: string;
  activeRevisionKey?: string;
  sha256?: string;
  originalFilename?: string;
  sectionsCount?: number;
  missingRequiredSections?: string[];
  revisionsCount: number;
  reason?: string;
  warning?: string;
  status?: string;
  lastUpdate?: string;
};

export type RoomRecord = {
  roomId: number;
  hasSwf: boolean;
  hasTxt: boolean;
  ready: boolean;
  isFallbackPair?: boolean;
  swfSha256?: string;
  txtSha256?: string;
  hasMusic?: boolean;
  revisionsCount?: number;
  selectedRevisionKey?: string | null;
  recommendedRevisionKey?: string | null;
  playableRevisionsCount?: number;
  playableRevisions?: PlayableRevisionInfo[];
  activeRevision?: {
    revisionKey: string;
    formattedDate?: string;
    timestamp?: string;
    filename: string;
    sha256: string;
    reason?: string;
  };
};

export type MiniGameStatusRecord = {
  id: string;
  displayName: string;
  roomId: number;
  state: MiniGameAvailabilityState;
  hasMainSwf: boolean;
  hasXml: boolean;
  hasHelpSwf: boolean;
  hasManagerSwf: boolean;
};

export type UnclassifiedAssetRecord = {
  sha256: string;
  originalFilename: string;
  relativePath: string;
  size: number;
  detectedType: "swf" | "mp3" | "text" | "data";
  confidence: "PROBABLE_MOGOBE";
  evidence: string;
  importedAt: string;
  storagePath: string;
};

export type InstalledBuildManifest = {
  schemaVersion: 1;
  buildId: string;
  displayName: string;
  sourceType: BuildSourceType;
  installedAt: string;
  updatedAt: string;
  apk?: {
    sha256: string;
    versionName: string;
    packageName: string;
    clientAppVer: string;
    recognized: boolean;
    matchedBy: "sha256" | "air-metadata";
  };
  categories: {
    game: {
      ready: boolean;
      extractedCount: number;
      requiredCount: number;
      missingRequired: string[];
    };
    interface: {
      ready: boolean;
      presentCount: number;
      requiredCount: number;
      missingRequired: string[];
      missingOptional: string[];
      language?: LanguageStatusRecord;
      playerCard?: {
        mogoWallSwfPresent: boolean;
        friendCardSwfPresent: boolean;
        mogoWallConfigPresent: boolean;
      };
    };
    world: {
      ready: boolean;
      bootstrapRoomId: number;
      bootstrapRoomReady: boolean;
      roomCount: number;
      roomRevisionsCount?: number;
      musicCount: number;
      rooms: RoomRecord[];
    };
    items: {
      count: number;
      byFamily: Record<ItemFamily, number>;
    };
    miniGames: {
      availableCount: number;
      totalKnownCount: number;
      games: MiniGameStatusRecord[];
    };
  };
  recognizedAssets: StoredAssetRecord[];
  unclassifiedAssets?: UnclassifiedAssetRecord[];
  requiredMissingAssets: string[];
  optionalMissingAssets: string[];
  roomCount: number;
  itemCount: number;
  miniGameCount: number;
  playReady: boolean;
};

/**
 * Recomputes all five category summaries, Room 20 bootstrap readiness, and global
 * capability-based `playReady` from the current list of recognized stored assets.
 */
export function computeBuildManifest(
  build: BuildDefinition,
  existing: Pick<InstalledBuildManifest, "installedAt" | "apk"> & {
    recognizedAssets: StoredAssetRecord[];
    unclassifiedAssets?: UnclassifiedAssetRecord[];
  },
  options: { dataDir?: string } = {},
): InstalledBuildManifest {
  const now = new Date().toISOString();
  const assets = existing.recognizedAssets;
  const byLogicalId = new Map<string, StoredAssetRecord>();
  for (const a of assets) {
    byLogicalId.set(a.logicalId, a);
  }

  // ── 1. GAME category ──
  const requiredApkSpecs = build.apkRequiredAssets.filter((s) => s.required);
  const missingGameRequired: string[] = [];
  for (const spec of requiredApkSpecs) {
    if (!byLogicalId.has(spec.logicalId)) {
      missingGameRequired.push(spec.storagePath);
    }
  }
  const gameAssets = assets.filter((a) => a.category === "game");
  const gameReady =
    (build.sourceType !== "APK" || Boolean(existing.apk?.recognized)) &&
    missingGameRequired.length === 0;

  // ── 2. INTERFACE category ──
  const interfaceRules = build.externalRecognitionRules.filter((r) => r.category === "interface");
  // Language is never a blocker for interfaceReady / playReady
  const requiredInterfaceRules = interfaceRules.filter((r) => r.required && r.logicalId !== "interface:language-he");
  const missingInterfaceRequired: string[] = [];
  const missingInterfaceOptional: string[] = [];
  for (const rule of interfaceRules) {
    if (!byLogicalId.has(rule.logicalId)) {
      if (rule.required && rule.logicalId !== "interface:language-he") {
        missingInterfaceRequired.push(rule.storagePath);
      } else {
        missingInterfaceOptional.push(rule.storagePath);
      }
    }
  }
  const interfaceAssets = assets.filter((a) => a.category === "interface");

  // Language status computation (Warning / Experience metadata, never blocking playReady)
  let languageStatus: LanguageStatusRecord;
  const langRec = readRevisionsRecord(build.buildId, "interface", "Language", "he", options.dataDir);
  const langAsset = byLogicalId.get("interface:language-he");
  if (langRec && Object.keys(langRec.revisions).length > 0) {
    const revisionsCount = Object.keys(langRec.revisions).length;
    const activeRev = langRec.activeRevisionKey ? langRec.revisions[langRec.activeRevisionKey] : null;
    const isCompat = Boolean(activeRev && activeRev.compatibility === "compatible");
    languageStatus = {
      present: true,
      active: Boolean(activeRev && isCompat),
      compatible: isCompat,
      activeRevisionKey: activeRev?.revisionKey,
      sha256: activeRev?.files["xml"]?.sha256 ?? langAsset?.sha256,
      originalFilename: activeRev?.files["xml"]?.originalFilename ?? langAsset?.originalFilename,
      revisionsCount,
      reason: activeRev?.compatibilityReason ?? langRec.activeReason ?? undefined,
      warning: !activeRev ? "לא נבחרה גרסת שפה פעילה" : undefined,
      lastUpdate: activeRev?.lastUpdate,
    };
  } else if (langAsset) {
    languageStatus = {
      present: true,
      active: true,
      compatible: true,
      sha256: langAsset.sha256,
      originalFilename: langAsset.originalFilename,
      revisionsCount: 1,
    };
  } else {
    languageStatus = {
      present: false,
      active: false,
      compatible: false,
      revisionsCount: 0,
      warning: "חסר קובץ השפה העברי של מוגובי",
      reason: "חסר קובץ השפה העברי של מוגובי",
    };
  }

  const interfaceReady = missingInterfaceRequired.length === 0;
  const mogoWallSwfPresent = byLogicalId.has("interface:mogowall-swf");
  const friendCardSwfPresent = byLogicalId.has("interface:friendcard-swf");
  const mogoWallConfigPresent = byLogicalId.has("interface:mogowall-txt");

  // ── 3. WORLD category (Room 20 bootstrap rule) ──
  const worldAssets = assets.filter((a) => a.category === "world");
  const roomsMap = new Map<number, RoomRecord>();
  let musicCount = 0;

  for (const a of worldAssets) {
    const roomMatch = /^Rooms\/room_(\d+)\.(swf|txt)$/i.exec(a.storagePath);
    if (roomMatch) {
      const roomId = Number(roomMatch[1]);
      const ext = roomMatch[2].toLowerCase();
      let rec = roomsMap.get(roomId);
      if (!rec) {
        rec = { roomId, hasSwf: false, hasTxt: false, ready: false };
        roomsMap.set(roomId, rec);
      }
      if (ext === "swf") {
        rec.hasSwf = true;
        rec.swfSha256 = a.sha256;
      } else if (ext === "txt") {
        rec.hasTxt = true;
        rec.txtSha256 = a.sha256;
      }
      rec.ready = build.roomRequiresTxt ? rec.hasSwf && rec.hasTxt : rec.hasSwf;
    } else if (/^Sound\/Rooms\/.+\.mp3$/i.test(a.storagePath)) {
      musicCount++;
    }
  }

  try {
    const roomsDir = join(getCategoryDir(build.buildId, "world", options.dataDir), "Rooms");
    if (existsSync(roomsDir)) {
      for (const entry of readdirSync(roomsDir)) {
        if (/^\d+$/.test(entry)) {
          const roomId = Number(entry);
          if (!roomsMap.has(roomId)) {
            roomsMap.set(roomId, { roomId, hasSwf: false, hasTxt: false, ready: false });
          }
        }
      }
    }
  } catch {
    // ignore directory read error
  }

  const rooms = Array.from(roomsMap.values()).sort((a, b) => a.roomId - b.roomId);
  for (const r of rooms) {
    try {
      const bundle = resolveRoomRevision(build.buildId, r.roomId, options.dataDir);
      const revRec = readRevisionsRecord(build.buildId, "world", "Rooms", r.roomId, options.dataDir);
      const playable = getRoomPlayableRevisions(build.buildId, r.roomId, options.dataDir);
      const selectedKey = getSelectedRoomRevision(build.buildId, r.roomId, options.dataDir);

      r.selectedRevisionKey = selectedKey;
      r.playableRevisions = playable;
      r.playableRevisionsCount = playable.filter((p) => p.isComplete).length || (bundle ? 1 : 0);
      r.recommendedRevisionKey = playable.find((p) => p.isRecommended)?.revisionKey ?? (bundle?.revisionKey ?? null);
      r.revisionsCount = revRec ? Object.keys(revRec.revisions).length : (playable.length || (r.hasSwf ? 1 : 0));
      r.hasSwf = playable.some((p) => Boolean(p.swfSha256)) || Boolean(revRec && Object.values(revRec.revisions).some((rev) => Boolean(rev.files.swf))) || r.hasSwf || Boolean(bundle?.swfBytes);
      r.hasTxt = playable.some((p) => Boolean(p.txtSha256)) || Boolean(revRec && Object.values(revRec.revisions).some((rev) => Boolean(rev.files.txt))) || r.hasTxt || Boolean(bundle?.txtBytes);
      r.isFallbackPair = Boolean(bundle?.isFallbackPair);

      if (bundle) {
        r.ready = true;
        r.hasSwf = true;
        r.hasTxt = Boolean(bundle.txtBytes || !build.roomRequiresTxt);
        r.swfSha256 = bundle.swfSha256 || r.swfSha256;
        r.txtSha256 = bundle.txtSha256 ?? r.txtSha256;
        r.activeRevision = {
          revisionKey: bundle.revisionKey,
          filename: bundle.swfFilename,
          sha256: bundle.swfSha256,
          reason: bundle.selectionMode === "selected"
            ? "נבחר על ידי המשתמש"
            : bundle.isFallbackPair
              ? "שודך כצמד חלופי (SWF + TXT)"
              : revRec?.activeReason ?? undefined,
        };
      } else {
        r.ready = false;
      }
    } catch {
      // ignore errors reading revisions
    }
  }
  const readyRooms = rooms.filter((r) => r.ready);
  const roomRevisionsCount = rooms.length > 0
    ? rooms.reduce((sum, r) => sum + (r.revisionsCount ?? 1), 0)
    : 0;
  const bootstrapRoom = roomsMap.get(build.bootstrapRoomId);
  const bootstrapRoomReady = Boolean(bootstrapRoom?.ready);
  const worldReady = bootstrapRoomReady;

  const missingWorldRequired: string[] = [];
  if (!bootstrapRoom?.hasSwf) {
    missingWorldRequired.push(`Rooms/room_${build.bootstrapRoomId}.swf`);
  }
  if (build.roomRequiresTxt && !bootstrapRoom?.hasTxt) {
    missingWorldRequired.push(`Rooms/room_${build.bootstrapRoomId}.txt`);
  }

  // ── 4. ITEMS category ──
  const itemAssets = assets.filter((a) => a.category === "items");
  const byFamily: Record<ItemFamily, number> = {
    IconS: 0,
    IconW: 0,
    BigItem: 0,
    BtnItem: 0,
    BtnAccessory: 0,
    Cat: 0,
    Gift: 0,
    RoomItem: 0,
  };
  const uniqueItemIds = new Set<string>();
  for (const a of itemAssets) {
    const m = /^([A-Za-z]+)\/(\d+)\.swf$/i.exec(a.storagePath);
    if (m) {
      const fam = ITEM_FAMILIES.find((f) => f.toLowerCase() === m[1].toLowerCase());
      if (fam) byFamily[fam]++;
      uniqueItemIds.add(m[2]);
    }
  }
  const itemCount = uniqueItemIds.size > 0 ? uniqueItemIds.size : itemAssets.length;

  // ── 5. MINI GAMES category ──
  const miniGameAssets = assets.filter((a) => a.category === "miniGames");
  const miniGameFilesLower = new Set(
    miniGameAssets.map((a) => a.storagePath.split("/").pop()?.toLowerCase() ?? ""),
  );
  const gameStatusList: MiniGameStatusRecord[] = [];
  for (const spec of build.miniGames) {
    const hasMainSwf = miniGameFilesLower.has(spec.mainSwf.toLowerCase());
    const hasXml = !spec.requiresXml || (spec.xmlFile ? miniGameFilesLower.has(spec.xmlFile.toLowerCase()) : true);
    const hasHelpSwf = spec.helpSwf ? miniGameFilesLower.has(spec.helpSwf.toLowerCase()) : false;
    const hasManagerSwf =
      miniGameFilesLower.has(`${spec.managerSwf.toLowerCase()}.swf`) ||
      // In 2016 Android APK, ExternalGameManager / GameManager classes are compiled into MogobeTabIL.swf
      build.sourceType === "APK";

    // Decouple catalog: only display mini-games actually owned/imported by the user (complete or partial)
    const hasAnyAsset =
      hasMainSwf ||
      (spec.requiresXml && spec.xmlFile ? miniGameFilesLower.has(spec.xmlFile.toLowerCase()) : false) ||
      hasHelpSwf;

    if (!hasAnyAsset) {
      continue;
    }

    let state: MiniGameAvailabilityState;
    if (!hasMainSwf) {
      state = "Missing original game file";
    } else if (!hasXml) {
      state = "Missing original configuration";
    } else if (!hasManagerSwf) {
      state = "Missing original dependency";
    } else {
      state = "Available";
    }

    gameStatusList.push({
      id: spec.id,
      displayName: spec.displayName,
      roomId: spec.roomId,
      state,
      hasMainSwf,
      hasXml,
      hasHelpSwf,
      hasManagerSwf,
    });
  }
  const availableMiniGames = gameStatusList.filter((g) => g.state === "Available").length;

  // ── Capability-based Play Readiness ──
  const requiredMissingAssets = [
    ...missingGameRequired,
    ...missingInterfaceRequired,
    ...missingWorldRequired,
  ];
  const playReady = gameReady && interfaceReady && worldReady;

  return {
    schemaVersion: 1,
    buildId: build.buildId,
    displayName: build.displayName,
    sourceType: build.sourceType,
    installedAt: existing.installedAt,
    updatedAt: now,
    apk: existing.apk,
    categories: {
      game: {
        ready: gameReady,
        extractedCount: gameAssets.length,
        requiredCount: requiredApkSpecs.length,
        missingRequired: missingGameRequired,
      },
      interface: {
        ready: interfaceReady,
        presentCount: interfaceAssets.length,
        requiredCount: requiredInterfaceRules.length,
        missingRequired: missingInterfaceRequired,
        missingOptional: missingInterfaceOptional,
        language: languageStatus,
        playerCard: {
          mogoWallSwfPresent,
          friendCardSwfPresent,
          mogoWallConfigPresent,
        },
      },
      world: {
        ready: worldReady,
        bootstrapRoomId: build.bootstrapRoomId,
        bootstrapRoomReady,
        roomCount: readyRooms.length,
        roomRevisionsCount,
        musicCount,
        rooms,
      },
      items: {
        count: itemCount,
        byFamily,
      },
      miniGames: {
        availableCount: availableMiniGames,
        totalKnownCount: gameStatusList.length,
        games: gameStatusList,
      },
    },
    recognizedAssets: assets,
    unclassifiedAssets: existing.unclassifiedAssets ?? [],
    requiredMissingAssets,
    optionalMissingAssets: missingInterfaceOptional,
    roomCount: readyRooms.length,
    itemCount,
    miniGameCount: availableMiniGames,
    playReady,
  };
}
