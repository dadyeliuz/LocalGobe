import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentCategory } from "../builds/types.ts";

function findProjectRoot(): string {
  if (process.env.LOCALGOBE_PROJECT_ROOT) {
    return resolve(process.env.LOCALGOBE_PROJECT_ROOT);
  }
  let curr = resolve(fileURLToPath(new URL(".", import.meta.url)));
  for (let i = 0; i < 5; i++) {
    const pkgPath = join(curr, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "localgobe") return curr;
      } catch {
        // ignore parse error and keep walking up
      }
    }
    const parent = resolve(curr, "..");
    if (parent === curr) break;
    curr = parent;
  }
  return resolve(fileURLToPath(new URL("../../", import.meta.url)));
}

const PROJECT_ROOT = findProjectRoot();

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function getDataRoot(customDataDir?: string): string {
  if (customDataDir) return resolve(customDataDir);
  if (process.env.LOCALGOBE_DATA_DIR) return resolve(process.env.LOCALGOBE_DATA_DIR);
  return resolve(PROJECT_ROOT, "data");
}

export function getBuildsRoot(dataDir?: string): string {
  return resolve(getDataRoot(dataDir), "builds");
}

export function getBuildDir(buildId: string, dataDir?: string): string {
  const safeId = assertSafeSegment(buildId, "buildId");
  return resolve(getBuildsRoot(dataDir), safeId);
}

export function getBuildManifestPath(buildId: string, dataDir?: string): string {
  return resolve(getBuildDir(buildId, dataDir), "build.json");
}

const CATEGORY_DIR_MAP: Readonly<Record<ContentCategory, string>> = Object.freeze({
  game: "game",
  interface: "interface",
  world: "world",
  items: "items",
  miniGames: "mini-games",
});

export function getCategoryDir(buildId: string, category: ContentCategory, dataDir?: string): string {
  return resolve(getBuildDir(buildId, dataDir), CATEGORY_DIR_MAP[category]);
}

export function getRuntimeRoot(dataDir?: string): string {
  return resolve(getDataRoot(dataDir), "runtime");
}

export function getRuffleDistDir(dataDir?: string): string {
  if (process.env.LOCALGOBE_RUFFLE_DIST) return resolve(process.env.LOCALGOBE_RUFFLE_DIST);
  return resolve(getRuntimeRoot(dataDir), "ruffle");
}

export function getAirShimsDir(dataDir?: string): string {
  if (process.env.LOCALGOBE_AIR_SHIMS_DIR) return resolve(process.env.LOCALGOBE_AIR_SHIMS_DIR);
  return resolve(getRuntimeRoot(dataDir), "air");
}

export function getRuntimeFontsDir(dataDir?: string): string {
  if (process.env.LOCALGOBE_FONTS_DIR) return resolve(process.env.LOCALGOBE_FONTS_DIR);
  return resolve(getRuntimeRoot(dataDir), "fonts");
}

export function getUnclassifiedDir(buildId: string, dataDir?: string): string {
  return resolve(getBuildDir(buildId, dataDir), "unclassified");
}

export function getTmpDir(dataDir?: string): string {
  return resolve(getDataRoot(dataDir), "tmp");
}

export function assertSafeSegment(segment: string, label: string): string {
  if (!segment || !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
    throw new Error(`Unsafe ${label}: ${segment}`);
  }
  return segment;
}

/**
 * Resolves a relative forward-slash path inside a base directory, rejecting any
 * path traversal, drive letters, null bytes, or escape outside baseDir.
 */
export function resolveInsideDir(baseDir: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\")) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const normalized = relativePath.replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === "." || p === ".." || p.includes(":"))) {
    throw new Error(`Unsafe relative path segments: ${relativePath}`);
  }
  const resolvedBase = resolve(baseDir);
  const full = resolve(resolvedBase, ...parts);
  if (!full.startsWith(resolvedBase + sep)) {
    throw new Error(`Path escapes base directory: ${relativePath}`);
  }
  return full;
}
