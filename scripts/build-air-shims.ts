import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAirShimsDir, getProjectRoot } from "../src/storage/paths.ts";
import { getAirShimsStatus } from "../src/compatibility/air/air-shims.ts";

export const TOOLCHAIN_ASSETS_COMMIT_SHA = "a7d418d26538b232e3fb2da3646b23146f78173a";
export const ASC_JAR_URL = `https://raw.githubusercontent.com/dadyeliuz/LocalGobe/${TOOLCHAIN_ASSETS_COMMIT_SHA}/asc.jar`;
export const ASC_JAR_SHA256 = "4dc2aef13198cfa0692b2f2dda3cce10890277066d7c5aa2ac3e9c9f9a2c462e";
export const PLAYERGLOBAL_ABC_URL = `https://raw.githubusercontent.com/dadyeliuz/LocalGobe/${TOOLCHAIN_ASSETS_COMMIT_SHA}/playerglobal_import.abc`;
export const PLAYERGLOBAL_ABC_SHA256 = "3c402028d02037f5eee0e988fec8a7c12fb889457094fcf7f7c3bb1cbddddc97";

function fileMatchesHash(filePath: string, expectedHash: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const data = readFileSync(filePath);
    return createHash("sha256").update(data).digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, dest: string, expectedSha256: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actualHash = createHash("sha256").update(buf).digest("hex");
  if (actualHash !== expectedSha256) {
    throw new Error(
      `SHA-256 hash mismatch for ${url}:\n  Expected: ${expectedSha256}\n  Actual:   ${actualHash}`,
    );
  }
  writeFileSync(dest, buf);
}

export async function ensureAscToolchain(): Promise<{ ascJar: string; playerglobalAbc: string }> {
  let ascJar = process.env.LOCALGOBE_ASC_JAR || process.env.ASC_JAR;
  let playerglobal = process.env.LOCALGOBE_PLAYERGLOBAL_ABC || process.env.PLAYERGLOBAL_ABC;

  if (ascJar && fileMatchesHash(ascJar, ASC_JAR_SHA256) && playerglobal && fileMatchesHash(playerglobal, PLAYERGLOBAL_ABC_SHA256)) {
    return { ascJar, playerglobalAbc: playerglobal };
  }

  const cacheDir = join(tmpdir(), "localgobe-asc-toolchain");
  mkdirSync(cacheDir, { recursive: true });

  if (!ascJar || !fileMatchesHash(ascJar, ASC_JAR_SHA256)) {
    ascJar = join(cacheDir, "asc.jar");
    if (!fileMatchesHash(ascJar, ASC_JAR_SHA256)) {
      console.log(`Downloading Apache Flex ASC jar from ${ASC_JAR_URL}...`);
      await downloadFile(ASC_JAR_URL, ascJar, ASC_JAR_SHA256);
      console.log(`Saved ${ascJar}`);
    }
  }

  if (!playerglobal || !fileMatchesHash(playerglobal, PLAYERGLOBAL_ABC_SHA256)) {
    playerglobal = join(cacheDir, "playerglobal_import.abc");
    if (!fileMatchesHash(playerglobal, PLAYERGLOBAL_ABC_SHA256)) {
      console.log(`Downloading playerglobal_import.abc from ${PLAYERGLOBAL_ABC_URL}...`);
      await downloadFile(PLAYERGLOBAL_ABC_URL, playerglobal, PLAYERGLOBAL_ABC_SHA256);
      console.log(`Saved ${playerglobal}`);
    }
  }

  return { ascJar, playerglobalAbc: playerglobal };
}

function encodeRect(xminTwips: number, xmaxTwips: number, yminTwips: number, ymaxTwips: number): Buffer {
  const nbits = 15;
  let bits = nbits.toString(2).padStart(5, "0");
  for (const v of [xminTwips, xmaxTwips, yminTwips, ymaxTwips]) {
    bits += (v >>> 0).toString(2).padStart(nbits, "0");
  }
  while (bits.length % 8 !== 0) bits += "0";
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return out;
}

/**
 * Wraps one or more AVM2 ABC bytecode buffers into a minimal valid uncompressed FWS SWF (version 32).
 */
function wrapAbcsAsSwf(abcBuffers: Buffer[], documentClass?: string): Buffer {
  const tags: Buffer[] = [];

  // Tag 69: FileAttributes (ActionScript3 = 0x08, UseNetwork = 0x01)
  tags.push(makeTag(69, Buffer.from([0x09, 0x00, 0x00, 0x00])));

  // Tag 82: DoABC for each ABC module
  for (let i = 0; i < abcBuffers.length; i++) {
    const doAbcHeader = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from(`localgobe_${i}\0`, "utf8"),
    ]);
    tags.push(makeTag(82, Buffer.concat([doAbcHeader, abcBuffers[i]])));
  }

  // Tag 76: SymbolClass (if a root document class is specified)
  if (documentClass) {
    const clsBytes = Buffer.from(`${documentClass}\0`, "utf8");
    const symPayload = Buffer.alloc(4 + clsBytes.length);
    symPayload.writeUInt16LE(1, 0);
    symPayload.writeUInt16LE(0, 2);
    clsBytes.copy(symPayload, 4);
    tags.push(makeTag(76, symPayload));
  }

  // Tag 1: ShowFrame, Tag 0: End
  tags.push(makeTag(1, Buffer.alloc(0)));
  tags.push(makeTag(0, Buffer.alloc(0)));

  const rect = encodeRect(0, 768 * 20, 0, 480 * 20);
  const frameRate = Buffer.from([0x00, 0x18]);
  const frameCount = Buffer.from([0x01, 0x00]);
  const body = Buffer.concat([rect, frameRate, frameCount, ...tags]);

  const header = Buffer.alloc(8);
  header.write("FWS", 0, "ascii");
  header[3] = 32;
  header.writeUInt32LE(8 + body.length, 4);

  return Buffer.concat([header, body]);
}

