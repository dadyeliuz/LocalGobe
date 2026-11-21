import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ContentCategory } from "../builds/types.ts";
import { getBuildDefinition } from "../builds/registry.ts";
import { getUnclassifiedDir } from "../storage/paths.ts";
import {
  deleteOriginalAsset,
  ensureBuildDirectories,
  readBuildManifest,
  writeBuildManifest,
  writeOriginalAsset,
  writeUnclassifiedAsset,
} from "../storage/build-store.ts";
import {
  computeBuildManifest,
  type InstalledBuildManifest,
  type StoredAssetRecord,
  type UnclassifiedAssetRecord,
} from "../storage/manifest-generator.ts";
import { classifyExternalFile } from "./classifier.ts";
import { inspectMogobeLanguageXml } from "./language-inspector.ts";
import {
  formatRevisionTimestamp,
  getEntityRevisionsDir,
  isProvenanceSafeRoomPair,
  rankLanguageRevisions,
  rankPopupRevisions,
  rankRoomRevisions,
  readRevisionsRecord,
  verifyMapPopupStructuralContract,
  writeRevisionsRecord,
} from "../storage/revisions-store.ts";
import type { ExternalImportSummary, FileImportItemResult } from "./types.ts";

const MAX_EXTERNAL_FILE_BYTES = 64 * 1024 * 1024; // 64 MB safety limit

export type IncomingExternalFile = {
  relativePath: string;
  bytes: Buffer;
};

function matchedByRank(matchedBy: StoredAssetRecord["matchedBy"]): number {
  switch (matchedBy) {
    case "apk-whitelist":
      return 110;
    case "sha256":
      return 100;
    case "canonical-path":
      return 80;
    case "structural":
      return 60;
    case "filename":
      return 40;
  }
}

