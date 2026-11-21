import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getBuildDefinition } from "../builds/registry.ts";
import { atomicWriteFile, readOriginalAsset } from "./build-store.ts";
import { getBuildDir } from "./paths.ts";
import {
  formatRevisionTimestamp,
  getEntityRevisionsDir,
  isProvenanceSafeRoomPair,
  rankRoomRevisions,
  readRevisionsRecord,
  type AssetRevision,
} from "./revisions-store.ts";

export interface RoomPreferences {
  selectedRevisions: Record<string, string>;
}

export interface PlayableRevisionInfo {
  revisionKey: string;
  label: string;
  isComplete: boolean;
  isRecommended: boolean;
  isSelected: boolean;
  timestamp?: string;
  formattedDate?: string;
  provenance?: string;
  isCanonical?: boolean;
  swfSha256?: string;
  txtSha256?: string;
  missingFiles?: string[];
}

export interface ResolvedRoomBundle {
  roomId: number;
  revisionKey: string;
  isComplete: boolean;
  swfBytes: Buffer;
  txtBytes: Buffer | null;
  swfSha256: string;
  txtSha256: string | null;
  swfFilename: string;
  txtFilename: string | null;
  selectionMode: "selected" | "recommended" | "fallback";
  isFallbackPair?: boolean;
}

function getRoomPreferencesPath(buildId: string, dataDir?: string): string {
  const dir = getBuildDir(buildId, dataDir);
  return join(dir, "room-preferences.json");
}

export function getRoomPreferences(buildId: string, dataDir?: string): Record<string, string> {
  const file = getRoomPreferencesPath(buildId, dataDir);
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.selectedRevisions === "object" && parsed.selectedRevisions !== null) {
      return parsed.selectedRevisions;
    }
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function getSelectedRoomRevision(
  buildId: string,
  roomId: number,
  dataDir?: string,
): string | null {
  const prefs = getRoomPreferences(buildId, dataDir);
  const val = prefs[String(roomId)];
  return typeof val === "string" && val.trim() !== "" && val !== "auto" ? val : null;
}

export function setRoomRevisionSelection(
  buildId: string,
  roomId: number,
  revisionKey: string | null,
  dataDir?: string,
): void {
  const file = getRoomPreferencesPath(buildId, dataDir);
  const dir = getBuildDir(buildId, dataDir);
  mkdirSync(dir, { recursive: true });

  const prefs = getRoomPreferences(buildId, dataDir);
  if (revisionKey === null || revisionKey === "" || revisionKey === "auto") {
    delete prefs[String(roomId)];
  } else {
    prefs[String(roomId)] = revisionKey;
  }

  const payload: RoomPreferences = { selectedRevisions: prefs };
  atomicWriteFile(file, JSON.stringify(payload, null, 2) + "\n");
}

export function deriveRevisionLabel(rev: AssetRevision): string {
  if (rev.formattedDate) {
    return `ארכיון ${rev.formattedDate}`;
  }
  if (rev.timestamp) {
    return `ארכיון ${formatRevisionTimestamp(rev.timestamp)}`;
  }
  if (rev.isCanonical) {
    return "גרסה מקורית";
  }
  if (rev.provenance) {
    const clean = rev.provenance.replace(/[/\\]?Rooms[/\\]?$/i, "").replace(/^[/\\]+/, "");
    if (clean) return `תיקייה: ${clean}`;
  }
  return `גרסה ${rev.revisionKey}`;
}

