import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { recognizeApkBuild } from "../builds/registry.ts";
import {
  ensureBuildDirectories,
  readBuildManifest,
  writeBuildManifest,
  writeOriginalAsset,
} from "../storage/build-store.ts";
import { computeBuildManifest, type StoredAssetRecord } from "../storage/manifest-generator.ts";
import type { ApkImportResult } from "./types.ts";
import { DEFAULT_ZIP_LIMITS, SafeZipArchive, type ZipSafetyLimits } from "./zip-reader.ts";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function parseAirApplicationXml(xmlText: string): {
  packageName?: string;
  versionName?: string;
  contentSwf?: string;
} {
  const idMatch = /<id>\s*([^<\s]+)\s*<\/id>/i.exec(xmlText);
  const verMatch = /<versionNumber>\s*([^<\s]+)\s*<\/versionNumber>/i.exec(xmlText);
  const contentMatch = /<content>\s*([^<\s]+)\s*<\/content>/i.exec(xmlText);
  return {
    packageName: idMatch?.[1],
    versionName: verMatch?.[1],
    contentSwf: contentMatch?.[1],
  };
}

export function importApkBuffer(
  apkBuffer: Buffer,
  options: {
    dataDir?: string;
    limits?: ZipSafetyLimits;
    strictHashes?: boolean;
  } = {},
): ApkImportResult {
  const apkSha256 = sha256Hex(apkBuffer);
  const strictHashes = options.strictHashes ?? false;

  let archive: SafeZipArchive;
  try {
    archive = new SafeZipArchive(apkBuffer, options.limits ?? DEFAULT_ZIP_LIMITS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isSecurity = message.toLowerCase().includes("security violation");
    return {
      ok: false,
      code: isSecurity ? "SECURITY_VIOLATION" : "INVALID_ARCHIVE",
      userMessage: isSecurity
        ? "This file failed a safety check and could not be imported."
        : "This file doesn't appear to be a valid APK package.",
      details: { apkSha256, technicalError: message },
    };
  }

  // Inspect AIR application descriptor if present
  let packageName: string | undefined;
  let versionName: string | undefined;
  let contentSwf: string | undefined;
  try {
    const xmlBuf = archive.readEntry("assets/META-INF/AIR/application.xml");
    if (xmlBuf) {
      const parsed = parseAirApplicationXml(xmlBuf.toString("utf8"));
      packageName = parsed.packageName;
      versionName = parsed.versionName;
      contentSwf = parsed.contentSwf;
    }
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_ARCHIVE",
      userMessage: "This APK's application descriptor could not be read.",
      details: { apkSha256, technicalError: err instanceof Error ? err.message : String(err) },
    };
  }

  const hasRootSwf = contentSwf ? archive.hasEntry(`assets/${contentSwf}`) : archive.hasEntry("assets/MogobeTabIL.swf");
  const recognized = recognizeApkBuild({
    sha256: apkSha256,
    packageName,
    versionName,
    hasRootSwf,
  });

  if (!recognized) {
    return {
      ok: false,
      code: "UNSUPPORTED_APK",
      userMessage: "This Mogobe version is not supported yet.",
      details: { apkSha256, packageName, versionName },
    };
  }

  const { build, matchedBy } = recognized;
  ensureBuildDirectories(build.buildId, options.dataDir);

  const existingManifest = readBuildManifest(build.buildId, options.dataDir);
  // Preserve already-imported external assets (interface/world/items/miniGames) on APK re-import
  const preservedExternal = (existingManifest?.recognizedAssets ?? []).filter(
    (a) => a.category !== "game",
  );

  const extractedGameRecords: StoredAssetRecord[] = [];
  const extractedApkPaths = new Set<string>();
  const hashMismatches: Array<{ logicalId: string; storagePath: string; expected: string; actual: string }> = [];
  const now = new Date().toISOString();

  // 1. Extract explicit required + named APK assets
  for (const spec of build.apkRequiredAssets) {
    let bytes: Buffer | null;
    try {
      bytes = archive.readEntry(spec.apkPath);
    } catch (err) {
      return {
        ok: false,
        code: "SECURITY_VIOLATION",
        userMessage: "This APK failed a safety check while extracting game files.",
        details: { apkSha256, packageName, versionName, technicalError: String(err) },
      };
    }

    if (!bytes) {
      if (spec.required) {
        return {
          ok: false,
          code: "MISSING_REQUIRED_APK_ASSET",
          userMessage: "This APK is missing required Mogobe game files.",
          details: { apkSha256, packageName, versionName, technicalError: `Missing ${spec.apkPath}` },
        };
      }
      continue;
    }

    const actualHash = sha256Hex(bytes);
    const hashVerified = spec.expectedSha256 ? actualHash === spec.expectedSha256.toLowerCase() : undefined;
    if (spec.expectedSha256 && !hashVerified) {
      hashMismatches.push({
        logicalId: spec.logicalId,
        storagePath: spec.storagePath,
        expected: spec.expectedSha256,
        actual: actualHash,
      });
      if (strictHashes && spec.required) {
        return {
          ok: false,
          code: "HASH_MISMATCH",
          userMessage: "This file isn't the version LocalGobe expected.",
          details: {
            apkSha256,
            packageName,
            versionName,
            technicalError: `Hash mismatch for ${spec.apkPath}: expected ${spec.expectedSha256}, got ${actualHash}`,
          },
        };
      }
    }

    writeOriginalAsset(build.buildId, "game", spec.storagePath, bytes, options.dataDir);
    extractedApkPaths.add(spec.apkPath);
    extractedGameRecords.push({
      logicalId: spec.logicalId,
      category: "game",
      storagePath: spec.storagePath,
      runtimeUrl: spec.runtimeUrl,
      sha256: actualHash,
      size: bytes.length,
      required: spec.required,
      feature: "Game",
      matchedBy: "apk-whitelist",
      originalFilename: spec.apkPath.split("/").pop() ?? spec.storagePath,
      importedAt: now,
      hashVerified,
    });
  }

  // 2. Extract optional whitelisted SWF subdirectories inside APK (never unpack native libs, dex, jars, res)
  for (const entry of archive.listEntries()) {
    if (entry.isDirectory || extractedApkPaths.has(entry.name)) continue;
    for (const prefixSpec of build.apkOptionalPrefixes) {
      if (!entry.name.startsWith(prefixSpec.apkPrefix)) continue;
      const lowerName = entry.name.toLowerCase();
      if (!prefixSpec.extensions.some((ext) => lowerName.endsWith(ext.toLowerCase()))) continue;

      const relSubPath = entry.name.slice(prefixSpec.apkPrefix.length);
      if (!relSubPath || relSubPath.includes("/")) continue; // single level inside whitelisted dir

      const bytes = archive.readEntry(entry.name);
      if (!bytes) continue;

      const storagePath = `${prefixSpec.storagePrefix}${relSubPath}`;
      const hash = sha256Hex(bytes);
      writeOriginalAsset(build.buildId, "game", storagePath, bytes, options.dataDir);
      extractedApkPaths.add(entry.name);
      extractedGameRecords.push({
        logicalId: `apk:optional:${storagePath.toLowerCase()}`,
        category: "game",
        storagePath,
        runtimeUrl: `/${storagePath}`,
        sha256: hash,
        size: bytes.length,
        required: false,
        feature: prefixSpec.description,
        matchedBy: "apk-whitelist",
        originalFilename: relSubPath,
        importedAt: now,
      });
      break;
    }
  }

  const manifest = computeBuildManifest(build, {
    installedAt: existingManifest?.installedAt ?? now,
    apk: {
      sha256: apkSha256,
      versionName: versionName ?? build.apkMetadata?.expectedVersionName ?? "1.4.7",
      packageName: packageName ?? build.apkMetadata?.expectedPackageName ?? "air.mogobe.mogoTab.IL",
      clientAppVer: build.apkMetadata?.clientAppVer ?? "1.0.0",
      recognized: true,
      matchedBy,
    },
    recognizedAssets: [...extractedGameRecords, ...preservedExternal],
  }, { dataDir: options.dataDir });

  writeBuildManifest(manifest, options.dataDir);

  return {
    ok: true,
    buildId: build.buildId,
    displayName: build.displayName,
    matchedBy,
    apkSha256,
    extractedCount: extractedGameRecords.length,
    hashMismatches,
    manifest,
  };
}

export function importApkFile(
  apkFilePath: string,
  options: { dataDir?: string; limits?: ZipSafetyLimits; strictHashes?: boolean } = {},
): ApkImportResult {
  const buf = readFileSync(apkFilePath);
  return importApkBuffer(buf, options);
}
