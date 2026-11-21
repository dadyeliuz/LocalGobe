import type { ExternalImportSummary } from "../importer/types.ts";
import type { InstalledBuildManifest, RoomRecord } from "../storage/manifest-generator.ts";
import { addedPhrase, discoveryPhrase, type NounKey } from "./i18n/he.ts";
import { countsOf, type ContentContext, type ContentCounts } from "./model.ts";

/**
 * Pure state machine for one import batch (a drop, a folder pick, or a file pick).
 *
 * The importer is called once per file and returns the updated build manifest each
 * time, so the session measures *user-meaningful* growth (rooms, items, games…) by
 * diffing manifest counts rather than counting raw files.
 */

export type ImportPhase = "collecting" | "importing" | "done";

export type DiscoveryEvent = {
  key: NounKey;
  /** How many of this kind were discovered by the triggering step. */
  amount: number;
  /** Headline shown in the progress view. */
  text: string;
  /** Monotonic sequence number so the view can replay a subtle pop. */
  seq: number;
};

export type IncompleteRoomInfo = {
  roomId: number;
  hasSwf: boolean;
  hasTxt: boolean;
  isBootstrap: boolean;
};

export type ImportSession = {
  phase: ImportPhase;
  context: ContentContext;
  bootstrapRoomId: number;
  total: number;
  processed: number;
  baseline: ContentCounts;
  current: ContentCounts;
  playReadyBefore: boolean;
  playReadyAfter: boolean;
  filesAdded: number;
  filesUpdated: number;
  duplicates: number;
  conflicts: number;
  unclassified: number;
  unknown: number;
  failed: number;
  unknownFiles: string[];
  touchedRoomIds: number[];
  latestRooms: RoomRecord[];
  lastEvent: DiscoveryEvent | null;
  languageAdded?: boolean;
  chatLanguageAdded?: boolean;
  stopped: boolean;
};

/** Order matters: the most exciting kind wins the headline when one step adds several. */
const HEADLINE_ORDER: ReadonlyArray<{ count: keyof ContentCounts; key: NounKey }> = [
  { count: "rooms", key: "room" },
  { count: "games", key: "game" },
  { count: "items", key: "item" },
  { count: "music", key: "music" },
  { count: "interfaceFiles", key: "interfaceFile" },
];

export function createImportSession(
  context: ContentContext,
  baseline: InstalledBuildManifest | null | undefined,
  total = 0,
): ImportSession {
  const counts = countsOf(baseline);
  return {
    phase: total > 0 ? "importing" : "collecting",
    context,
    bootstrapRoomId: baseline?.categories.world.bootstrapRoomId ?? 20,
    total,
    processed: 0,
    baseline: counts,
    current: { ...counts },
    playReadyBefore: Boolean(baseline?.playReady),
    playReadyAfter: Boolean(baseline?.playReady),
    filesAdded: 0,
    filesUpdated: 0,
    duplicates: 0,
    conflicts: 0,
    unclassified: 0,
    unknown: 0,
    failed: 0,
    unknownFiles: [],
    touchedRoomIds: [],
    latestRooms: baseline?.categories.world.rooms ?? [],
    lastEvent: null,
    stopped: false,
  };
}

export function beginImporting(session: ImportSession, total: number): ImportSession {
  return { ...session, phase: "importing", total };
}

/** Growth since the batch started (never negative). */
export function sessionDeltas(session: ImportSession): ContentCounts {
  const d = (k: keyof ContentCounts) => Math.max(0, session.current[k] - session.baseline[k]);
  return {
    rooms: d("rooms"),
    roomRevisions: d("roomRevisions"),
    music: d("music"),
    items: d("items"),
    games: d("games"),
    interfaceFiles: d("interfaceFiles"),
  };
}

function extractTouchedRoomIds(summary: ExternalImportSummary): number[] {
  const ids: number[] = [];
  for (const item of summary.items) {
    if ((item.status === "added" || item.status === "updated") && item.logicalId) {
      const m = /^world:room-(\d+)-(?:swf|txt)$/i.exec(item.logicalId);
      if (m) ids.push(Number(m[1]));
    }
  }
  return ids;
}

