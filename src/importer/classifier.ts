import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { BuildDefinition } from "../builds/types.ts";
import { ITEM_FAMILIES } from "../builds/types.ts";
import { extractRevisionTimestamp } from "../storage/revisions-store.ts";
import { verifyMapPopupStructuralContract } from "../storage/map-popup-validator.ts";
import { inspectMogobeLanguageXml } from "./language-inspector.ts";
import { inspectMogobeChatXml } from "./chat-inspector.ts";
import type { ClassificationResult } from "./types.ts";

type RoomMusicMap = {
  schema: string;
  rooms: Record<string, { status: string; rbs: string | null; sha256: string | null }>;
};

let cachedMusicBySha: Map<string, string> | null = null;
let cachedMusicByFilename: Map<string, string> | null = null;

function loadMusicIndexes(): { bySha: Map<string, string>; byFilename: Map<string, string> } {
  if (cachedMusicBySha && cachedMusicByFilename) {
    return { bySha: cachedMusicBySha, byFilename: cachedMusicByFilename };
  }
  const bySha = new Map<string, string>();
  const byFilename = new Map<string, string>();
  try {
    const mapPath = resolve(fileURLToPath(new URL("../server/http/room-music-map.json", import.meta.url)));
    const parsed = JSON.parse(readFileSync(mapPath, "utf8")) as RoomMusicMap;
    for (const entry of Object.values(parsed.rooms ?? {})) {
      if (entry.status === "MAPPED" && entry.rbs) {
        if (entry.sha256 && !bySha.has(entry.sha256.toLowerCase())) {
          bySha.set(entry.sha256.toLowerCase(), entry.rbs);
        }
        byFilename.set(entry.rbs.toLowerCase(), entry.rbs);
      }
    }
  } catch {
    // fallback to empty map if unavailable
  }
  cachedMusicBySha = bySha;
  cachedMusicByFilename = byFilename;
  return { bySha, byFilename };
}

export function isValidSwfBuffer(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  const sig = bytes.toString("ascii", 0, 3);
  return sig === "FWS" || sig === "CWS" || sig === "ZWS";
}

export function isValidMp3Buffer(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  // ID3v2 header or MPEG frame sync
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  return false;
}

export function isValidTextBuffer(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  // Reject obvious binary files (NUL bytes in first 256 bytes)
  const checkLen = Math.min(bytes.length, 256);
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0x00) return false;
  }
  return true;
}

const MAX_ROOM_CONFIG_BYTES = 2 * 1024 * 1024;

export function isValidRoomConfigBuffer(bytes: Buffer): boolean {
  if (!isValidTextBuffer(bytes) || bytes.length > MAX_ROOM_CONFIG_BYTES) return false;
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const sample = bytes.subarray(start, Math.min(bytes.length, start + 512)).toString("utf8").trimStart();
  if (!sample) return false;
  // Reject obvious non-room documents (HTML pages, PDFs, ZIPs, SWFs)
  if (/^(?:<!doctype|<html|%pdf-|pk\x03\x04|fws|cws|zws)/i.test(sample)) return false;
  return true;
}

function matchesStructuralKind(kind: "swf" | "txt" | "xml" | "mp3" | "any" | undefined, bytes: Buffer): boolean {
  if (!kind || kind === "any") return true;
  if (kind === "swf") return isValidSwfBuffer(bytes);
  if (kind === "mp3") return isValidMp3Buffer(bytes);
  if (kind === "txt") return isValidTextBuffer(bytes);
  if (kind === "xml") return isValidTextBuffer(bytes) && bytes.toString("utf8", 0, 512).includes("<");
  return true;
}

function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/**
 * Classifies an incoming original file into one of the five LocalGobe categories.
 * Priority order:
 *   1. Exact SHA-256 match (rank 100)
 *   2. Known canonical path match + structural validation (rank 80)
 *   3. Structural + pattern match for rooms / items / mini-games / loading screens / music (rank 60)
 *   4. Unambiguous filename fallback + structural validation (rank 40)
 */
