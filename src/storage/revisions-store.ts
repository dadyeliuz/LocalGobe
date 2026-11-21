import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type { ContentCategory } from "../builds/types.ts";
import { atomicWriteFile } from "./build-store.ts";
import { getCategoryDir } from "./paths.ts";

export interface AssetRevisionFile {
  role: string;
  filename: string;
  originalFilename: string;
  originalRelativePath: string;
  sha256: string;
  size: number;
}

export type RevisionCompatibility =
  | "compatible"
  | "partially-compatible"
  | "incompatible"
  | "unknown";

export interface AssetRevision {
  revisionKey: string;
  logicalId: string;
  category: ContentCategory;
  files: Record<string, AssetRevisionFile>;
  timestamp?: string;
  formattedDate?: string;
  provenance?: string;
  compatibility: RevisionCompatibility;
  compatibilityReason?: string;
  recognized?: boolean;
  structurallyCompatible?: boolean;
  buildPreference?: number;
  roomButtonsCount?: number;
  roomButtons?: string[];
  importedAt: string;
  isCanonical?: boolean;
  languageId?: number;
  lastUpdate?: string;
  totalSections?: number;
  sections?: string[];
  missingRequiredSections?: string[];
}

export interface LogicalAssetRevisionsRecord {
  logicalId: string;
  category: ContentCategory;
  entityId: string | number;
  activeRevisionKey: string | null;
  activeReason: string | null;
  revisions: Record<string, AssetRevision>;
}

/**
 * Extracts a 8 to 14-digit timestamp from historical filenames,
 * e.g. room_110_20150809221546_80976ff5.swf -> "20150809221546"
 */
export function extractRevisionTimestamp(filename: string): string | null {
  const m = /(?:_|^)(\d{8}(?:\d{6})?)(?:_|\.|$)/i.exec(filename);
  return m ? m[1] : null;
}

/**
 * Validates whether an SWF and TXT file constitute a provenance-safe room revision pair.
 *
 * Rules:
 * 1. Both files must be provided.
 * 2. If both filenames contain extractable archival timestamps, they must match:
 *    - If both have >= 14 digits, all 14 digits must match.
 *    - Otherwise, at least the 8-digit date prefix (YYYYMMDD) must match.
 * 3. If one filename has an archival timestamp and the other does not, pairing is unproven -> false.
 * 4. If neither filename has an archival timestamp, they represent an unversioned/canonical pair (valid if revTimestamp is not set).
 * 5. If revTimestamp is specified:
 *    - Any file with an archival timestamp must match revTimestamp.
 *    - If revTimestamp is set, files without timestamps cannot prove they belong to this revision -> false.
 */
export function isProvenanceSafeRoomPair(
  swfFilename?: string,
  txtFilename?: string,
  revTimestamp?: string | null,
): boolean {
  if (!swfFilename || !txtFilename) return false;

  const swfTs = extractRevisionTimestamp(swfFilename);
  const txtTs = extractRevisionTimestamp(txtFilename);

  // Both have timestamps -> verify matching
  if (swfTs && txtTs) {
    if (swfTs.length >= 14 && txtTs.length >= 14) {
      if (swfTs !== txtTs) return false;
    } else {
      const minLen = Math.min(swfTs.length, txtTs.length, 8);
      if (swfTs.slice(0, minLen) !== txtTs.slice(0, minLen)) return false;
    }
  }

  // One has timestamp and the other does not -> unproven pairing
  if ((swfTs && !txtTs) || (!swfTs && txtTs)) {
    return false;
  }

  // If revTimestamp is specified
  if (revTimestamp) {
    if (!swfTs || !txtTs) return false;
    const revLen = Math.min(revTimestamp.length, 8);
    if (swfTs.length >= 14 && revTimestamp.length >= 14) {
      if (swfTs !== revTimestamp) return false;
    } else if (swfTs.slice(0, revLen) !== revTimestamp.slice(0, revLen)) {
      return false;
    }
    if (txtTs.length >= 14 && revTimestamp.length >= 14) {
      if (txtTs !== revTimestamp) return false;
    } else if (txtTs.slice(0, revLen) !== revTimestamp.slice(0, revLen)) {
      return false;
    }
  }

  return true;
}