export function getRoomPlayableRevisions(
  buildId: string,
  roomId: number,
  dataDir?: string,
): PlayableRevisionInfo[] {
  const build = getBuildDefinition(buildId);
  const requiresTxt = build?.roomRequiresTxt ?? true;
  const rec = readRevisionsRecord(buildId, "world", "Rooms", roomId, dataDir);
  const selectedKey = getSelectedRoomRevision(buildId, roomId, dataDir);

  if (!rec || Object.keys(rec.revisions).length === 0) {
    // Check flat fallback
    const swf = readOriginalAsset(buildId, "world", `Rooms/room_${roomId}.swf`, dataDir);
    const txt = readOriginalAsset(buildId, "world", `Rooms/room_${roomId}.txt`, dataDir);
    if (!swf) return [];
    const isComplete = Boolean(swf && (!requiresTxt || txt));
    return [
      {
        revisionKey: "canonical",
        label: "גרסה מקורית",
        isComplete,
        isRecommended: true,
        isSelected: selectedKey === "canonical",
        isCanonical: true,
        missingFiles: requiresTxt && !txt ? [`room_${roomId}.txt`] : undefined,
      },
    ];
  }

  const revisionsList = Object.values(rec.revisions);
  const ranked = rankRoomRevisions(revisionsList, requiresTxt);
  const recommendedKey = ranked.find((r) => {
    const isPairSafe = r.files.swf && r.files.txt
      ? isProvenanceSafeRoomPair(r.files.swf.filename, r.files.txt.filename, r.timestamp)
      : !requiresTxt;
    return r.compatibility === "compatible" && Boolean(r.files.swf && (!requiresTxt || r.files.txt)) && isPairSafe;
  })?.revisionKey ?? ranked[0]?.revisionKey ?? null;

  return ranked.map((rev) => {
    const hasSwf = Boolean(rev.files.swf);
    const hasTxt = Boolean(rev.files.txt);
    const isPairSafe = hasSwf && hasTxt
      ? isProvenanceSafeRoomPair(rev.files.swf?.filename, rev.files.txt?.filename, rev.timestamp)
      : !requiresTxt;
    const isComplete = Boolean(hasSwf && (!requiresTxt || hasTxt)) && isPairSafe;
    const missing: string[] = [];
    if (!hasSwf) missing.push(`room_${roomId}.swf`);
    if (requiresTxt && !hasTxt) missing.push(`room_${roomId}.txt`);
    if (hasSwf && hasTxt && !isPairSafe) missing.push(`provenance-mismatch`);

    return {
      revisionKey: rev.revisionKey,
      label: deriveRevisionLabel(rev),
      isComplete,
      isRecommended: rev.revisionKey === recommendedKey,
      isSelected: rev.revisionKey === selectedKey,
      timestamp: rev.timestamp,
      formattedDate: rev.formattedDate,
      provenance: rev.provenance,
      isCanonical: rev.isCanonical,
      swfSha256: rev.files.swf?.sha256,
      txtSha256: rev.files.txt?.sha256,
      missingFiles: missing.length > 0 ? missing : undefined,
    };
  });
}

/**
 * Dynamic Runtime Resolver:
 * Resolves which preserved revision of a room to serve to the Mogobe client.
 *
 * Precedence:
 * 1. User-selected revision (if set and complete).
 * 2. Recommended revision (top-ranked complete compatible revision).
 * 3. Fallback to any valid complete revision.
 * 4. Fallback to legacy flat file bundle if complete.
 * 5. Returns null if no complete revision exists (never serves incomplete revision).
 */