export function applyFileResult(session: ImportSession, summary: ExternalImportSummary): ImportSession {
  const next = countsOf(summary.manifest);
  let lastEvent = session.lastEvent;
  for (const { count, key } of HEADLINE_ORDER) {
    const stepGain = next[count] - session.current[count];
    if (stepGain > 0) {
      // Rooms and games are announced one-by-one; items and music are announced as a
      // running total for this batch, which reads better for big collections.
      const runningTotal = Math.max(0, next[count] - session.baseline[count]);
      const amount = key === "room" || key === "game" ? stepGain : runningTotal;
      lastEvent = {
        key,
        amount,
        text: discoveryPhrase(key, amount),
        seq: (session.lastEvent?.seq ?? 0) + 1,
      };
      break;
    }
  }

  const newlyTouched = extractTouchedRoomIds(summary);
  const touchedRoomIds =
    newlyTouched.length > 0
      ? Array.from(new Set([...session.touchedRoomIds, ...newlyTouched]))
      : session.touchedRoomIds;

  return {
    ...session,
    processed: session.processed + 1,
    current: next,
    playReadyAfter: summary.manifest.playReady,
    filesAdded: session.filesAdded + summary.addedCount,
    filesUpdated: session.filesUpdated + summary.updatedCount,
    duplicates: session.duplicates + summary.duplicateCount,
    conflicts: session.conflicts + summary.conflictCount,
    unclassified: session.unclassified + (summary.unclassifiedCount ?? 0),
    unknown: session.unknown + summary.unknownCount + summary.rejectedCount,
    unknownFiles:
      summary.unknownFiles.length > 0 ? [...session.unknownFiles, ...summary.unknownFiles] : session.unknownFiles,
    touchedRoomIds,
    latestRooms: summary.manifest.categories.world.rooms,
    lastEvent,
    languageAdded:
      session.languageAdded ||
      summary.items.some(
        (it) => it.logicalId === "interface:language-he" && (it.status === "added" || it.status === "updated"),
      ),
    chatLanguageAdded:
      session.chatLanguageAdded ||
      summary.items.some(
        (it) =>
          it.logicalId?.startsWith("interface:chat-language") &&
          (it.status === "added" || it.status === "updated"),
      ),
  };
}

export function applyFileFailure(session: ImportSession, relativePath: string): ImportSession {
  return {
    ...session,
    processed: session.processed + 1,
    failed: session.failed + 1,
    unknownFiles: [...session.unknownFiles, relativePath],
  };
}

export function finishSession(session: ImportSession, stopped = false): ImportSession {
  return { ...session, phase: "done", stopped };
}

/** 0..1 progress fraction. */
export function sessionProgress(session: ImportSession): number {
  if (session.total <= 0) return 0;
  return Math.min(1, session.processed / session.total);
}

export type OutcomeStat = {
  key: NounKey;
  countKey: keyof ContentCounts;
  amount: number;
  phrase: string;
};

export type ImportOutcome = {
  kind: "added" | "incomplete" | "nothing-new" | "conflict" | "unclassified" | "unrecognized";
  stats: OutcomeStat[];
  incompleteRooms: IncompleteRoomInfo[];
  /** The world became playable during this batch. */
  becameReady: boolean;
  /** Something outside the chosen context was also recognized. */
  foundOutsideContext: boolean;
  unclassified: number;
  skipped: number;
  failed: number;
  conflicts: number;
};

const CONTEXT_COUNT_KEYS: Record<ContentContext, ReadonlyArray<keyof ContentCounts>> = {
  all: ["rooms", "music", "items", "games", "interfaceFiles"],
  world: ["rooms", "music"],
  items: ["items"],
  miniGames: ["games"],
  interface: ["interfaceFiles"],
};