export function importExternalFiles(
  buildId: string,
  incomingFiles: readonly IncomingExternalFile[],
  options: { dataDir?: string } = {},
): ExternalImportSummary {
  const build = getBuildDefinition(buildId);
  if (!build) {
    throw new Error(`Unsupported buildId: ${buildId}`);
  }
  const existingManifest = readBuildManifest(buildId, options.dataDir);
  if (!existingManifest) {
    throw new Error(`Build "${buildId}" is not installed yet. Add the Mogobe APK first.`);
  }

  ensureBuildDirectories(buildId, options.dataDir);

  const assetMap = new Map<string, StoredAssetRecord>();
  for (const rec of existingManifest.recognizedAssets) {
    assetMap.set(rec.logicalId, rec);
  }

  const unclassifiedMap = new Map<string, UnclassifiedAssetRecord>();
  for (const rec of existingManifest.unclassifiedAssets ?? []) {
    unclassifiedMap.set(rec.sha256, rec);
  }

  const addedByCategory: Record<ContentCategory, number> = {
    game: 0,
    interface: 0,
    world: 0,
    items: 0,
    miniGames: 0,
  };

  let addedCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  let conflictCount = 0;
  let unclassifiedCount = 0;
  let unknownCount = 0;
  let rejectedCount = 0;

  const unknownFiles: string[] = [];
  const unclassifiedFiles: ExternalImportSummary["unclassifiedFiles"] = [];
  const conflicts: ExternalImportSummary["conflicts"] = [];
  const items: FileImportItemResult[] = [];
  const now = new Date().toISOString();
  const addedRoomsSet = new Set<number>();

  for (const file of incomingFiles) {
    const cleanRel = file.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanRel || cleanRel.includes("\0") || cleanRel.split("/").some((p) => p === "..")) {
      rejectedCount++;
      items.push({ relativePath: file.relativePath, status: "rejected", reason: "Unsafe file path" });
      continue;
    }

    if (file.bytes.length > MAX_EXTERNAL_FILE_BYTES) {
      rejectedCount++;
      items.push({ relativePath: cleanRel, status: "rejected", reason: "File exceeds safety size limit" });
      continue;
    }

    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const classification = classifyExternalFile(build, cleanRel, sha256, file.bytes);

    if (!classification.recognized) {
      if (classification.confidence === "PROBABLE_MOGOBE") {
        const rawFilename = cleanRel.split("/").pop() ?? cleanRel;
        const safeBaseName = rawFilename.replace(/[^A-Za-z0-9._-]/g, "_");
        const storagePath = `${sha256.slice(0, 12)}_${safeBaseName}`;
        writeUnclassifiedAsset(buildId, storagePath, file.bytes, options.dataDir);

        const existingUnclass = unclassifiedMap.get(sha256);
        if (!existingUnclass) {
          unclassifiedCount++;
          unclassifiedFiles.push({
            filename: rawFilename,
            relativePath: cleanRel,
            evidence: classification.evidence,
            detectedType: classification.detectedType,
          });
          unclassifiedMap.set(sha256, {
            sha256,
            originalFilename: rawFilename,
            relativePath: cleanRel,
            size: file.bytes.length,
            detectedType: classification.detectedType,
            confidence: "PROBABLE_MOGOBE",
            evidence: classification.evidence,
            importedAt: now,
            storagePath,
          });
          items.push({
            relativePath: cleanRel,
            status: "unclassified",
            confidence: "PROBABLE_MOGOBE",
            reason: classification.reason,
          });
        } else {
          duplicateCount++;
          items.push({
            relativePath: cleanRel,
            status: "duplicate",
            confidence: "PROBABLE_MOGOBE",
            reason: "Duplicate probable Mogobe asset already saved",
          });
        }
        continue;
      }

      unknownCount++;
      unknownFiles.push(cleanRel);
      items.push({
        relativePath: cleanRel,
        status: "unknown",
        confidence: "INVALID_OR_UNRELATED",
        reason: classification.reason,
      });
      continue;
    }

    unclassifiedMap.delete(sha256);

    // ── Special handling for Rooms: Multi-revision preservation & deterministic pairing ──
    if (classification.entityType === "room") {
      const roomId = Number(classification.entityId);
      const role = (classification.role ?? "swf") as "swf" | "txt";
      const rawFilename = cleanRel.split("/").pop() ?? cleanRel;
      const sourceDir = cleanRel.includes("/") ? cleanRel.slice(0, cleanRel.lastIndexOf("/")) : "";
      const ts = classification.timestamp;
      let revisionKey = ts || (sourceDir ? sourceDir.replace(/[^A-Za-z0-9_-]/g, "_") : classification.revisionKey || "canonical");

      let rec = readRevisionsRecord(buildId, "world", "Rooms", roomId, options.dataDir);

      if (!ts) {
        if (!rec?.revisions[revisionKey] || rec.revisions[revisionKey].files[role]) {
          const incompleteRev = rec && Object.values(rec.revisions).find(
            (r) => !r.timestamp && !r.files[role] && r.files[role === "swf" ? "txt" : "swf"]
          );
          const hasCompanionInSameSource = incomingFiles.some((f) => {
            const fRel = (f.relativePath || "").replace(/\\/g, "/");
            const fDir = fRel.includes("/") ? fRel.slice(0, fRel.lastIndexOf("/")) : "";
            return f !== file && fDir === sourceDir && fRel.includes(`room_${roomId}.`);
          });
          if (incompleteRev && !hasCompanionInSameSource) {
            revisionKey = incompleteRev.revisionKey;
          }
        }
      }
      if (rec?.revisions[revisionKey]?.files[role] && rec.revisions[revisionKey].files[role].sha256 !== sha256) {
        revisionKey = `${revisionKey}_${sha256.slice(0, 8)}`;
      }

      // Check if this exact file content (sha256) already exists in this room
      const alreadyHasSha = rec && Object.values(rec.revisions).some((r) => r.files[role]?.sha256 === sha256);

      if (alreadyHasSha) {
        duplicateCount++;
        items.push({
          relativePath: cleanRel,
          status: "duplicate",
          category: "world",
          logicalId: classification.logicalId,
        });
        continue;
      }

      // 1. Preserve original file bytes in its distinct revision folder (NO byte overwrite)
      writeOriginalAsset(buildId, "world", `Rooms/${roomId}/revisions/${revisionKey}/${rawFilename}`, file.bytes, options.dataDir);

      // 2. Update revisions record
      if (!rec) {
        rec = {
          logicalId: `world:room-${roomId}`,
          category: "world",
          entityId: roomId,
          activeRevisionKey: null,
          activeReason: null,
          revisions: {},
        };
      }

      if (!rec.revisions[revisionKey]) {
        rec.revisions[revisionKey] = {
          revisionKey,
          logicalId: `world:room-${roomId}`,
          category: "world",
          files: {},
          timestamp: ts,
          formattedDate: ts ? formatRevisionTimestamp(ts) : undefined,
          provenance: sourceDir || cleanRel,
          compatibility: "compatible",
          importedAt: now,
          isCanonical: classification.matchedBy === "canonical-path" || (!classification.timestamp && cleanRel.toLowerCase().startsWith("rooms/")),
        };
      }

      const rev = rec.revisions[revisionKey];
      rev.files[role] = {
        role,
        filename: rawFilename,
        originalFilename: rawFilename,
        originalRelativePath: cleanRel,
        sha256,
        size: file.bytes.length,
      };

      // 3. Deterministically rank revisions to determine recommended revision
      const ranked = rankRoomRevisions(Object.values(rec.revisions), build.roomRequiresTxt);
      const best = ranked[0];
      rec.activeRevisionKey = best?.revisionKey ?? null;
      const allRevs = Object.values(rec.revisions);
      const anySwfRev = allRevs.find((r) => Boolean(r.files.swf));
      const anyTxtRev = allRevs.find((r) => Boolean(r.files.txt));

      rec.activeReason = best
        ? best.files.swf && best.files.txt && isProvenanceSafeRoomPair(best.files.swf.filename, best.files.txt.filename, best.timestamp)
          ? best.formattedDate
            ? `גרסה מלאה תואמת מ-${best.formattedDate}`
            : "גרסה מלאה תואמת (SWF + TXT)"
          : anySwfRev && anyTxtRev
            ? "צמד חלופי (SWF + TXT)"
            : best.files.swf
              ? "קובץ חדר SWF"
              : "קובץ הגדרות TXT"
        : null;

      writeRevisionsRecord(buildId, "world", "Rooms", rec, options.dataDir);

      // 4. Update assetMap entry for the recommended revision (with cross-revision fallback)
      if (best) {
        for (const [rRole, rFile] of Object.entries(best.files)) {
          if (rFile) {
            assetMap.set(`world:room-${roomId}-${rRole}`, {
              logicalId: `world:room-${roomId}-${rRole}`,
              category: "world",
              storagePath: `Rooms/${roomId}/revisions/${best.revisionKey}/${rFile.filename}`,
              runtimeUrl: `/Swf/AssetsClean/Rooms/room_${roomId}.${rRole}`,
              sha256: rFile.sha256,
              size: rFile.size,
              required: roomId === build.bootstrapRoomId,
              feature: `Room ${roomId}`,
              matchedBy: classification.matchedBy,
              originalFilename: rFile.originalFilename,
              importedAt: now,
            });
          }
        }
        // Cross-revision complement fallback: if best has SWF but not TXT (or vice versa), populate missing role from another revision
        if (!best.files.swf && anySwfRev?.files.swf) {
          const sFile = anySwfRev.files.swf;
          assetMap.set(`world:room-${roomId}-swf`, {
            logicalId: `world:room-${roomId}-swf`,
            category: "world",
            storagePath: `Rooms/${roomId}/revisions/${anySwfRev.revisionKey}/${sFile.filename}`,
            runtimeUrl: `/Swf/AssetsClean/Rooms/room_${roomId}.swf`,
            sha256: sFile.sha256,
            size: sFile.size,
            required: roomId === build.bootstrapRoomId,
            feature: `Room ${roomId}`,
            matchedBy: "canonical-path",
            originalFilename: sFile.originalFilename,
            importedAt: now,
          });
        }
        if (!best.files.txt && anyTxtRev?.files.txt) {
          const tFile = anyTxtRev.files.txt;
          assetMap.set(`world:room-${roomId}-txt`, {
            logicalId: `world:room-${roomId}-txt`,
            category: "world",
            storagePath: `Rooms/${roomId}/revisions/${anyTxtRev.revisionKey}/${tFile.filename}`,
            runtimeUrl: `/Swf/AssetsClean/Rooms/room_${roomId}.txt`,
            sha256: tFile.sha256,
            size: tFile.size,
            required: roomId === build.bootstrapRoomId,
            feature: `Room ${roomId}`,
            matchedBy: "canonical-path",
            originalFilename: tFile.originalFilename,
            importedAt: now,
          });
        }
      }

      // Every valid historical room revision is preserved as an added asset without conflict
      addedCount++;
      addedByCategory["world"]++;
      items.push({
        relativePath: cleanRel,
        status: "added",
        category: "world",
        logicalId: classification.logicalId,
        reason: ts ? `נשמר כגרסה ${formatRevisionTimestamp(ts)}` : `נשמר כגרסת חדר ${revisionKey}`,
      });
      continue;
    }

    // ── Special handling for Popups: Compatibility verification before activation ──
    if (classification.entityType === "popup") {
      const popupId = Number(classification.entityId);
      const rawFilename = cleanRel.split("/").pop() ?? cleanRel;
      const ts = classification.timestamp;
      const revKey = ts || sha256.slice(0, 12);

      const existingLogical = assetMap.get(classification.logicalId);
      if (existingLogical && existingLogical.sha256 === sha256) {
        duplicateCount++;
        items.push({
          relativePath: cleanRel,
          status: "duplicate",
          category: "interface",
          logicalId: classification.logicalId,
        });
        continue;
      }

      // 1. Preserve original file in revisions folder
      writeOriginalAsset(buildId, "interface", `Popups/${popupId}/revisions/${revKey}/${rawFilename}`, file.bytes, options.dataDir);

      // 2. Read or create revisions record
      let rec = readRevisionsRecord(buildId, "interface", "Popups", popupId, options.dataDir);
      if (!rec) {
        rec = {
          logicalId: `interface:popup-${popupId}`,
          category: "interface",
          entityId: popupId,
          activeRevisionKey: null,
          activeReason: null,
          revisions: {},
        };
      }

      // 3. Verify build compatibility
      let compatibility: "compatible" | "incompatible" = "compatible";
      let compatibilityReason: string | undefined;
      let recognized = true;
      let structurallyCompatible = true;
      let roomButtonsCount: number | undefined;
      let roomButtons: string[] | undefined;

      if (popupId === 3) {
        const check = verifyMapPopupStructuralContract(file.bytes);
        recognized = check.recognized;
        structurallyCompatible = check.structurallyCompatible;
        compatibility = check.compatible ? "compatible" : "incompatible";
        compatibilityReason = check.reason;
        roomButtonsCount = check.roomButtonCount;
        roomButtons = check.roomButtons;
      }

      rec.revisions[revKey] = {
        revisionKey: revKey,
        logicalId: `interface:popup-${popupId}`,
        category: "interface",
        files: {
          swf: {
            role: "swf",
            filename: rawFilename,
            originalFilename: rawFilename,
            originalRelativePath: cleanRel,
            sha256,
            size: file.bytes.length,
          },
        },
        timestamp: ts,
        formattedDate: ts ? formatRevisionTimestamp(ts) : undefined,
        provenance: cleanRel,
        compatibility,
        compatibilityReason,
        recognized,
        structurallyCompatible,
        roomButtonsCount,
        roomButtons,
        importedAt: now,
      };

      const ranked =
        popupId === 3
          ? rankPopupRevisions(Object.values(rec.revisions), buildId)
          : Object.values(rec.revisions);
      const best = ranked[0];

      if (best && best.compatibility === "compatible") {
        rec.activeRevisionKey = best.revisionKey;
        rec.activeReason = best.compatibilityReason || "גרסה תואמת לחוזה הלקוח 2016";

        // Read active file bytes from revisions store to ensure Popups/p_3.swf has active bytes
        const activeFileInfo = best.files.swf;
        if (activeFileInfo) {
          const activePath = resolve(
            getEntityRevisionsDir(buildId, "interface", "Popups", popupId, options.dataDir),
            "revisions",
            best.revisionKey,
            activeFileInfo.filename,
          );
          if (existsSync(activePath)) {
            const activeBytes = readFileSync(activePath);
            writeOriginalAsset(buildId, "interface", `Popups/p_${popupId}.swf`, activeBytes, options.dataDir);
            assetMap.set(`interface:popup-${popupId}`, {
              logicalId: `interface:popup-${popupId}`,
              category: "interface",
              storagePath: `Popups/p_${popupId}.swf`,
              runtimeUrl: `/Swf/AssetsClean/Popups/p_${popupId}.swf`,
              sha256: activeFileInfo.sha256,
              size: activeBytes.length,
              required: false,
              feature: `Popup ${popupId}`,
              matchedBy: classification.matchedBy,
              originalFilename: activeFileInfo.originalFilename,
              importedAt: now,
            });
          }
        }
      } else {
        // External revision is incompatible (e.g. 2013 p_3.swf with 2016 MapPopup contract)
        rec.activeRevisionKey = null;
        rec.activeReason = "נמצאו גרסאות היסטוריות, אך אינה פעילה לבילד זה (אין גרסה תואמת)";
        deleteOriginalAsset(buildId, "interface", `Popups/p_${popupId}.swf`, options.dataDir);
        assetMap.delete(`interface:popup-${popupId}`);
      }
      writeRevisionsRecord(buildId, "interface", "Popups", rec, options.dataDir);

      addedByCategory["interface"]++;
      addedCount++;
      items.push({
        relativePath: cleanRel,
        status: "added",
        category: "interface",
        logicalId: classification.logicalId,
        reason: compatibility === "compatible" ? "גרסה תואמת" : `נשמר כגרסה היסטורית (${compatibilityReason})`,
      });
      continue;
    }

    // ── Special handling for Language: Multi-revision preservation, compatibility, & active selection ──
    if (classification.entityType === "language") {
      const rawFilename = cleanRel.split("/").pop() ?? cleanRel;
      const ts = classification.timestamp;
      const revKey = classification.revisionKey || sha256.slice(0, 12);

      let rec = readRevisionsRecord(buildId, "interface", "Language", "he", options.dataDir);
      const existingLogical = assetMap.get(classification.logicalId);
      const alreadyHasSha =
        (existingLogical && existingLogical.sha256 === sha256) ||
        (rec && Object.values(rec.revisions).some((r) => r.files["xml"]?.sha256 === sha256));

      if (alreadyHasSha) {
        if (rec) {
          const ranked = rankLanguageRevisions(Object.values(rec.revisions));
          const best = ranked[0];
          if (best && best.compatibility === "compatible") {
            rec.activeRevisionKey = best.revisionKey;
            rec.activeReason = best.compatibilityReason ?? "גרסה פעילה";
            const bestFile = best.files["xml"];
            if (bestFile) {
              assetMap.set("interface:language-he", {
                logicalId: "interface:language-he",
                category: "interface",
                storagePath: `Language/he/${best.revisionKey}/${bestFile.filename}`,
                runtimeUrl: "/servises/lang.aspx",
                sha256: bestFile.sha256,
                size: bestFile.size,
                required: false,
                feature: "Hebrew Language",
                matchedBy: classification.matchedBy,
                originalFilename: bestFile.originalFilename,
                importedAt: now,
              });
            }
            writeRevisionsRecord(buildId, "interface", "Language", rec, options.dataDir);
          }
        }
        duplicateCount++;
        items.push({
          relativePath: cleanRel,
          status: "duplicate",
          category: "interface",
          logicalId: classification.logicalId,
        });
        continue;
      }

      // 1. Preserve original file bytes in its revision folder
      writeOriginalAsset(
        buildId,
        "interface",
        `Language/he/${revKey}/${rawFilename}`,
        file.bytes,
        options.dataDir,
      );

      // 2. Initialize revisions record
      if (!rec) {
        rec = {
          logicalId: "interface:language-he",
          category: "interface",
          entityId: "he",
          activeRevisionKey: null,
          activeReason: null,
          revisions: {},
        };
      }

      // 3. Inspect language content and record revision
      const insp = classification.languageInspection ?? inspectMogobeLanguageXml(file.bytes);
      rec.revisions[revKey] = {
        revisionKey: revKey,
        logicalId: "interface:language-he",
        category: "interface",
        files: {
          xml: {
            role: "xml",
            filename: rawFilename,
            originalFilename: rawFilename,
            originalRelativePath: cleanRel,
            sha256,
            size: file.bytes.length,
          },
        },
        timestamp: ts,
        formattedDate: ts ? formatRevisionTimestamp(ts) : undefined,
        provenance: cleanRel,
        compatibility: insp.valid ? "compatible" : "incompatible",
        compatibilityReason: insp.reason,
        importedAt: now,
        languageId: insp.languageId,
        lastUpdate: insp.lastUpdate,
      };

      // 4. Deterministically rank revisions to select active revision
      const prevActiveRevisionKey = rec.activeRevisionKey;
      const ranked = rankLanguageRevisions(Object.values(rec.revisions));
      const best = ranked[0];

      const canActivate = best && best.compatibility === "compatible";

      // Ensure no duplicate flat Language/lang.aspx exists (single source of truth: revision storage)
      deleteOriginalAsset(buildId, "interface", "Language/lang.aspx", options.dataDir);

      if (canActivate) {
        rec.activeRevisionKey = best.revisionKey;
        rec.activeReason = best.compatibilityReason ?? "גרסה פעילה";

        const bestFile = best.files["xml"];
        if (bestFile) {
          assetMap.set("interface:language-he", {
            logicalId: "interface:language-he",
            category: "interface",
            storagePath: `Language/he/${best.revisionKey}/${bestFile.filename}`,
            runtimeUrl: "/servises/lang.aspx",
            sha256: bestFile.sha256,
            size: bestFile.size,
            required: false,
            feature: "Hebrew Language",
            matchedBy: classification.matchedBy,
            originalFilename: bestFile.originalFilename,
            importedAt: now,
          });
        }
      } else {
        rec.activeRevisionKey = null;
        rec.activeReason = `נשמר כגרסה היסטורית אך אינה פעילה (${best?.compatibilityReason ?? "לא תואם"})`;
        assetMap.delete("interface:language-he");
      }

      writeRevisionsRecord(buildId, "interface", "Language", rec, options.dataDir);

      const isUpgrade =
        prevActiveRevisionKey !== null &&
        prevActiveRevisionKey !== best.revisionKey &&
        best.revisionKey === revKey;
      if (best.revisionKey === revKey) {
        if (isUpgrade) {
          updatedCount++;
          items.push({
            relativePath: cleanRel,
            status: "updated",
            category: "interface",
            logicalId: classification.logicalId,
            reason: `שודרג לגרסת שפה עדכנית יותר (${insp.reason})`,
          });
        } else {
          addedByCategory["interface"]++;
          addedCount++;
          items.push({
            relativePath: cleanRel,
            status: "added",
            category: "interface",
            logicalId: classification.logicalId,
            reason: insp.reason,
          });
        }
      } else {
        conflictCount++;
        conflicts.push({
          relativePath: cleanRel,
          logicalId: classification.logicalId,
          existingSha256: best.files["xml"]?.sha256 ?? "",
          incomingSha256: sha256,
        });
        items.push({
          relativePath: cleanRel,
          status: "conflict-kept-existing",
          category: "interface",
          logicalId: classification.logicalId,
          reason: "נשמר בארכיון הגרסאות; גרסת שפה פעילה קיימת נשמרה",
        });
      }
      continue;
    }

    const existing = assetMap.get(classification.logicalId);
    if (existing) {
      if (existing.sha256 === sha256) {
        duplicateCount++;
        items.push({
          relativePath: cleanRel,
          status: "duplicate",
          category: classification.category,
          logicalId: classification.logicalId,
        });
        continue;
      }

      // Conflict: two different hashes claim the same logical asset.
      // Rank deterministically; never silently overwrite an equal or higher-ranked asset.
      const existingRank = matchedByRank(existing.matchedBy);
      if (classification.rank > existingRank) {
        writeOriginalAsset(buildId, classification.category, classification.storagePath, file.bytes, options.dataDir);
        assetMap.set(classification.logicalId, {
          logicalId: classification.logicalId,
          category: classification.category,
          storagePath: classification.storagePath,
          runtimeUrl: classification.runtimeUrl,
          sha256,
          size: file.bytes.length,
          required: classification.required,
          feature: classification.feature,
          matchedBy: classification.matchedBy,
          originalFilename: cleanRel.split("/").pop() ?? cleanRel,
          importedAt: now,
        });
        updatedCount++;
        items.push({
          relativePath: cleanRel,
          status: "updated",
          category: classification.category,
          logicalId: classification.logicalId,
          reason: `Higher-confidence match (${classification.matchedBy}) replaced ${existing.matchedBy}`,
        });
      } else {
        conflictCount++;
        conflicts.push({
          relativePath: cleanRel,
          logicalId: classification.logicalId,
          existingSha256: existing.sha256,
          incomingSha256: sha256,
        });
        items.push({
          relativePath: cleanRel,
          status: "conflict-kept-existing",
          category: classification.category,
          logicalId: classification.logicalId,
          reason: "Kept existing asset with equal or higher provenance rank",
        });
      }
      continue;
    }

    // If this file previously existed in unclassified storage, clean it up
    if (unclassifiedMap.has(sha256)) {
      const old = unclassifiedMap.get(sha256);
      if (old?.storagePath) {
        const unclassFull = resolve(getUnclassifiedDir(buildId, options.dataDir), old.storagePath);
        if (existsSync(unclassFull)) {
          try {
            unlinkSync(unclassFull);
          } catch {}
        }
      }
      unclassifiedMap.delete(sha256);
    }

    // New recognized asset: preserve original bytes verbatim
    writeOriginalAsset(buildId, classification.category, classification.storagePath, file.bytes, options.dataDir);
    assetMap.set(classification.logicalId, {
      logicalId: classification.logicalId,
      category: classification.category,
      storagePath: classification.storagePath,
      runtimeUrl: classification.runtimeUrl,
      sha256,
      size: file.bytes.length,
      required: classification.required,
      feature: classification.feature,
      matchedBy: classification.matchedBy,
      originalFilename: cleanRel.split("/").pop() ?? cleanRel,
      importedAt: now,
    });
    addedCount++;
    addedByCategory[classification.category]++;
    items.push({
      relativePath: cleanRel,
      status: "added",
      category: classification.category,
      logicalId: classification.logicalId,
    });
  }

  const updatedManifest = computeBuildManifest(
    build,
    {
      installedAt: existingManifest.installedAt,
      apk: existingManifest.apk,
      recognizedAssets: Array.from(assetMap.values()),
      unclassifiedAssets: Array.from(unclassifiedMap.values()),
    },
    options,
  );

  writeBuildManifest(updatedManifest, options.dataDir);

  return {
    buildId,
    addedCount,
    updatedCount,
    duplicateCount,
    conflictCount,
    unclassifiedCount,
    unknownCount,
    rejectedCount,
    addedByCategory,
    unknownFiles,
    unclassifiedFiles,
    conflicts,
    items,
    manifest: updatedManifest,
  };
}

