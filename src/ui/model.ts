import type { InstalledBuildManifest } from "../storage/manifest-generator.ts";
import { he } from "./i18n/he.ts";

/**
 * UX-level content contexts. These are *entry points*, not technical restrictions:
 * every context feeds the same automatic importer.
 */
export type ContentContext = "all" | "interface" | "world" | "items" | "miniGames";

export const CONTENT_CONTEXTS: readonly ContentContext[] = ["all", "world", "items", "miniGames", "interface"];

export type ContextCopy = {
  /** Tile / sheet title. */
  title: string;
  /** Large drop-zone heading. */
  dropTitle: string;
  /** Helper sentence under the drop zone heading. */
  dropSub: string;
  /** Text shown in the global drop overlay when this context is open. */
  overlayTitle: string;
  /** Accent token used by CSS (`data-tone`). */
  tone: "sky" | "coral" | "pink" | "grape" | "teal";
};

export const CONTEXT_COPY: Record<ContentContext, ContextCopy> = {
  all: {
    title: he.allContent,
    dropTitle: "גרור לכאן קבצי מוגובי",
    dropSub: "קבצים או תיקייה שלמה — נזהה ונסדר הכול לבד.",
    overlayTitle: he.dropTitleFiles,
    tone: "sky",
  },
  world: {
    title: "חדרים ומוזיקה",
    dropTitle: "גרור לכאן חדרים ומוזיקת חדרים",
    dropSub: "כל חדר חדש מגדיל את העולם שלך.",
    overlayTitle: "שחרר כדי להוסיף חדרים ומוזיקה",
    tone: "coral",
  },
  items: {
    title: "פריטים",
    dropTitle: "גרור לכאן קבצי פריטים",
    dropSub: "בגדים, רהיטים, מתנות ועוד — הכול נכנס לאוסף שלך.",
    overlayTitle: "שחרר כדי להוסיף פריטים",
    tone: "pink",
  },
  miniGames: {
    title: "מיני־משחקים",
    dropTitle: "גרור לכאן קבצי מיני־משחקים",
    dropSub: "כל משחק שנמצא יחכה לך בתוך העולם.",
    overlayTitle: "שחרר כדי להוסיף מיני־משחקים",
    tone: "grape",
  },
  interface: {
    title: "ממשק ותוספות",
    dropTitle: "גרור לכאן קבצי ממשק ותוספות",
    dropSub: "קובצי שפה (כגון lang.aspx), מסכים, אפקטים והגדרות המשחק.",
    overlayTitle: "שחרר כדי להוסיף ממשק ותוספות",
    tone: "teal",
  },
};

export type HomeStage =
  /** No build installed yet. */
  | "needs-apk"
  /** APK installed but the game files themselves are incomplete. */
  | "needs-game"
  /** Game is fine; the minimum world content is still missing. */
  | "needs-world"
  /** Some other required original file is missing (e.g. interface). */
  | "needs-files"
  /** Everything needed to enter the world is present. */
  | "ready";

export type ContentCounts = {
  rooms: number;
  roomRevisions: number;
  music: number;
  items: number;
  games: number;
  interfaceFiles: number;
};

export type BootstrapRoomState = {
  roomId: number;
  hasSwf: boolean;
  hasTxt: boolean;
  ready: boolean;
  isFallbackPair?: boolean;
};

export type LanguageState = {
  present: boolean;
  active?: boolean;
  compatible: boolean;
  reason?: string;
  warning?: string;
  originalFilename?: string;
  sectionsCount?: number;
};

export type HomeModel = {
  stage: HomeStage;
  buildId: string | null;
  buildName: string;
  playReady: boolean;
  counts: ContentCounts;
  interfaceReady: boolean;
  bootstrapRoom: BootstrapRoomState;
  language: LanguageState;
  /** Short status line under the title. */
  statusLine: string;
  /** World status phrase. */
  worldLine: string;
  /** Main heading. */
  title: string;
};

export const EMPTY_COUNTS: ContentCounts = { rooms: 0, roomRevisions: 0, music: 0, items: 0, games: 0, interfaceFiles: 0 };

export function countsOf(manifest: InstalledBuildManifest | null | undefined): ContentCounts {
  if (!manifest) return { ...EMPTY_COUNTS };
  const c = manifest.categories;
  return {
    rooms: c.world.roomCount,
    roomRevisions: c.world.roomRevisionsCount ?? c.world.roomCount,
    music: c.world.musicCount,
    items: c.items.count,
    games: c.miniGames.availableCount,
    interfaceFiles: c.interface.presentCount,
  };
}

export function stageOf(manifest: InstalledBuildManifest | null | undefined): HomeStage {
  if (!manifest) return "needs-apk";
  if (manifest.playReady) return "ready";
  const c = manifest.categories;
  if (!c.game.ready) return "needs-game";
  if (!c.world.ready) return "needs-world";
  return "needs-files";
}