export function resolveRoomRevision(
  buildId: string,
  roomId: number,
  dataDir?: string,
): ResolvedRoomBundle | null {
  const build = getBuildDefinition(buildId);
  const requiresTxt = build?.roomRequiresTxt ?? true;
  const rec = readRevisionsRecord(buildId, "world", "Rooms", roomId, dataDir);
  const selectedKey = getSelectedRoomRevision(buildId, roomId, dataDir);

  const entityDir = getEntityRevisionsDir(buildId, "world", "Rooms", roomId, dataDir);

  // Helper to construct bundle from an AssetRevision
  function makeBundleFromRevision(
    rev: AssetRevision,
    mode: "selected" | "recommended" | "fallback",
    allowProvenanceMismatch = false,
  ): ResolvedRoomBundle | null {
    if (!rev.files.swf) return null;
    if (requiresTxt && !rev.files.txt) return null;
    const isPairSafe = rev.files.swf && rev.files.txt
      ? isProvenanceSafeRoomPair(rev.files.swf.filename, rev.files.txt.filename, rev.timestamp)
      : !requiresTxt;
    if (!allowProvenanceMismatch && !isPairSafe) {
      return null;
    }

    const revDir = join(entityDir, "revisions", rev.revisionKey);
    const swfPath = join(revDir, rev.files.swf.filename);
    if (!existsSync(swfPath)) return null;
    const swfBytes = readFileSync(swfPath);

    let txtBytes: Buffer | null = null;
    if (rev.files.txt) {
      const txtPath = join(revDir, rev.files.txt.filename);
      if (existsSync(txtPath)) {
        txtBytes = readFileSync(txtPath);
      } else if (requiresTxt) {
        return null;
      }
    }

    return {
      roomId,
      revisionKey: rev.revisionKey,
      isComplete: true,
      swfBytes,
      txtBytes,
      swfSha256: rev.files.swf.sha256,
      txtSha256: rev.files.txt?.sha256 ?? null,
      swfFilename: rev.files.swf.filename,
      txtFilename: rev.files.txt?.filename ?? null,
      selectionMode: mode,
      isFallbackPair: !isPairSafe,
    };
  }

  if (rec && Object.keys(rec.revisions).length > 0) {
    const revisionsList = Object.values(rec.revisions);

    // 1. User-selected revision
    if (selectedKey && rec.revisions[selectedKey]) {
      const userBundle = makeBundleFromRevision(rec.revisions[selectedKey], "selected", false);
      if (userBundle) return userBundle;
    }

    // 2. Recommended complete compatible revision
    const ranked = rankRoomRevisions(revisionsList, requiresTxt);
    const recommended = ranked.find((r) => {
      const isPairSafe = r.files.swf && r.files.txt
        ? isProvenanceSafeRoomPair(r.files.swf.filename, r.files.txt.filename, r.timestamp)
        : !requiresTxt;
      return r.compatibility === "compatible" && Boolean(r.files.swf && (!requiresTxt || r.files.txt)) && isPairSafe;
    });
    if (recommended) {
      const bundle = makeBundleFromRevision(recommended, "recommended", false);
      if (bundle) return bundle;
    }

    // 3. Fallback to any complete revision
    const anyComplete = ranked.find((r) => {
      const isPairSafe = r.files.swf && r.files.txt
        ? isProvenanceSafeRoomPair(r.files.swf.filename, r.files.txt.filename, r.timestamp)
        : !requiresTxt;
      return Boolean(r.files.swf && (!requiresTxt || r.files.txt)) && isPairSafe;
    });
    if (anyComplete) {
      const bundle = makeBundleFromRevision(anyComplete, "fallback", false);
      if (bundle) return bundle;
    }
  }

  // 4. Legacy flat file bundle fallback
  const flatSwf = readOriginalAsset(buildId, "world", `Rooms/room_${roomId}.swf`, dataDir);
  const flatTxt = readOriginalAsset(buildId, "world", `Rooms/room_${roomId}.txt`, dataDir);
  if (flatSwf && (!requiresTxt || flatTxt)) {
    return {
      roomId,
      revisionKey: "canonical",
      isComplete: true,
      swfBytes: flatSwf,
      txtBytes: flatTxt,
      swfSha256: "",
      txtSha256: flatTxt ? "" : null,
      swfFilename: `room_${roomId}.swf`,
      txtFilename: flatTxt ? `room_${roomId}.txt` : null,
      selectionMode: "fallback",
    };
  }

  // 5. Cross-Revision / Best-Effort Fallback:
  // If no single matched revision exists, but we have valid SWF and TXT files (even across different
  // revisions, separate folders, or with archival timestamp provenance differences), synthesize a
  // working bundle so the user is never blocked from entering the world.
  if (rec && Object.keys(rec.revisions).length > 0) {
    const revisionsList = Object.values(rec.revisions);
    const ranked = rankRoomRevisions(revisionsList, requiresTxt);

    // 5a. Check if any single revision has both SWF and TXT physically on disk (relax provenance safety)
    const singleMismatched = ranked.find((r) => {
      if (!r.files.swf || (requiresTxt && !r.files.txt)) return false;
      const revDir = join(entityDir, "revisions", r.revisionKey);
      const swfOnDisk = existsSync(join(revDir, r.files.swf.filename));
      const txtOnDisk = !requiresTxt || (r.files.txt && existsSync(join(revDir, r.files.txt.filename)));
      return swfOnDisk && txtOnDisk;
    });
    if (singleMismatched) {
      const bundle = makeBundleFromRevision(singleMismatched, "fallback", true);
      if (bundle) return bundle;
    }

    // 5b. Find best available SWF and best available TXT across all revisions or flat files
    let bestSwf: { bytes: Buffer; filename: string; sha256: string; revKey: string } | null = null;
    let bestTxt: { bytes: Buffer; filename: string; sha256: string; revKey: string } | null = null;

    // Check user-selected revision first for SWF/TXT
    if (selectedKey && rec.revisions[selectedKey]) {
      const selRev = rec.revisions[selectedKey];
      const revDir = join(entityDir, "revisions", selRev.revisionKey);
      if (selRev.files.swf) {
        const p = join(revDir, selRev.files.swf.filename);
        if (existsSync(p)) {
          bestSwf = { bytes: readFileSync(p), filename: selRev.files.swf.filename, sha256: selRev.files.swf.sha256, revKey: selRev.revisionKey };
        }
      }
      if (selRev.files.txt) {
        const p = join(revDir, selRev.files.txt.filename);
        if (existsSync(p)) {
          bestTxt = { bytes: readFileSync(p), filename: selRev.files.txt.filename, sha256: selRev.files.txt.sha256, revKey: selRev.revisionKey };
        }
      }
    }

    // If not found in selected, search ranked revisions
    if (!bestSwf) {
      for (const rev of ranked) {
        if (rev.files.swf) {
          const p = join(entityDir, "revisions", rev.revisionKey, rev.files.swf.filename);
          if (existsSync(p)) {
            bestSwf = { bytes: readFileSync(p), filename: rev.files.swf.filename, sha256: rev.files.swf.sha256, revKey: rev.revisionKey };
            break;
          }
        }
      }
    }
    if (!bestTxt && requiresTxt) {
      for (const rev of ranked) {
        if (rev.files.txt) {
          const p = join(entityDir, "revisions", rev.revisionKey, rev.files.txt.filename);
          if (existsSync(p)) {
            bestTxt = { bytes: readFileSync(p), filename: rev.files.txt.filename, sha256: rev.files.txt.sha256, revKey: rev.revisionKey };
            break;
          }
        }
      }
    }

    // Check flat files as fallback for either piece
    if (!bestSwf && flatSwf) {
      bestSwf = { bytes: flatSwf, filename: `room_${roomId}.swf`, sha256: "", revKey: "canonical" };
    }
    if (!bestTxt && requiresTxt && flatTxt) {
      bestTxt = { bytes: flatTxt, filename: `room_${roomId}.txt`, sha256: "", revKey: "canonical" };
    }

    if (bestSwf && (!requiresTxt || bestTxt)) {
      return {
        roomId,
        revisionKey: bestTxt && bestSwf.revKey !== bestTxt.revKey
          ? `${bestSwf.revKey}+${bestTxt.revKey}`
          : bestSwf.revKey,
        isComplete: true,
        swfBytes: bestSwf.bytes,
        txtBytes: bestTxt ? bestTxt.bytes : null,
        swfSha256: bestSwf.sha256,
        txtSha256: bestTxt ? bestTxt.sha256 : null,
        swfFilename: bestSwf.filename,
        txtFilename: bestTxt ? bestTxt.filename : null,
        selectionMode: "fallback",
        isFallbackPair: true,
      };
    }
  }

  return null;
}