export function classifyExternalFile(
  build: BuildDefinition,
  relativePath: string,
  sha256: string,
  bytes: Buffer,
): ClassificationResult {
  const lowerHash = sha256.toLowerCase();
  const normPath = normalizePath(relativePath);
  const filename = normPath.split("/").pop() ?? normPath;

  // ── Priority 1: Exact SHA-256 match against declarative build rules ──
  for (const rule of build.externalRecognitionRules) {
    if (rule.knownHashes.includes(lowerHash)) {
      const isLang = rule.logicalId === "interface:language-he";
      const isChat = rule.logicalId === "interface:chat-language-he" || rule.logicalId.startsWith("interface:chat-language-");
      const roomM = /^world:room-(\d+)-(swf|txt)$/i.exec(rule.logicalId);
      const isRoom = Boolean(roomM);
      const roomId = roomM ? Number(roomM[1]) : undefined;
      const roomRole = roomM ? roomM[2].toLowerCase() : undefined;
      const langInsp = isLang ? inspectMogobeLanguageXml(bytes) : undefined;
      if (isLang && !langInsp?.valid) {
        return {
          recognized: false,
          confidence: "INVALID_OR_UNRELATED",
          reason: langInsp?.reason || "קובץ שפה אינו תקין",
        };
      }
      const chatInsp = isChat ? inspectMogobeChatXml(bytes, filename) : undefined;
      if (isChat && !chatInsp?.valid) {
        return {
          recognized: false,
          confidence: "INVALID_OR_UNRELATED",
          reason: chatInsp?.reason || "קובץ צ'אט אינו תקין",
        };
      }
      const ts = isLang
        ? extractRevisionTimestamp(filename) ||
          (langInsp?.lastUpdate ? langInsp.lastUpdate.replace(/[^0-9]/g, "").slice(0, 14) : undefined)
        : extractRevisionTimestamp(filename) ?? undefined;
      return {
        recognized: true,
        confidence: "KNOWN_EXACT",
        logicalId: rule.logicalId,
        category: rule.category,
        storagePath: rule.storagePath,
        runtimeUrl: rule.runtimeUrl,
        required: rule.required,
        feature: rule.feature,
        matchedBy: "sha256",
        rank: 100,
        entityType: isLang ? "language" : isChat ? "chat-language" : isRoom ? "room" : undefined,
        entityId: isLang ? "he" : isChat ? String(chatInsp?.languageId ?? "1") : isRoom ? roomId : undefined,
        role: isLang || isChat ? "xml" : isRoom ? roomRole : undefined,
        revisionKey: isLang || isChat ? (ts || lowerHash.slice(0, 12)) : isRoom ? (ts || "canonical") : undefined,
        timestamp: ts,
        languageInspection: langInsp,
        chatInspection: chatInsp,
      };
    }
  }

  // Priority 1b: Exact SHA-256 match against known Room Music hashes
  const musicIndex = loadMusicIndexes();
  const musicByHash = musicIndex.bySha.get(lowerHash);
  if (musicByHash && isValidMp3Buffer(bytes)) {
    return {
      recognized: true,
      confidence: "KNOWN_EXACT",
      logicalId: `world:music:${musicByHash.toLowerCase()}`,
      category: "world",
      storagePath: `Sound/Rooms/${musicByHash}`,
      runtimeUrl: `/Sound/Rooms/${musicByHash}`,
      required: false,
      feature: "RoomMusic",
      matchedBy: "sha256",
      rank: 100,
    };
  }

  // ── Priority 2: Known canonical path match against declarative build rules ──
  for (const rule of build.externalRecognitionRules) {
    const pathMatches = rule.canonicalPaths.some((cp) => normPath === cp || normPath.endsWith(`/${cp}`));
    if (pathMatches) {
      if (rule.logicalId === "interface:language-he") {
        const langInsp = inspectMogobeLanguageXml(bytes);
        if (!langInsp.valid) {
          return {
            recognized: false,
            confidence: "INVALID_OR_UNRELATED",
            reason: langInsp.reason || "קובץ שפה אינו תקין",
          };
        }
        const ts =
          extractRevisionTimestamp(filename) ||
          (langInsp.lastUpdate ? langInsp.lastUpdate.replace(/[^0-9]/g, "").slice(0, 14) : undefined);
        return {
          recognized: true,
          confidence: "KNOWN_PATTERN",
          logicalId: rule.logicalId,
          category: rule.category,
          storagePath: rule.storagePath,
          runtimeUrl: rule.runtimeUrl,
          required: rule.required,
          feature: rule.feature,
          matchedBy: "canonical-path",
          rank: 80,
          entityType: "language",
          entityId: "he",
          role: "xml",
          revisionKey: ts || lowerHash.slice(0, 12),
          timestamp: ts,
          languageInspection: langInsp,
        };
      }
      if (rule.logicalId === "interface:chat-language-he" || rule.logicalId.startsWith("interface:chat-language-")) {
        const chatInsp = inspectMogobeChatXml(bytes, filename);
        if (!chatInsp.valid) {
          return {
            recognized: false,
            confidence: "INVALID_OR_UNRELATED",
            reason: chatInsp.reason || "קובץ צ'אט אינו תקין",
          };
        }
        const ts = extractRevisionTimestamp(filename) ?? undefined;
        return {
          recognized: true,
          confidence: "KNOWN_PATTERN",
          logicalId: rule.logicalId,
          category: rule.category,
          storagePath: rule.storagePath,
          runtimeUrl: rule.runtimeUrl,
          required: rule.required,
          feature: rule.feature,
          matchedBy: "canonical-path",
          rank: 80,
          entityType: "chat-language",
          entityId: String(chatInsp.languageId),
          role: "xml",
          revisionKey: ts || lowerHash.slice(0, 12),
          timestamp: ts,
          chatInspection: chatInsp,
        };
      }
      if (!matchesStructuralKind(rule.structuralKind, bytes)) {
        return {
          recognized: false,
          confidence: "INVALID_OR_UNRELATED",
          reason: `File content does not match expected ${rule.structuralKind} format`,
        };
      }
      const roomM = /^world:room-(\d+)-(swf|txt)$/i.exec(rule.logicalId);
      const isRoom = Boolean(roomM);
      const roomId = roomM ? Number(roomM[1]) : undefined;
      const roomRole = roomM ? roomM[2].toLowerCase() : undefined;
      const ts = extractRevisionTimestamp(filename) ?? undefined;
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: rule.logicalId,
        category: rule.category,
        storagePath: rule.storagePath,
        runtimeUrl: rule.runtimeUrl,
        required: rule.required,
        feature: rule.feature,
        matchedBy: "canonical-path",
        rank: 80,
        entityType: isRoom ? "room" : undefined,
        entityId: isRoom ? roomId : undefined,
        role: isRoom ? roomRole : undefined,
        revisionKey: isRoom ? (ts || "canonical") : undefined,
        timestamp: ts,
      };
    }
  }

  // ── Priority 3: Structured World / Items / Mini Games / Interface patterns ──

  // 3a. World Rooms: canonical `room_<id>.(swf|txt)` and archival revision names
  // such as `room_<id>_20150809221546_80976ff5.(swf|txt)` in any directory structure.
  const roomMatch = /^room_(\d+)(?:_([a-z0-9._-]+))?\.(swf|txt)$/i.exec(filename);
  if (roomMatch) {
    const roomId = Number(roomMatch[1]);
    const hasRevisionSuffix = Boolean(roomMatch[2]);
    const ext = roomMatch[3].toLowerCase() as "swf" | "txt";
    if (!Number.isSafeInteger(roomId) || roomId <= 0 || roomId > 999999) {
      return {
        recognized: false,
        confidence: "INVALID_OR_UNRELATED",
        reason: `Invalid room ID in ${filename}`,
      };
    }
    const valid = ext === "swf" ? isValidSwfBuffer(bytes) : isValidRoomConfigBuffer(bytes);
    if (!valid) {
      return {
        recognized: false,
        confidence: "INVALID_OR_UNRELATED",
        reason: `Invalid ${ext.toUpperCase()} content for room_${roomId}.${ext}`,
      };
    }
    const inRoomsPath = normPath.includes("rooms/");
    const inAssetsPath = inRoomsPath || normPath.includes("assetsclean/");
    const matchedBy = !hasRevisionSuffix && inRoomsPath ? "canonical-path" : "structural";
    const rank = !hasRevisionSuffix && inRoomsPath ? 80 : !hasRevisionSuffix || inAssetsPath ? 65 : 60;
    const ts = extractRevisionTimestamp(filename) ?? undefined;
    const revKey = ts || (roomMatch[2] ? roomMatch[2].replace(/[._-]/g, "") : "canonical");
    return {
      recognized: true,
      confidence: "KNOWN_PATTERN",
      logicalId: `world:room-${roomId}-${ext}`,
      category: "world",
      storagePath: `Rooms/room_${roomId}.${ext}`,
      runtimeUrl: `/Swf/AssetsClean/Rooms/room_${roomId}.${ext}`,
      required: roomId === build.bootstrapRoomId,
      feature: `Room ${roomId}`,
      matchedBy,
      rank,
      entityType: "room",
      entityId: roomId,
      role: ext,
      revisionKey: revKey,
      timestamp: ts,
    };
  }

  // 3b. World Room Music by canonical path or known room-music filename
  if (filename.endsWith(".mp3") && isValidMp3Buffer(bytes)) {
    if (normPath.includes("sound/rooms/")) {
      const origName = relativePath.replace(/\\/g, "/").split("/").pop() ?? filename;
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `world:music:${origName.toLowerCase()}`,
        category: "world",
        storagePath: `Sound/Rooms/${origName}`,
        runtimeUrl: `/Sound/Rooms/${origName}`,
        required: false,
        feature: "RoomMusic",
        matchedBy: "canonical-path",
        rank: 80,
      };
    }
    const knownMusicName = musicIndex.byFilename.get(filename);
    if (knownMusicName) {
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `world:music:${knownMusicName.toLowerCase()}`,
        category: "world",
        storagePath: `Sound/Rooms/${knownMusicName}`,
        runtimeUrl: `/Sound/Rooms/${knownMusicName}`,
        required: false,
        feature: "RoomMusic",
        matchedBy: "filename",
        rank: 40,
      };
    }

    // 3b-2. Interface / Action Sounds (Sound/moves/*.mp3, Sound/UI/*.mp3, Sound/*.mp3)
    const soundSubMatch = /(?:^|\/)sound\/(moves|ui)\/([^/]+\.mp3)$/i.exec(normPath);
    if (soundSubMatch) {
      const subDir = soundSubMatch[1].toLowerCase() === "ui" ? "UI" : "moves";
      const origName = relativePath.replace(/\\/g, "/").split("/").pop() ?? filename;
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `interface:sound:${subDir.toLowerCase()}:${origName.toLowerCase()}`,
        category: "interface",
        storagePath: `Sound/${subDir}/${origName}`,
        runtimeUrl: `/Sound/${subDir}/${origName}`,
        required: false,
        feature: "SoundEffects",
        matchedBy: "canonical-path",
        rank: 80,
      };
    }
    if (/(?:^|\/)sound\/[^/]+\.mp3$/i.test(normPath)) {
      const origName = relativePath.replace(/\\/g, "/").split("/").pop() ?? filename;
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `interface:sound:root:${origName.toLowerCase()}`,
        category: "interface",
        storagePath: `Sound/${origName}`,
        runtimeUrl: `/Sound/${origName}`,
        required: false,
        feature: "SoundEffects",
        matchedBy: "canonical-path",
        rank: 80,
      };
    }
  }

  // 3c. Items: recognized by canonical item-family folder (IconS, IconW, BigItem, BtnItem, BtnAccessory, Cat, Gift, RoomItem)
  const itemPathMatch = /(?:^|\/)(icons|iconw|bigitem|btnitem|btnaccessory|cat|gift|roomitem)\/(\d+)\.swf$/i.exec(normPath);
  if (itemPathMatch) {
    if (!isValidSwfBuffer(bytes)) {
      return {
        recognized: false,
        confidence: "INVALID_OR_UNRELATED",
        reason: "Invalid SWF header for item asset",
      };
    }
    const canonicalFamily = ITEM_FAMILIES.find((f) => f.toLowerCase() === itemPathMatch[1].toLowerCase())!;
    const itemId = itemPathMatch[2];
    return {
      recognized: true,
      confidence: "KNOWN_PATTERN",
      logicalId: `items:${canonicalFamily}:${itemId}`,
      category: "items",
      storagePath: `${canonicalFamily}/${itemId}.swf`,
      runtimeUrl: `/Swf/AssetsClean/Items/${canonicalFamily}/${itemId}.swf`,
      required: false,
      feature: canonicalFamily,
      matchedBy: "canonical-path",
      rank: 80,
    };
  }

  // 3d. Mini Games: match against known mini-games catalog (main SWF, help SWF, XML config, managers)
  for (const game of build.miniGames) {
    if (filename === game.mainSwf.toLowerCase() && isValidSwfBuffer(bytes)) {
      const isCanonical = normPath.includes("games/");
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `minigame:${game.id}:main`,
        category: "miniGames",
        storagePath: `Games/${game.mainSwf}`,
        runtimeUrl: `/Swf/Rooms/${game.mainSwf}`,
        required: false,
        feature: game.displayName,
        matchedBy: isCanonical ? "canonical-path" : "structural",
        rank: isCanonical ? 80 : 60,
      };
    }
    if (game.helpSwf && filename === game.helpSwf.toLowerCase() && isValidSwfBuffer(bytes)) {
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `minigame:${game.id}:help`,
        category: "miniGames",
        storagePath: `Helps/${game.helpSwf}`,
        runtimeUrl: `/Swf/Assets/Games/Helps/${game.helpSwf}`,
        required: false,
        feature: game.displayName,
        matchedBy: normPath.includes("helps/") ? "canonical-path" : "structural",
        rank: normPath.includes("helps/") ? 80 : 60,
      };
    }
    if (game.xmlFile && filename === game.xmlFile.toLowerCase() && matchesStructuralKind("xml", bytes)) {
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: `minigame:${game.id}:xml`,
        category: "miniGames",
        storagePath: `Games/${game.xmlFile}`,
        runtimeUrl: `/Swf/Apps/Games/${game.xmlFile}`,
        required: false,
        feature: game.displayName,
        matchedBy: normPath.includes("games/") ? "canonical-path" : "structural",
        rank: normPath.includes("games/") ? 80 : 60,
      };
    }
  }

  // Mini-game managers & help SWFs under canonical paths
  if ((filename === "gamemanager.swf" || filename === "externalgamemanager.swf") && isValidSwfBuffer(bytes)) {
    const canonicalName = filename === "gamemanager.swf" ? "GameManager.swf" : "ExternalGameManager.swf";
    return {
      recognized: true,
      confidence: "KNOWN_PATTERN",
      logicalId: `minigame:manager:${filename}`,
      category: "miniGames",
      storagePath: `Managers/${canonicalName}`,
      runtimeUrl: `/Swf/Apps/Games/${canonicalName}`,
      required: false,
      feature: "GameManagers",
      matchedBy: normPath.includes("games/") ? "canonical-path" : "filename",
      rank: normPath.includes("games/") ? 80 : 40,
    };
  }

  if (normPath.includes("games/helps/") && filename.endsWith(".swf") && isValidSwfBuffer(bytes)) {
    const origName = relativePath.replace(/\\/g, "/").split("/").pop() ?? filename;
    return {
      recognized: true,
      confidence: "KNOWN_PATTERN",
      logicalId: `minigame:help:${origName.toLowerCase()}`,
      category: "miniGames",
      storagePath: `Helps/${origName}`,
      runtimeUrl: `/Swf/Assets/Games/Helps/${origName}`,
      required: false,
      feature: "GameHelps",
      matchedBy: "canonical-path",
      rank: 80,
    };
  }

  // 3e. Interface LoadingScreens & MogoWall sub-assets
  const loadingMatch = /^loadingscreen_(\d+)\.swf$/i.exec(filename);
  if (loadingMatch && isValidSwfBuffer(bytes)) {
    const origName = `LoadingScreen_${loadingMatch[1]}.swf`;
    return {
      recognized: true,
      confidence: "KNOWN_PATTERN",
      logicalId: `interface:loading-screen-${loadingMatch[1]}`,
      category: "interface",
      storagePath: `LoadingScreens/${origName}`,
      runtimeUrl: `/Swf/AssetsClean/LoadingScreens/${origName}`,
      required: false,
      feature: "LoadingScreens",
      matchedBy: normPath.includes("loadingscreens/") ? "canonical-path" : "structural",
      rank: normPath.includes("loadingscreens/") ? 80 : 60,
    };
  }

  if (
    (normPath.includes("mogowall") || normPath.includes("friendcard")) &&
    (filename.endsWith(".swf") || filename.endsWith(".txt"))
  ) {
    const valid = filename.endsWith(".swf") ? isValidSwfBuffer(bytes) : isValidTextBuffer(bytes);
    if (valid) {
      const origName = relativePath.replace(/\\/g, "/").split("/").pop() ?? filename;
      const lowerFile = origName.toLowerCase();
      let logicalId = `interface:mogowall:${lowerFile}`;
      let storageName = origName;
      let feature = "MogoWall";
      if (lowerFile === "mogowall.swf") {
        logicalId = "interface:mogowall-swf";
        storageName = "MogoWall.swf";
        feature = "MogoWall";
      } else if (lowerFile === "friendcard.swf") {
        logicalId = "interface:friendcard-swf";
        storageName = "FriendCard.swf";
        feature = "FriendCard";
      } else if (lowerFile === "mogowall.txt") {
        logicalId = "interface:mogowall-txt";
        storageName = "MogoWall.txt";
        feature = "MogoWall";
      }
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId,
        category: "interface",
        storagePath: `MogoWall/${storageName}`,
        runtimeUrl: `/Swf/AssetsClean/MogoWall/${storageName}`,
        required: false,
        feature,
        matchedBy: "canonical-path",
        rank: 80,
      };
    }
  }

  // 3f. Popups family: p_<id>.swf and popup_<id>.swf (e.g. p_3.swf, popup_12.swf)
  const popupMatch = /^(?:p|popup)_(\d+)(?:_([a-z0-9._-]+))?\.swf$/i.exec(filename);
  if (popupMatch && isValidSwfBuffer(bytes)) {
    const popupId = popupMatch[1];
    const origName = `p_${popupId}.swf`;
    const inPopupsPath = normPath.includes("popups/");
    const ts = extractRevisionTimestamp(filename) ?? undefined;
    const revKey = ts || (popupMatch[2] ? popupMatch[2].replace(/[._-]/g, "") : "canonical");
    return {
      recognized: true,
      confidence: "KNOWN_PATTERN",
      logicalId: `interface:popup-${popupId}`,
      category: "interface",
      storagePath: `Popups/${origName}`,
      runtimeUrl: `/Swf/AssetsClean/Popups/${origName}`,
      required: false,
      feature: `Popup ${popupId}`,
      matchedBy: inPopupsPath ? "canonical-path" : "structural",
      rank: inPopupsPath ? 80 : 60,
      entityType: "popup",
      entityId: Number(popupId),
      role: "swf",
      revisionKey: revKey,
      timestamp: ts,
    };
  }

  // 3f-2. Structural recognition of Mogobe World Map (Popup 3)
  // If an incoming SWF file satisfies the MapPopup contract (mlPopup_3 -> mcMap + btnClose -> btnRoom_<id>),
  // recognize it as Popup 3 regardless of whether the filename is p_3.swf, popup_3.swf, or an archival capture name like 20150809...swf.
  if (isValidSwfBuffer(bytes)) {
    const mapCheck = verifyMapPopupStructuralContract(bytes);
    if (mapCheck.structurallyCompatible) {
      const origName = "p_3.swf";
      const ts = extractRevisionTimestamp(filename) ?? undefined;
      const revKey = ts || lowerHash.slice(0, 12);
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: "interface:popup-3",
        category: "interface",
        storagePath: `Popups/${origName}`,
        runtimeUrl: `/Swf/AssetsClean/Popups/${origName}`,
        required: false,
        feature: "Popup 3 (World Map)",
        matchedBy: "structural",
        rank: 75,
        entityType: "popup",
        entityId: 3,
        role: "swf",
        revisionKey: revKey,
        timestamp: ts,
      };
    }
  }

  // 3g. Mogobe Hebrew Language Dictionary (lang.aspx / Language XML)
  const isLangFilename =
    filename === "lang.aspx" ||
    filename.startsWith("lang_") ||
    normPath.includes("servises/lang.aspx") ||
    normPath.includes("configs/lang.aspx");

  if (isLangFilename || filename.endsWith(".xml") || filename.endsWith(".aspx")) {
    const langInspection = inspectMogobeLanguageXml(bytes);
    if (langInspection.valid) {
      const ts =
        extractRevisionTimestamp(filename) ??
        (langInspection.lastUpdate
          ? langInspection.lastUpdate.replace(/[^0-9]/g, "").slice(0, 14)
          : undefined);
      const revKey = ts || lowerHash.slice(0, 12);
      const inServicesPath =
        normPath.includes("servises/") ||
        normPath.includes("services/") ||
        normPath.includes("configs/");

      return {
        recognized: true,
        confidence: isLangFilename ? "KNOWN_PATTERN" : "PROBABLE_MOGOBE",
        logicalId: "interface:language-he",
        category: "interface",
        storagePath: "Language/lang.aspx",
        runtimeUrl: "/servises/lang.aspx",
        required: false,
        feature: "Hebrew Language",
        matchedBy: inServicesPath ? "canonical-path" : isLangFilename ? "filename" : "structural",
        rank: inServicesPath || isLangFilename ? 80 : 60,
        entityType: "language",
        entityId: "he",
        role: "xml",
        revisionKey: revKey,
        timestamp: ts,
        languageInspection: langInspection,
      };
    } else if (isLangFilename) {
      return {
        recognized: false,
        confidence: "INVALID_OR_UNRELATED",
        reason: langInspection.reason || "קובץ שפה אינו תקין",
      };
    }
  }

  // 3h. Mogobe Canned Chat Language XML (chat_1.xml / chat.xml / chat_*.xml)
  const isChatFilename =
    filename === "chat_1.xml" ||
    filename === "chat.xml" ||
    /^chat_\d+\.xml$/i.test(filename) ||
    normPath.includes("xmls/lang/chat_") ||
    normPath.includes("configs/chat_");

  if (isChatFilename || filename.endsWith(".xml")) {
    const chatInspection = inspectMogobeChatXml(bytes, filename);
    if (chatInspection.valid) {
      const ts = extractRevisionTimestamp(filename) ?? undefined;
      const revKey = ts || lowerHash.slice(0, 12);
      const langId = chatInspection.languageId;
      const isHebrew = langId === 1 || chatInspection.hasHebrew;
      const inXmlsPath = normPath.includes("xmls/lang/") || normPath.includes("configs/");

      return {
        recognized: true,
        confidence: isChatFilename ? "KNOWN_PATTERN" : "PROBABLE_MOGOBE",
        logicalId: isHebrew ? "interface:chat-language-he" : `interface:chat-language-${langId}`,
        category: "interface",
        storagePath: `Language/chat_${langId}.xml`,
        runtimeUrl: `/Xmls/lang/chat_${langId}.xml`,
        required: false,
        feature: isHebrew ? "Hebrew Chat" : `Chat Language ${langId}`,
        matchedBy: inXmlsPath ? "canonical-path" : isChatFilename ? "filename" : "structural",
        rank: inXmlsPath || isChatFilename ? 80 : 60,
        entityType: "chat-language",
        entityId: String(langId),
        role: "xml",
        revisionKey: revKey,
        timestamp: ts,
        chatInspection,
      };
    } else if (isChatFilename) {
      return {
        recognized: false,
        confidence: "INVALID_OR_UNRELATED",
        reason: chatInspection.reason || "קובץ צ'אט אינו תקין",
      };
    }
  }

  // ── Priority 4: Unambiguous weak filename fallback against declarative build rules ──
  for (const rule of build.externalRecognitionRules) {
    if (rule.filenames && rule.filenames.includes(filename)) {
      if (rule.logicalId === "interface:language-he") {
        const langInspection = inspectMogobeLanguageXml(bytes);
        if (!langInspection.valid) {
          return {
            recognized: false,
            confidence: "INVALID_OR_UNRELATED",
            reason: langInspection.reason || "קובץ שפה אינו תקין",
          };
        }
        const ts =
          extractRevisionTimestamp(filename) ??
          (langInspection.lastUpdate
            ? langInspection.lastUpdate.replace(/[^0-9]/g, "").slice(0, 14)
            : undefined);
        return {
          recognized: true,
          confidence: "KNOWN_PATTERN",
          logicalId: rule.logicalId,
          category: rule.category,
          storagePath: rule.storagePath,
          runtimeUrl: rule.runtimeUrl,
          required: rule.required,
          feature: rule.feature,
          matchedBy: "filename",
          rank: 40,
          entityType: "language",
          entityId: "he",
          role: "xml",
          revisionKey: ts || lowerHash.slice(0, 12),
          timestamp: ts,
          languageInspection: langInspection,
        };
      }
      if (rule.logicalId === "interface:chat-language-he" || rule.logicalId.startsWith("interface:chat-language-")) {
        const chatInspection = inspectMogobeChatXml(bytes, filename);
        if (!chatInspection.valid) {
          return {
            recognized: false,
            confidence: "INVALID_OR_UNRELATED",
            reason: chatInspection.reason || "קובץ צ'אט אינו תקין",
          };
        }
        const ts = extractRevisionTimestamp(filename) ?? undefined;
        return {
          recognized: true,
          confidence: "KNOWN_PATTERN",
          logicalId: rule.logicalId,
          category: rule.category,
          storagePath: rule.storagePath,
          runtimeUrl: rule.runtimeUrl,
          required: rule.required,
          feature: rule.feature,
          matchedBy: "filename",
          rank: 40,
          entityType: "chat-language",
          entityId: String(chatInspection.languageId),
          role: "xml",
          revisionKey: ts || lowerHash.slice(0, 12),
          timestamp: ts,
          chatInspection,
        };
      }
      if (!matchesStructuralKind(rule.structuralKind, bytes)) {
        return {
          recognized: false,
          confidence: "INVALID_OR_UNRELATED",
          reason: `File content does not match expected ${rule.structuralKind} format`,
        };
      }
      const roomM = /^world:room-(\d+)-(swf|txt)$/i.exec(rule.logicalId);
      const isRoom = Boolean(roomM);
      const roomId = roomM ? Number(roomM[1]) : undefined;
      const roomRole = roomM ? roomM[2].toLowerCase() : undefined;
      const ts = extractRevisionTimestamp(filename) ?? undefined;
      return {
        recognized: true,
        confidence: "KNOWN_PATTERN",
        logicalId: rule.logicalId,
        category: rule.category,
        storagePath: rule.storagePath,
        runtimeUrl: rule.runtimeUrl,
        required: rule.required,
        feature: rule.feature,
        matchedBy: "filename",
        rank: 40,
        entityType: isRoom ? "room" : undefined,
        entityId: isRoom ? roomId : undefined,
        role: isRoom ? roomRole : undefined,
        revisionKey: isRoom ? (ts || "canonical") : undefined,
        timestamp: ts,
      };
    }
  }

  // ── Priority 5: Probable Mogobe assets (valid SWF / MP3 / structured data) ──
  if (isValidSwfBuffer(bytes)) {
    return {
      recognized: false,
      confidence: "PROBABLE_MOGOBE",
      reason: "קובץ פלאש (SWF) תקין של מוגובי שנשמר לזיהוי עתידי",
      evidence: "Shockwave Flash (SWF) binary",
      detectedType: "swf",
    };
  }

  if (isValidMp3Buffer(bytes)) {
    return {
      recognized: false,
      confidence: "PROBABLE_MOGOBE",
      reason: "קובץ שמע (MP3) תקין של מוגובי שנשמר לזיהוי עתידי",
      evidence: "MPEG Audio (MP3) binary",
      detectedType: "mp3",
    };
  }

  if (
    isValidTextBuffer(bytes) &&
    (filename.endsWith(".txt") || filename.endsWith(".xml") || filename.endsWith(".json"))
  ) {
    const sample = bytes.subarray(0, 512).toString("utf8");
    if (!/^(?:<!doctype|<html|%pdf-|pk\x03\x04)/i.test(sample)) {
      return {
        recognized: false,
        confidence: "PROBABLE_MOGOBE",
        reason: "מסמך נתונים מובנה של מוגובי שנשמר לזיהוי עתידי",
        evidence: "Structured text/XML/JSON document",
        detectedType: filename.endsWith(".xml") ? "data" : filename.endsWith(".json") ? "data" : "text",
      };
    }
  }

  // ── Priority 6: Non-Mogobe / invalid / corrupt files ──
  let rejectReason = "קובץ לא מוכר שאינו משאב של מוגובי";
  if (bytes.length === 0) {
    rejectReason = "הקובץ ריק (0 בתים)";
  } else if (/^%pdf-/i.test(bytes.toString("utf8", 0, 10))) {
    rejectReason = "מסמך PDF אינו קובץ משחק של מוגובי";
  } else if (/^(?:<!doctype|<html)/i.test(bytes.toString("utf8", 0, 64))) {
    rejectReason = "עמוד HTML אינו קובץ משחק של מוגובי";
  } else if (filename.endsWith(".jpg") || filename.endsWith(".png") || filename.endsWith(".gif")) {
    rejectReason = "תמונת מפת סיביות אינה נתמכת ישירות כמשאב משחק";
  }

  return {
    recognized: false,
    confidence: "INVALID_OR_UNRELATED",
    reason: rejectReason,
  };
}