export function deriveHomeModel(manifest: InstalledBuildManifest | null | undefined): HomeModel {
  const stage = stageOf(manifest);
  const counts = countsOf(manifest);
  const bootstrapRoomId = manifest?.categories.world.bootstrapRoomId ?? 20;
  const bootstrapRec = manifest?.categories.world.rooms.find((r) => r.roomId === bootstrapRoomId);
  const bootstrapRoom: BootstrapRoomState = {
    roomId: bootstrapRoomId,
    hasSwf: Boolean(bootstrapRec?.hasSwf),
    hasTxt: Boolean(bootstrapRec?.hasTxt),
    ready: Boolean(bootstrapRec?.ready),
    isFallbackPair: Boolean(bootstrapRec?.isFallbackPair),
  };
  const langRec = manifest?.categories.interface.language;
  const language: LanguageState = {
    present: Boolean(langRec?.present),
    active: Boolean(langRec?.active ?? langRec?.compatible),
    compatible: Boolean(langRec?.compatible),
    reason: langRec?.reason,
    warning: langRec?.warning,
    originalFilename: langRec?.originalFilename,
    sectionsCount: langRec?.sectionsCount ?? 0,
  };
  const base = {
    stage,
    buildId: manifest?.buildId ?? null,
    buildName: manifest?.displayName ?? "",
    playReady: stage === "ready",
    counts,
    interfaceReady: manifest?.categories.interface.ready ?? false,
    bootstrapRoom,
    language,
  };
  switch (stage) {
    case "ready":
      return { ...base, title: he.worldReady, statusLine: he.readyToPlay, worldLine: he.worldReady };
    case "needs-world":
      return { ...base, title: he.almostThere, statusLine: he.needsWorldStatus, worldLine: he.needsWorldShort };
    case "needs-files":
      return { ...base, title: he.almostThere, statusLine: he.needsFilesStatus, worldLine: he.worldReady };
    case "needs-game":
      return { ...base, title: he.needsGameTitle, statusLine: he.needsGameLead, worldLine: he.needsWorldShort };
    case "needs-apk":
    default:
      return { ...base, title: he.firstRunTitle, statusLine: he.firstRunLead, worldLine: he.needsWorldShort };
  }
}

/** Which installed build the UI should focus on. */
export function pickActiveBuild(
  installed: InstalledBuildManifest[],
  preferredId: string | null | undefined,
): InstalledBuildManifest | null {
  if (installed.length === 0) return null;
  return installed.find((b) => b.buildId === preferredId) ?? installed[0];
}

/** Decide how a dropped/picked batch should be routed. */
export type DropRoute =
  | { kind: "apk"; index: number }
  | { kind: "files"; indices: number[] }
  | { kind: "need-apk" }
  | { kind: "empty" };

export function routeDroppedFiles(names: string[], hasInstalledBuild: boolean): DropRoute {
  if (names.length === 0) return { kind: "empty" };
  const isApk = (n: string) => n.toLowerCase().endsWith(".apk");
  const apkIndex = names.findIndex(isApk);
  if (!hasInstalledBuild) {
    return apkIndex >= 0 ? { kind: "apk", index: apkIndex } : { kind: "need-apk" };
  }
  if (names.length === 1 && apkIndex === 0) return { kind: "apk", index: 0 };
  const indices = names.map((n, i) => (isApk(n) ? -1 : i)).filter((i) => i >= 0);
  if (indices.length === 0) return { kind: "apk", index: apkIndex };
  return { kind: "files", indices };
}

export type MissingAssetCategory =
  | "popup"
  | "room"
  | "item"
  | "sound"
  | "interface"
  | "game"
  | "xml"
  | "service"
  | "other";

export type MissingAssetEntry = {
  id: string;
  url: string;
  path: string;
  filename: string;
  category: MissingAssetCategory;
  categoryLabel: string;
  timestamp: number;
  timeFormatted: string;
  count: number;
};

/** Categorize a requested asset path for UI display and filtering. */
export function classifyMissingAsset(pathname: string): {
  category: MissingAssetCategory;
  categoryLabel: string;
  filename: string;
} {
  const cleanPath = pathname.split("?")[0].replace(/\\/g, "/");
  const filename = cleanPath.split("/").pop() || cleanPath;
  const lower = cleanPath.toLowerCase();

  let category: MissingAssetCategory = "other";
  let categoryLabel = "קובץ";

  if (
    lower.includes("/popups/") ||
    lower.startsWith("p_") ||
    lower.startsWith("popup_") ||
    /^p_\d+\.swf$/i.test(filename) ||
    /^popup_\d+\.swf$/i.test(filename)
  ) {
    category = "popup";
    categoryLabel = "חלון קופץ (Popup)";
  } else if (lower.includes("/rooms/") || /^room_\d+/i.test(filename)) {
    category = "room";
    categoryLabel = "חדר (Room)";
  } else if (
    lower.includes("/items/") ||
    lower.includes("/inventory/") ||
    lower.includes("/assets/items/")
  ) {
    category = "item";
    categoryLabel = "פריט (Item)";
  } else if (
    lower.includes("/sound/") ||
    lower.includes("/sounds/") ||
    lower.includes("/audio/") ||
    lower.endsWith(".mp3") ||
    lower.endsWith(".wav")
  ) {
    category = "sound";
    categoryLabel = "סאונד / מוזיקה";
  } else if (lower.includes("/games/") || lower.includes("/minigames/")) {
    category = "game";
    categoryLabel = "מיני־משחק";
  } else if (
    lower.includes("/xmls/") ||
    lower.endsWith(".xml") ||
    lower.includes("/servises/") ||
    lower.includes("/services/") ||
    lower.endsWith(".aspx") ||
    lower.endsWith(".php")
  ) {
    category = "interface";
    categoryLabel = "ממשק והגדרות";
  }

  return { category, categoryLabel, filename };
}