/**
 * Formats YYYYMMDD[HHmmss] timestamp into a human-readable string DD.MM.YYYY [HH:mm:ss]
 */
export function formatRevisionTimestamp(ts: string): string {
  if (ts.length >= 14) {
    const y = ts.slice(0, 4);
    const m = ts.slice(4, 6);
    const d = ts.slice(6, 8);
    const hh = ts.slice(8, 10);
    const mm = ts.slice(10, 12);
    const ss = ts.slice(12, 14);
    return `${d}.${m}.${y} ${hh}:${mm}:${ss}`;
  }
  if (ts.length >= 8) {
    const y = ts.slice(0, 4);
    const m = ts.slice(4, 6);
    const d = ts.slice(6, 8);
    return `${d}.${m}.${y}`;
  }
  return ts;
}

export function getEntityRevisionsDir(
  buildId: string,
  category: ContentCategory,
  subFolder: string,
  entityId: string | number,
  dataDir?: string,
): string {
  const catDir = getCategoryDir(buildId, category, dataDir);
  return resolve(catDir, subFolder, String(entityId));
}

export function readRevisionsRecord(
  buildId: string,
  category: ContentCategory,
  subFolder: string,
  entityId: string | number,
  dataDir?: string,
): LogicalAssetRevisionsRecord | null {
  const dir = getEntityRevisionsDir(buildId, category, subFolder, entityId, dataDir);
  const jsonPath = join(dir, "revisions.json");
  if (!existsSync(jsonPath)) return null;
  try {
    const record = JSON.parse(readFileSync(jsonPath, "utf8")) as LogicalAssetRevisionsRecord;
    if (record && record.revisions) {
      for (const rev of Object.values(record.revisions)) {
        const c = rev.compatibility as string;
        if (c === "CORE_COMPATIBLE" || c === "FULLY_COMPATIBLE") {
          rev.compatibility = "compatible";
        } else if (c === "PARTIALLY_COMPATIBLE") {
          rev.compatibility = "partially-compatible";
        } else if (c === "INCOMPATIBLE") {
          rev.compatibility = "incompatible";
        }

        // Reconcile any existing files on disk inside revisions/<revKey>/ that were not recorded,
        // enforcing strict provenance-safe pairing rules (never pair mismatched archival timestamps).
        const revDir = join(dir, "revisions", rev.revisionKey);
        if (existsSync(revDir)) {
          try {
            const diskFiles = readdirSync(revDir);
            for (const f of diskFiles) {
              const lower = f.toLowerCase();
              if (lower.endsWith(".swf") && !rev.files.swf) {
                const fTs = extractRevisionTimestamp(f);
                if (rev.timestamp) {
                  if (!fTs) continue;
                  if (rev.timestamp.length >= 14 && fTs.length >= 14) {
                    if (rev.timestamp !== fTs) continue;
                  } else if (rev.timestamp.slice(0, 8) !== fTs.slice(0, 8)) {
                    continue;
                  }
                } else if (fTs) {
                  // Undated revision must not adopt a dated file
                  continue;
                }
                if (rev.files.txt) {
                  if (!isProvenanceSafeRoomPair(f, rev.files.txt.filename, rev.timestamp)) continue;
                }

                const full = join(revDir, f);
                const stat = statSync(full);
                if (stat.isFile()) {
                  const bytes = readFileSync(full);
                  const sha256 = createHash("sha256").update(bytes).digest("hex");
                  rev.files.swf = {
                    role: "swf",
                    filename: f,
                    originalFilename: f,
                    originalRelativePath: f,
                    sha256,
                    size: bytes.length,
                  };
                }
              }
              if (lower.endsWith(".txt") && !rev.files.txt) {
                const fTs = extractRevisionTimestamp(f);
                if (rev.timestamp) {
                  if (!fTs) continue;
                  if (rev.timestamp.length >= 14 && fTs.length >= 14) {
                    if (rev.timestamp !== fTs) continue;
                  } else if (rev.timestamp.slice(0, 8) !== fTs.slice(0, 8)) {
                    continue;
                  }
                } else if (fTs) {
                  // Undated revision must not adopt a dated file
                  continue;
                }
                if (rev.files.swf) {
                  if (!isProvenanceSafeRoomPair(rev.files.swf.filename, f, rev.timestamp)) continue;
                }

                const full = join(revDir, f);
                const stat = statSync(full);
                if (stat.isFile()) {
                  const bytes = readFileSync(full);
                  const sha256 = createHash("sha256").update(bytes).digest("hex");
                  rev.files.txt = {
                    role: "txt",
                    filename: f,
                    originalFilename: f,
                    originalRelativePath: f,
                    sha256,
                    size: bytes.length,
                  };
                }
              }
            }
          } catch {
            // ignore disk read errors
          }
        }
      }
    }
    return record;
  } catch {
    return null;
  }
}

