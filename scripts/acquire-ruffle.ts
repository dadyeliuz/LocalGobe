import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectRoot, getRuffleDistDir } from "../src/storage/paths.ts";

export const RUFFLE_UPSTREAM_REPOSITORY = "https://github.com/ruffle-rs/ruffle.git";
export const RUFFLE_UPSTREAM_COMMIT_SHA = "edef34c136f318f5c03c339d48ea527899864e53";
export const TOOLCHAIN_ASSETS_COMMIT_SHA = "a7d418d26538b232e3fb2da3646b23146f78173a";
export const RUFFLE_ARCHIVE_URL = `https://raw.githubusercontent.com/dadyeliuz/LocalGobe/${TOOLCHAIN_ASSETS_COMMIT_SHA}/ruffle-selfhosted.tar.gz`;
export const RUFFLE_ARCHIVE_SHA256 = "86493bca32b106a04d01b9ebe592c971d4ddaa0b15750219f138abf0f24f1aad";
export const RUST_TOOLCHAIN = "1.96.0";
export const WASM_BINDGEN_VERSION = "0.2.127";
export const NODE_VERSION = "24.x";

export type RuffleAcquisitionOptions = {
  outDir?: string;
  sourceDir?: string;
  allowExisting?: boolean;
};

export function verifyRuffleBundle(ruffleDir: string): { valid: boolean; files: string[]; error?: string } {
  if (!existsSync(ruffleDir) || !statSync(ruffleDir).isDirectory()) {
    return { valid: false, files: [], error: `Directory does not exist: ${ruffleDir}` };
  }
  const files = readdirSync(ruffleDir);
  const hasRuffleJs = files.includes("ruffle.js");
  const hasWasm = files.some((f) => f.endsWith(".wasm"));
  const hasCoreJs = files.some((f) => f.startsWith("core.ruffle.") && f.endsWith(".js"));

  if (!hasRuffleJs) {
    return { valid: false, files, error: "Missing ruffle.js in bundle" };
  }
  if (!hasWasm) {
    return { valid: false, files, error: "Missing Ruffle WebAssembly (.wasm) binary in bundle" };
  }
  if (!hasCoreJs) {
    return { valid: false, files, error: "Missing core.ruffle.*.js loader in bundle" };
  }

  return { valid: true, files };
}

export async function acquireOrBuildRuffle(options: RuffleAcquisitionOptions = {}): Promise<string> {
  const outDir = options.outDir ? resolve(options.outDir) : getRuffleDistDir();
  mkdirSync(outDir, { recursive: true });

  const existingVerification = verifyRuffleBundle(outDir);
  if (options.allowExisting !== false && existingVerification.valid) {
    console.log(`Ruffle selfhosted runtime already valid in ${outDir}`);
    console.log(`  Upstream commit: ${RUFFLE_UPSTREAM_COMMIT_SHA}`);
    console.log(`  Rust toolchain:  ${RUST_TOOLCHAIN}`);
    console.log(`  wasm-bindgen:    ${WASM_BINDGEN_VERSION}`);
    return outDir;
  }

  console.log("Reproducible Ruffle Build Specifications:");
  console.log(`  Repository:   ${RUFFLE_UPSTREAM_REPOSITORY}`);
  console.log(`  Commit SHA:   ${RUFFLE_UPSTREAM_COMMIT_SHA}`);
  console.log(`  Rust:         ${RUST_TOOLCHAIN} (target wasm32-unknown-unknown)`);
  console.log(`  wasm-bindgen: ${WASM_BINDGEN_VERSION}`);
  console.log(`  Node.js:      ${NODE_VERSION}`);
  console.log(`  Output:       ${outDir}`);

  // 1. If a local source directory with built dist is provided or found in workspace
  const candidateDirs = [
    options.sourceDir,
    process.env.RUFFLE_SOURCE_DIR,
    join(getProjectRoot(), "..", "..", "ruffle-main", "web", "packages", "selfhosted", "dist"),
  ].filter(Boolean) as string[];

  for (const cand of candidateDirs) {
    if (existsSync(cand) && verifyRuffleBundle(cand).valid) {
      console.log(`Copying built Ruffle binaries from verified source: ${cand}`);
      const copyRes = spawnSync(
        process.platform === "win32" ? "robocopy" : "cp",
        process.platform === "win32" ? [cand, outDir, "*.*", "/E", "/NFL", "/NDL", "/NJH", "/NJS"] : ["-r", `${cand}/*`, outDir],
        { stdio: "inherit" },
      );
      if (process.platform === "win32" && (copyRes.status === 0 || copyRes.status === 1)) {
        const afterCheck = verifyRuffleBundle(outDir);
        if (afterCheck.valid) {
          console.log(`Successfully verified staged Ruffle in ${outDir}`);
          return outDir;
        }
      }
    }
  }

  // 2. Download from verified open-source toolchain archive
  console.log(`Downloading verified Ruffle runtime from ${RUFFLE_ARCHIVE_URL}...`);
  const res = await fetch(RUFFLE_ARCHIVE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download Ruffle runtime archive: ${res.status} ${res.statusText}`);
  }
  const archiveBuf = Buffer.from(await res.arrayBuffer());
  const actualHash = createHash("sha256").update(archiveBuf).digest("hex");
  if (actualHash !== RUFFLE_ARCHIVE_SHA256) {
    throw new Error(
      `SHA-256 hash mismatch for Ruffle toolchain archive:\n  Expected: ${RUFFLE_ARCHIVE_SHA256}\n  Actual:   ${actualHash}`,
    );
  }
  const archivePath = join(tmpdir(), "ruffle-selfhosted.tar.gz");
  writeFileSync(archivePath, archiveBuf);
  try {
    const extractRes = spawnSync("tar", ["-xzf", archivePath, "-C", outDir], { stdio: "inherit" });
    if (extractRes.status !== 0) {
      throw new Error(`tar extraction failed with code ${extractRes.status}`);
    }
    const afterExtract = verifyRuffleBundle(outDir);
    if (!afterExtract.valid) {
      throw new Error(`Extracted Ruffle bundle is invalid: ${afterExtract.error}`);
    }
    console.log(`Successfully acquired and verified Ruffle runtime in ${outDir}`);
    return outDir;
  } finally {
    if (existsSync(archivePath)) {
      try { unlinkSync(archivePath); } catch {}
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void acquireOrBuildRuffle().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
