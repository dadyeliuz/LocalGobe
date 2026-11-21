import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ContentCategory } from "../builds/types.ts";
import { getBuildDefinition } from "../builds/registry.ts";
import { computeBuildManifest, type InstalledBuildManifest, type StoredAssetRecord } from "./manifest-generator.ts";
import {
  getBuildDir,
  getBuildManifestPath,
  getBuildsRoot,
  getCategoryDir,
  getUnclassifiedDir,
  resolveInsideDir,
} from "./paths.ts";

export function atomicWriteFile(filePath: string, data: Buffer | string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, data);
  try {
    renameSync(tmpPath, filePath);
  } catch {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
      renameSync(tmpPath, filePath);
    } catch {
      copyFileSync(tmpPath, filePath);
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

export function ensureBuildDirectories(buildId: string, dataDir?: string): void {
  const categories: ContentCategory[] = ["game", "interface", "world", "items", "miniGames"];
  for (const cat of categories) {
    mkdirSync(getCategoryDir(buildId, cat, dataDir), { recursive: true });
  }
  mkdirSync(getUnclassifiedDir(buildId, dataDir), { recursive: true });
}

export function writeUnclassifiedAsset(
  buildId: string,
  storagePath: string,
  bytes: Buffer,
  dataDir?: string,
): string {
  const unclassifiedDir = getUnclassifiedDir(buildId, dataDir);
  const fullPath = resolveInsideDir(unclassifiedDir, storagePath);
  atomicWriteFile(fullPath, bytes);
  return fullPath;
}

export function readBuildManifest(buildId: string, dataDir?: string): InstalledBuildManifest | null {
  const manifestPath = getBuildManifestPath(buildId, dataDir);
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as InstalledBuildManifest;
    if (parsed && parsed.schemaVersion === 1 && parsed.buildId === buildId) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeBuildManifest(manifest: InstalledBuildManifest, dataDir?: string): void {
  const manifestPath = getBuildManifestPath(manifest.buildId, dataDir);
  atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function listInstalledBuilds(dataDir?: string): InstalledBuildManifest[] {
  const buildsRoot = getBuildsRoot(dataDir);
  if (!existsSync(buildsRoot)) return [];
  const manifests: InstalledBuildManifest[] = [];
  for (const entry of readdirSync(buildsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readBuildManifest(entry.name, dataDir);
    if (manifest) manifests.push(manifest);
  }
  return manifests.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function writeOriginalAsset(
  buildId: string,
  category: ContentCategory,
  storagePath: string,
  bytes: Buffer,
  dataDir?: string,
): string {
  const catDir = getCategoryDir(buildId, category, dataDir);
  const fullPath = resolveInsideDir(catDir, storagePath);
  atomicWriteFile(fullPath, bytes);
  return fullPath;
}

export function readOriginalAsset(
  buildId: string,
  category: ContentCategory,
  storagePath: string,
  dataDir?: string,
): Buffer | null {
  try {
    const catDir = getCategoryDir(buildId, category, dataDir);
    const fullPath = resolveInsideDir(catDir, storagePath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return null;
    return readFileSync(fullPath);
  } catch {
    return null;
  }
}

export function deleteOriginalAsset(
  buildId: string,
  category: ContentCategory,
  storagePath: string,
  dataDir?: string,
): boolean {
  try {
    const catDir = getCategoryDir(buildId, category, dataDir);
    const fullPath = resolveInsideDir(catDir, storagePath);
    if (existsSync(fullPath)) {
      rmSync(fullPath, { force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function deleteInstalledBuild(buildId: string, dataDir?: string): boolean {
  const dir = getBuildDir(buildId, dataDir);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function refreshBuildManifest(buildId: string, dataDir?: string): InstalledBuildManifest | null {
  const current = readBuildManifest(buildId, dataDir);
  if (!current) return null;
  const def = getBuildDefinition(buildId);
  if (!def) return current;

  // Verify stored files still exist on disk
  const validAssets: StoredAssetRecord[] = [];
  const validAssetMap = new Map<string, StoredAssetRecord>();
  for (const rec of current.recognizedAssets) {
    try {
      const fullPath = resolveInsideDir(getCategoryDir(buildId, rec.category, dataDir), rec.storagePath);
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        validAssets.push(rec);
        validAssetMap.set(rec.logicalId, rec);
      }
    } catch {
      // skip invalid record
    }
  }

  // Self-healing / reconciliation: check revisions store for any active revisions that should be present
  try {
    const worldRoomsDir = resolveInsideDir(getCategoryDir(buildId, "world", dataDir), "Rooms");
    if (existsSync(worldRoomsDir)) {
      const entries = readdirSync(worldRoomsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && /^\d+$/.test(ent.name)) {
          const roomId = Number(ent.name);
          const revRecPath = join(worldRoomsDir, ent.name, "revisions.json");
          if (existsSync(revRecPath)) {
            try {
              const revRec = JSON.parse(readFileSync(revRecPath, "utf8"));
              if (revRec && revRec.revisions && Object.keys(revRec.revisions).length > 0) {
                const active = (revRec.activeRevisionKey && revRec.revisions[revRec.activeRevisionKey]) || Object.values(revRec.revisions)[0];
                const allRevs = Object.values(revRec.revisions) as any[];
                for (const role of ["swf", "txt"] as const) {
                  let sourceRev = active?.files?.[role] ? active : allRevs.find((r) => Boolean(r?.files?.[role]));
                  if (!sourceRev || !sourceRev.files?.[role]) continue;
                  const rFile = sourceRev.files[role] as { filename: string; sha256: string; size: number; originalFilename: string };
                  const revFilePath = join(worldRoomsDir, ent.name, "revisions", sourceRev.revisionKey, rFile.filename);
                  const flatPath = join(worldRoomsDir, `room_${roomId}.${role}`);
                  if (existsSync(revFilePath)) {
                    if (existsSync(flatPath)) {
                      try { rmSync(flatPath, { force: true }); } catch { /* ignore */ }
                    }
                    const logicalId = `world:room-${roomId}-${role}`;
                    if (!validAssetMap.has(logicalId)) {
                      const newAsset: StoredAssetRecord = {
                        logicalId,
                        category: "world",
                        storagePath: `Rooms/${roomId}/revisions/${sourceRev.revisionKey}/${rFile.filename}`,
                        runtimeUrl: `/Swf/AssetsClean/Rooms/room_${roomId}.${role}`,
                        sha256: rFile.sha256,
                        size: rFile.size,
                        required: roomId === def.bootstrapRoomId,
                        feature: `Room ${roomId}`,
                        matchedBy: "canonical-path",
                        originalFilename: rFile.originalFilename,
                        importedAt: sourceRev.importedAt || new Date().toISOString(),
                      };
                      validAssets.push(newAsset);
                      validAssetMap.set(logicalId, newAsset);
                    }
                  }
                }
              }
            } catch {
              // ignore invalid JSON
            }
          }
        }
      }
    }
  } catch {
    // ignore directory scan errors
  }

  // Self-healing / reconciliation for Interface Popups (e.g. Popup 3)
  try {
    const popupsDir = resolveInsideDir(getCategoryDir(buildId, "interface", dataDir), "Popups");
    if (existsSync(popupsDir)) {
      const entries = readdirSync(popupsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && /^\d+$/.test(ent.name)) {
          const popupId = Number(ent.name);
          const revRecPath = join(popupsDir, ent.name, "revisions.json");
          if (existsSync(revRecPath)) {
            try {
              const revRec = JSON.parse(readFileSync(revRecPath, "utf8"));
              if (revRec && revRec.activeRevisionKey && revRec.revisions?.[revRec.activeRevisionKey]) {
                const active = revRec.revisions[revRec.activeRevisionKey];
                const swfFile = active.files?.swf;
                if (swfFile) {
                  const revFilePath = join(popupsDir, ent.name, "revisions", active.revisionKey, swfFile.filename);
                  const flatPath = join(popupsDir, `p_${popupId}.swf`);
                  if (existsSync(revFilePath)) {
                    if (!existsSync(flatPath)) {
                      atomicWriteFile(flatPath, readFileSync(revFilePath));
                    }
                    const logicalId = `interface:popup-${popupId}`;
                    if (!validAssetMap.has(logicalId)) {
                      const newAsset: StoredAssetRecord = {
                        logicalId,
                        category: "interface",
                        storagePath: `Popups/p_${popupId}.swf`,
                        runtimeUrl: `/Swf/AssetsClean/Popups/p_${popupId}.swf`,
                        sha256: swfFile.sha256,
                        size: swfFile.size,
                        required: false,
                        feature: `Popup ${popupId}`,
                        matchedBy: "canonical-path",
                        originalFilename: swfFile.originalFilename,
                        importedAt: active.importedAt || new Date().toISOString(),
                      };
                      validAssets.push(newAsset);
                      validAssetMap.set(logicalId, newAsset);
                    }
                  }
                }
              }
            } catch {
              // ignore invalid JSON
            }
          }
        }
      }
    }
  } catch {
    // ignore directory scan errors
  }

  const recomputed = computeBuildManifest(
    def,
    {
      installedAt: current.installedAt,
      apk: current.apk,
      recognizedAssets: validAssets,
      unclassifiedAssets: current.unclassifiedAssets,
    },
    { dataDir },
  );
  writeBuildManifest(recomputed, dataDir);
  return recomputed;
}

export function getPlayerCardStatus(buildId: string, dataDir?: string): {
  mogoWallSwfPresent: boolean;
  friendCardSwfPresent: boolean;
  mogoWallConfigPresent: boolean;
} {
  return {
    mogoWallSwfPresent: readOriginalAsset(buildId, "interface", "MogoWall/MogoWall.swf", dataDir) !== null,
    friendCardSwfPresent: readOriginalAsset(buildId, "interface", "MogoWall/FriendCard.swf", dataDir) !== null,
    mogoWallConfigPresent: readOriginalAsset(buildId, "interface", "MogoWall/MogoWall.txt", dataDir) !== null,
  };
}