function makeTag(code: number, payload: Buffer): Buffer {
  if (payload.length < 63) {
    const hdr = Buffer.alloc(2);
    hdr.writeUInt16LE((code << 6) | payload.length, 0);
    return Buffer.concat([hdr, payload]);
  }
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE((code << 6) | 0x3f, 0);
  hdr.writeUInt32LE(payload.length, 2);
  return Buffer.concat([hdr, payload]);
}

function compileAs3(ascJar: string, sourceFile: string, imports: string[]): Buffer {
  const args = ["-jar", ascJar, "-AS3"];
  for (const imp of imports) {
    if (imp && existsSync(imp)) args.push("-import", imp);
  }
  args.push(sourceFile);
  const res = spawnSync("java", args, { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`asc.jar failed compiling ${sourceFile}`);
  }
  const abcPath = sourceFile.replace(/\.as$/, ".abc");
  return readFileSync(abcPath);
}

export async function buildAirShims(options: { allowExisting?: boolean } = {}): Promise<void> {
  const outDir = getAirShimsDir();
  const as3Dir = resolve(getProjectRoot(), "src", "compatibility", "air", "as3");
  mkdirSync(outDir, { recursive: true });

  const status = getAirShimsStatus();
  if (options.allowExisting !== false && status.ready) {
    console.log(`AIR shims already present in ${status.directory}.`);
    return;
  }

  const { ascJar, playerglobalAbc } = await ensureAscToolchain();
  const baseImports = [playerglobalAbc];
  const tempAbcs: string[] = [];

  try {
    // 1. StageTextInitOptions
    const stoSrc = join(as3Dir, "StageTextInitOptions.as");
    const stoAbc = compileAs3(ascJar, stoSrc, baseImports);
    tempAbcs.push(stoSrc.replace(/\.as$/, ".abc"));
    const stoSwf = wrapAbcsAsSwf([stoAbc]);
    writeFileSync(join(outDir, "stage_text_init_options_shim.swf"), stoSwf);
    console.log(`Built stage_text_init_options_shim.swf (${stoSwf.length} bytes)`);

    // 2. StageText
    const stSrc = join(as3Dir, "StageText.as");
    const stAbc = compileAs3(ascJar, stSrc, baseImports);
    tempAbcs.push(stSrc.replace(/\.as$/, ".abc"));
    const stSwf = wrapAbcsAsSwf([stAbc]);
    writeFileSync(join(outDir, "stage_text_shim.swf"), stSwf);
    console.log(`Built stage_text_shim.swf (${stSwf.length} bytes)`);

    // 3. NativeNetworkInterface + AirNetworkInfo
    const nniSrc = join(as3Dir, "NativeNetworkInterface.as");
    const nniAbc = compileAs3(ascJar, nniSrc, baseImports);
    const nniAbcPath = nniSrc.replace(/\.as$/, ".abc");
    tempAbcs.push(nniAbcPath);

    const aniSrc = join(as3Dir, "AirNetworkInfo.as");
    const aniAbc = compileAs3(ascJar, aniSrc, [...baseImports, nniAbcPath]);
    tempAbcs.push(aniSrc.replace(/\.as$/, ".abc"));
    const aniSwf = wrapAbcsAsSwf([nniAbc, aniAbc]);
    writeFileSync(join(outDir, "air_network_info_shim.swf"), aniSwf);
    console.log(`Built air_network_info_shim.swf (${aniSwf.length} bytes)`);

    // 4. AirBootstrap
    const bootSrc = join(as3Dir, "AirBootstrap.as");
    const bootAbc = compileAs3(ascJar, bootSrc, baseImports);
    tempAbcs.push(bootSrc.replace(/\.as$/, ".abc"));
    const bootSwf = wrapAbcsAsSwf([bootAbc], "AirBootstrap");
    writeFileSync(join(outDir, "AirBootstrap.swf"), bootSwf);
    console.log(`Built AirBootstrap.swf (${bootSwf.length} bytes)`);
  } finally {
    for (const p of tempAbcs) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          // ignore cleanup
        }
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void buildAirShims().catch((err) => {
    console.error("AIR shim build failed:", err);
    process.exit(1);
  });
}
