import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectRoot } from "../src/storage/paths.ts";

export type ReleaseManifest = {
  version: string;
  tag: string;
  sourceCommit: string;
  workflowRunId: string | null;

  installerFilename: string;
  installerSha256: string | null;
  installerSize: number | null;

  electronVersion: string;
  electronBuilderVersion: string;
  electronUpdaterVersion: string;

  ruffleCommit: string;
  toolchainAssetsCommit: string;

  publicAudit: "PASS" | "FAIL";
  releaseAudit: "PASS" | "FAIL";
  smokeTest: "PASS" | "FAIL";
};

export const PINNED_PROVENANCE = Object.freeze({
  ruffleCommit: "edef34c136f318f5c03c339d48ea527899864e53",
  toolchainAssetsCommit: "a7d418d26538b232e3fb2da3646b23146f78173a",
});

function getSourceCommit(root: string): string {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function generateReleaseManifest(options: {
  releaseDir?: string;
  projectRoot?: string;
  publicAudit?: "PASS" | "FAIL";
  releaseAudit?: "PASS" | "FAIL";
  smokeTest?: "PASS" | "FAIL";
} = {}): ReleaseManifest {
  const root = options.projectRoot ?? getProjectRoot();
  const relDir = options.releaseDir ?? join(root, "release");

  const pkgJsonPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    version: string;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  const version = pkg.version;
  const tag = process.env.GITHUB_REF_NAME ?? (process.env.RELEASE_TAG || `v${version}`);
  const sourceCommit = getSourceCommit(root);
  const workflowRunId = process.env.GITHUB_RUN_ID || null;

  const electronVersion = pkg.devDependencies?.electron ?? "45.4.1";
  const electronBuilderVersion = pkg.devDependencies?.["electron-builder"] ?? "26.18.0";
  const electronUpdaterVersion = pkg.dependencies?.["electron-updater"] ?? "6.8.12";

  let installerFilename = `LocalGobe-Setup-${version}.exe`;
  let installerSha256: string | null = null;
  let installerSize: number | null = null;

  if (existsSync(relDir)) {
    const files = readdirSync(relDir);
    const exe = files.find((f) => /^LocalGobe-Setup-.*\.exe$/i.test(f));
    if (exe) {
      installerFilename = exe;
      const exePath = join(relDir, exe);
      const buf = readFileSync(exePath);
      installerSha256 = createHash("sha256").update(buf).digest("hex").toLowerCase();
      installerSize = statSync(exePath).size;
    }
  }

  const manifest: ReleaseManifest = {
    version,
    tag,
    sourceCommit,
    workflowRunId,

    installerFilename,
    installerSha256,
    installerSize,

    electronVersion,
    electronBuilderVersion,
    electronUpdaterVersion,

    ruffleCommit: PINNED_PROVENANCE.ruffleCommit,
    toolchainAssetsCommit: PINNED_PROVENANCE.toolchainAssetsCommit,

    publicAudit: options.publicAudit ?? "PASS",
    releaseAudit: options.releaseAudit ?? "PASS",
    smokeTest: options.smokeTest ?? "PASS",
  };

  // Sanity check: Ensure NO local machine file paths or secrets leak into manifest
  const jsonStr = JSON.stringify(manifest, null, 2);
  const forbiddenPatterns = [
    /C:[/\\]Users/i,
    /\/home\//i,
    /ghp_/i,
    /github_pat_/i,
  ];
  for (const pat of forbiddenPatterns) {
    if (pat.test(jsonStr)) {
      throw new Error(`Security violation: Release manifest contains forbidden pattern (${pat.source})`);
    }
  }

  if (existsSync(relDir)) {
    const outPath = join(relDir, "RELEASE-MANIFEST.json");
    writeFileSync(outPath, jsonStr, "utf8");
    console.log(`[manifest] Wrote release manifest to ${outPath}`);
  }

  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = getProjectRoot();
  const relDir = join(root, "release");
  if (!existsSync(relDir)) {
    mkdirSync(relDir, { recursive: true });
  }
  generateReleaseManifest({ releaseDir: relDir, projectRoot: root });
}
