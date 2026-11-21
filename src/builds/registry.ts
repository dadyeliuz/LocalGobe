import type { BuildDefinition } from "./types.ts";
import { BUILD_20160725_ANDROID_1_4_7 } from "./20160725-android-1.4.7/manifest.ts";

const REGISTERED_BUILDS: readonly BuildDefinition[] = Object.freeze([
  BUILD_20160725_ANDROID_1_4_7,
]);

export function listSupportedBuilds(): readonly BuildDefinition[] {
  return REGISTERED_BUILDS;
}

export function getBuildDefinition(buildId: string): BuildDefinition | undefined {
  return REGISTERED_BUILDS.find((b) => b.buildId === buildId);
}

export function recognizeApkBuild(metadata: {
  sha256: string;
  packageName?: string;
  versionName?: string;
  hasRootSwf?: boolean;
}): { build: BuildDefinition; matchedBy: "sha256" | "air-metadata" } | null {
  const lowerHash = metadata.sha256.toLowerCase();

  // 1. Exact APK SHA-256 match (highest authority)
  for (const build of REGISTERED_BUILDS) {
    if (build.sourceType !== "APK" || !build.apkMetadata) continue;
    if (build.apkMetadata.knownApkHashes.includes(lowerHash)) {
      return { build, matchedBy: "sha256" };
    }
  }

  // 2. AIR descriptor metadata match (for re-signed / repackaged copies of the exact supported build)
  for (const build of REGISTERED_BUILDS) {
    if (build.sourceType !== "APK" || !build.apkMetadata) continue;
    if (
      metadata.packageName === build.apkMetadata.expectedPackageName &&
      metadata.versionName === build.apkMetadata.expectedVersionName &&
      metadata.hasRootSwf
    ) {
      return { build, matchedBy: "air-metadata" };
    }
  }

  return null;
}