export function summarizeOutcome(session: ImportSession): ImportOutcome {
  const deltas = sessionDeltas(session);
  const stats: OutcomeStat[] = [];
  const order: ReadonlyArray<{ countKey: keyof ContentCounts; key: NounKey }> = [
    { countKey: "rooms", key: "room" },
    { countKey: "items", key: "item" },
    { countKey: "games", key: "game" },
    { countKey: "music", key: "music" },
    { countKey: "interfaceFiles", key: "interfaceFile" },
  ];
  const touchedRevs = session.touchedRoomIds.reduce((sum, id) => {
    const r = session.latestRooms.find((x) => x.roomId === id);
    return sum + (r?.revisionsCount ?? 1);
  }, 0);

  for (const { countKey, key } of order) {
    if (deltas[countKey] > 0) {
      if (key === "room" && touchedRevs > deltas.rooms) {
        stats.push({
          key,
          countKey,
          amount: deltas[countKey],
          phrase: `${addedPhrase("room", deltas.rooms)} (${touchedRevs} גרסאות נשמרו)`,
        });
      } else {
        stats.push({ key, countKey, amount: deltas[countKey], phrase: addedPhrase(key, deltas[countKey]) });
      }
    }
  }

  const roomStatIdx = stats.findIndex((s) => s.key === "room");
  if (roomStatIdx < 0 && session.touchedRoomIds.length > 0 && session.filesAdded > 0) {
    const touchedComplete = session.touchedRoomIds.filter((id) =>
      session.latestRooms.some((r) => r.roomId === id && r.ready),
    );
    if (touchedComplete.length > 0 && touchedRevs > touchedComplete.length) {
      stats.unshift({
        key: "room",
        countKey: "rooms",
        amount: touchedRevs,
        phrase: `נוספו גרסאות חלופיות לחדרים (${touchedRevs} גרסאות נשמרו)`,
      });
    }
  }

  if (session.languageAdded) {
    const ifaceIdx = stats.findIndex((s) => s.key === "interfaceFile");
    if (ifaceIdx >= 0 && stats[ifaceIdx].amount === 1) {
      stats.splice(ifaceIdx, 1);
    }
    stats.push({ key: "language", countKey: "interfaceFiles", amount: 1, phrase: "נוסף קובץ השפה העברי" });
  }

  if (session.chatLanguageAdded) {
    const ifaceIdx = stats.findIndex((s) => s.key === "interfaceFile");
    if (ifaceIdx >= 0 && stats[ifaceIdx].amount === 1) {
      stats.splice(ifaceIdx, 1);
    }
    stats.push({ key: "chatLanguage", countKey: "interfaceFiles", amount: 1, phrase: "נוסף קובץ משפטי הצ'אט בעברית" });
  }

  const incompleteRooms: IncompleteRoomInfo[] = session.touchedRoomIds
    .map((id) => session.latestRooms.find((r) => r.roomId === id))
    .filter((r): r is RoomRecord => Boolean(r && !r.ready))
    .map((r) => ({
      roomId: r.roomId,
      hasSwf: r.hasSwf,
      hasTxt: r.hasTxt,
      isBootstrap: r.roomId === session.bootstrapRoomId,
    }));

  const becameReady = !session.playReadyBefore && session.playReadyAfter;
  const inContext = CONTEXT_COUNT_KEYS[session.context];
  const foundOutsideContext =
    session.context !== "all" && stats.some((s) => !inContext.includes(s.countKey));

  // If valid non-room recognized files were accepted without changing a visible count,
  // surface that as a generic "files added" line.
  if (stats.length === 0 && incompleteRooms.length === 0 && session.filesAdded + session.filesUpdated > 0) {
    const n = session.filesAdded + session.filesUpdated;
    stats.push({ key: "file", countKey: "interfaceFiles", amount: n, phrase: addedPhrase("file", n) });
  }

  let kind: ImportOutcome["kind"];
  if (stats.length > 0 || becameReady) kind = "added";
  else if (incompleteRooms.length > 0) kind = "incomplete";
  else if (session.unclassified > 0) kind = "unclassified";
  else if (session.duplicates > 0) kind = "nothing-new";
  else if (session.conflicts > 0) kind = "conflict";
  else kind = "unrecognized";

  return {
    kind,
    stats,
    incompleteRooms,
    becameReady,
    foundOutsideContext,
    unclassified: session.unclassified,
    skipped: session.unknown,
    failed: session.failed,
    conflicts: session.conflicts,
  };
}