export function writeRevisionsRecord(
  buildId: string,
  category: ContentCategory,
  subFolder: string,
  record: LogicalAssetRevisionsRecord,
  dataDir?: string,
): void {
  const dir = getEntityRevisionsDir(buildId, category, subFolder, record.entityId, dataDir);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, "revisions.json");
  atomicWriteFile(jsonPath, JSON.stringify(record, null, 2) + "\n");

  const activePath = join(dir, "active.json");
  atomicWriteFile(
    activePath,
    JSON.stringify(
      {
        activeRevisionKey: record.activeRevisionKey,
        activeReason: record.activeReason,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Deterministically ranks revisions of a room to select the single active revision.
 * 
 * Precedence:
 * 1. Compatible revisions over incompatible.
 * 2. Complete SWF+TXT pairs over partial/incomplete (if requiresTxt is true).
 * 3. Most recent valid historical timestamp.
 * 4. Deterministic lexical tie-breaker by revisionKey (never import/iteration order).
 */
export function rankRoomRevisions(
  revisions: AssetRevision[],
  requiresTxt = true,
): AssetRevision[] {
  return [...revisions].sort((a, b) => {
    // 1. Compatibility
    const aCompat = a.compatibility !== "incompatible" ? 1 : 0;
    const bCompat = b.compatibility !== "incompatible" ? 1 : 0;
    if (aCompat !== bCompat) return bCompat - aCompat;

    // 2. Canonical precedence over non-canonical when canonical is present
    const aCanon = a.isCanonical ? 1 : 0;
    const bCanon = b.isCanonical ? 1 : 0;
    if (aCanon !== bCanon) return bCanon - aCanon;

    // 3. Completeness (provenance-safe SWF+TXT pair beats incomplete single file)
    const aPairSafe = a.files.swf && a.files.txt
      ? isProvenanceSafeRoomPair(a.files.swf.filename, a.files.txt.filename, a.timestamp)
      : !requiresTxt;
    const aComplete = Boolean(a.files.swf && (!requiresTxt || a.files.txt)) && aPairSafe;

    const bPairSafe = b.files.swf && b.files.txt
      ? isProvenanceSafeRoomPair(b.files.swf.filename, b.files.txt.filename, b.timestamp)
      : !requiresTxt;
    const bComplete = Boolean(b.files.swf && (!requiresTxt || b.files.txt)) && bPairSafe;
    if (aComplete !== bComplete) return (bComplete ? 1 : 0) - (aComplete ? 1 : 0);

    const aHasSwf = Boolean(a.files.swf);
    const bHasSwf = Boolean(b.files.swf);
    if (aHasSwf !== bHasSwf) return (bHasSwf ? 1 : 0) - (aHasSwf ? 1 : 0);

    // 4. Timestamp recency
    const aTs = a.timestamp ?? "";
    const bTs = b.timestamp ?? "";
    if (aTs !== bTs) {
      return bTs.localeCompare(aTs);
    }

    // 5. Deterministic tie-breaker
    return a.revisionKey.localeCompare(b.revisionKey);
  });
}

/**
 * Deterministically ranks revisions of a language file to select the single active revision.
 *
 * Precedence:
 * 1. Compatibility: compatible over incompatible.
 * 2. Recency of lastUpdate / timestamp.
 * 3. Deterministic tie-breaker by revisionKey (never import/iteration order).
 */
export function rankLanguageRevisions(revisions: AssetRevision[]): AssetRevision[] {
  return [...revisions].sort((a, b) => {
    // 1. Compatibility
    const aCompat = a.compatibility === "compatible";
    const bCompat = b.compatibility === "compatible";
    if (aCompat !== bCompat) return aCompat ? -1 : 1;

    // 2. Timestamp recency
    const aTs = a.timestamp ?? "";
    const bTs = b.timestamp ?? "";
    if (aTs !== bTs) return bTs.localeCompare(aTs);

    // 3. Deterministic tie-breaker
    return a.revisionKey.localeCompare(b.revisionKey);
  });
}

export {
  verifyMapPopupStructuralContract,
  verifyMapPopupCompatibility,
  type MapPopupContractResult,
} from "./map-popup-validator.ts";

/**
 * Deterministically ranks revisions of Popup 3 (World Map) to select the single active revision.
 *
 * Precedence:
 * 1. Structural compatibility: compatible > partially-compatible > unknown > incompatible.
 * 2. Build-generation provenance preference:
 *    For 20160725-android-1.4.7, revisions with 2016 provenance/timestamp (e.g., 201606xx, 201607xx, 2016)
 *    are prioritized as authentic matches for the 2016 build era.
 * 3. Completeness of room buttons: revisions with more room buttons (e.g. 24 > 12 > 8) are preferred.
 * 4. Recency of timestamp / lastUpdate.
 * 5. Deterministic tie-breaker by revisionKey.
 */
export function rankPopupRevisions(
  revisions: AssetRevision[],
  targetBuildId = "20160725-android-1.4.7",
): AssetRevision[] {
  return [...revisions].sort((a, b) => {
    // 1. Compatibility
    const aCompat = a.compatibility === "compatible" ? 1 : 0;
    const bCompat = b.compatibility === "compatible" ? 1 : 0;
    if (aCompat !== bCompat) return bCompat - aCompat;

    // 2. Build generation preference
    const isBuild2016 = targetBuildId.startsWith("2016");
    if (isBuild2016) {
      const aIs2016 =
        (a.timestamp && a.timestamp.startsWith("2016")) ||
        (a.provenance && a.provenance.includes("2016"))
          ? 1
          : 0;
      const bIs2016 =
        (b.timestamp && b.timestamp.startsWith("2016")) ||
        (b.provenance && b.provenance.includes("2016"))
          ? 1
          : 0;
      if (aIs2016 !== bIs2016) return bIs2016 - aIs2016;
    }

    // 3. Room buttons completeness (if available)
    const aRooms = a.roomButtonsCount ?? (a.roomButtons?.length ?? 0);
    const bRooms = b.roomButtonsCount ?? (b.roomButtons?.length ?? 0);
    if (aRooms !== bRooms) return bRooms - aRooms;

    // 4. Recency of timestamp
    const aTs = a.timestamp ?? "";
    const bTs = b.timestamp ?? "";
    if (aTs !== bTs) return bTs.localeCompare(aTs);

    // 5. Deterministic tie-breaker
    return a.revisionKey.localeCompare(b.revisionKey);
  });
}