/**
 * Recursively imports a local folder into an installed build, skipping symlinks
 * so scanning can never escape the selected directory.
 */
export function importExternalDirectory(
  buildId: string,
  rootFolder: string,
  options: { dataDir?: string } = {},
): ExternalImportSummary {
  const collected: IncomingExternalFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        if (stat.size <= MAX_EXTERNAL_FILE_BYTES) {
          collected.push({
            relativePath: relative(rootFolder, fullPath).replace(/\\/g, "/"),
            bytes: readFileSync(fullPath),
          });
        }
      }
    }
  }

  walk(rootFolder);
  return importExternalFiles(buildId, collected, options);
}

/**
 * Sweeps the unclassified assets folder and automatically promotes any files
 * that are now recognized by structural or catalog validators (e.g. MapPopup 3).
 */
export function reconcileUnclassifiedAssets(
  buildId: string,
  options: { dataDir?: string } = {},
): number {
  const build = getBuildDefinition(buildId);
  if (!build) return 0;
  const unclassDir = getUnclassifiedDir(buildId, options.dataDir);
  if (!existsSync(unclassDir)) return 0;

  let promotedCount = 0;
  try {
    const entries = readdirSync(unclassDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const filePath = join(unclassDir, ent.name);
      try {
        const bytes = readFileSync(filePath);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const cleanRel = ent.name.replace(/^[0-9a-f]{12}_/, "");
        const classification = classifyExternalFile(build, cleanRel, sha256, bytes);
        if (classification.recognized) {
          importExternalFiles(buildId, [{ relativePath: cleanRel, bytes }], options);
          unlinkSync(filePath);
          promotedCount++;
        }
      } catch {
        // ignore individual file error
      }
    }
  } catch {
    // ignore directory read error
  }

  return promotedCount;
}
