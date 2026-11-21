import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalFiles } from "../src/importer/file-importer.ts";
import { deleteInstalledBuild, readBuildManifest } from "../src/storage/build-store.ts";
import { getCategoryDir } from "../src/storage/paths.ts";
import {
  buildSyntheticSupportedApk,
  buildSyntheticZip,
  makeSyntheticLanguageXml,
  makeSyntheticSwf,
} from "./synthetic-fixtures.ts";

function makeTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "localgobe-apk-test-"));
}

test("APK importer recognizes Mogobe Android 1.4.7 and extracts only whitelisted assets", () => {
  const dataDir = makeTempDataDir();
  try {
    const apkBuf = buildSyntheticSupportedApk();
    const res = importApkBuffer(apkBuf, { dataDir });
    assert.equal(res.ok, true);
    assert.equal(res.buildId, "20160725-android-1.4.7");
    assert.equal(res.displayName, "Mogobe Android 1.4.7");
    assert.equal(res.manifest.categories.game.ready, true);
    // Play should still be false until Room 20 is added
    assert.equal(res.manifest.playReady, false);
    assert.equal(res.manifest.categories.world.ready, false);

    // Non-whitelisted Android files MUST NOT be extracted
    const gameDir = getCategoryDir("20160725-android-1.4.7", "game", dataDir);
    assert.equal(existsSync(join(gameDir, "classes.dex")), false);
    assert.equal(existsSync(join(gameDir, "lib")), false);
    assert.equal(existsSync(join(gameDir, "res")), false);

    // Whitelisted assets MUST exist
    assert.equal(existsSync(join(gameDir, "MogobeTabIL.swf")), true);
    assert.equal(existsSync(join(gameDir, "Swf", "Assets", "LoginGR.swf")), true);
    assert.equal(existsSync(join(gameDir, "Swf", "Assets", "Popups", "p_3.swf")), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("APK importer rejects unsupported APK versions cleanly", () => {
  const dataDir = makeTempDataDir();
  try {
    const unsupportedXml = `<application><id>com.example.other</id><versionNumber>2.0.0</versionNumber></application>`;
    const apk = buildSyntheticZip([
      { name: "assets/META-INF/AIR/application.xml", data: Buffer.from(unsupportedXml, "utf8") },
    ]);
    const res = importApkBuffer(apk, { dataDir });
    assert.equal(res.ok, false);
    assert.equal(res.code, "UNSUPPORTED_APK");
    assert.equal(res.userMessage, "This Mogobe version is not supported yet.");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("APK importer enforces strict hash mismatch rejection when enabled", () => {
  const dataDir = makeTempDataDir();
  try {
    const apkBuf = buildSyntheticSupportedApk();
    const res = importApkBuffer(apkBuf, { dataDir, strictHashes: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, "HASH_MISMATCH");
    assert.equal(res.userMessage, "This file isn't the version LocalGobe expected.");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("APK importer blocks zip-slip path traversal and symlink entries", () => {
  const dataDir = makeTempDataDir();
  try {
    const zipSlip = buildSyntheticZip([
      { name: "../../../evil.txt", data: Buffer.from("pwned") },
    ]);
    const slipRes = importApkBuffer(zipSlip, { dataDir });
    assert.equal(slipRes.ok, false);
    assert.equal(slipRes.code, "SECURITY_VIOLATION");

    const symlinkZip = buildSyntheticZip([
      { name: "assets/link.swf", data: Buffer.from("/etc/passwd"), isSymlink: true },
    ]);
    const linkRes = importApkBuffer(symlinkZip, { dataDir });
    assert.equal(linkRes.ok, false);
    assert.equal(linkRes.code, "SECURITY_VIOLATION");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("APK importer enforces oversized entry extraction limit", () => {
  const dataDir = makeTempDataDir();
  try {
    const apkBuf = buildSyntheticSupportedApk();
    const res = importApkBuffer(apkBuf, {
      dataDir,
      limits: { maxEntries: 1000, maxEntryBytes: 10, maxTotalExtractBytes: 100 },
    });
    assert.equal(res.ok, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("APK re-import is idempotent and preserves external assets; deletion and re-import works cleanly", () => {
  const dataDir = makeTempDataDir();
  try {
    const apkBuf = buildSyntheticSupportedApk();
    const first = importApkBuffer(apkBuf, { dataDir });
    assert.equal(first.ok, true);

    // Add Room 20
    importExternalFiles(
      "20160725-android-1.4.7",
      [
        { relativePath: "Swf/AssetsClean/Rooms/room_20.swf", bytes: makeSyntheticSwf("room20") },
        { relativePath: "Swf/AssetsClean/Rooms/room_20.txt", bytes: Buffer.from("x=100,y=100", "utf8") },
        { relativePath: "Language/lang.aspx", bytes: makeSyntheticLanguageXml() },
      ],
      { dataDir },
    );

    // Re-import APK: Room 20 must remain intact
    const second = importApkBuffer(apkBuf, { dataDir });
    assert.equal(second.ok, true);
    assert.equal(second.manifest.playReady, true);
    assert.equal(second.manifest.roomCount, 1);

    // Delete build and verify clean removal
    assert.equal(deleteInstalledBuild("20160725-android-1.4.7", dataDir), true);
    assert.equal(readBuildManifest("20160725-android-1.4.7", dataDir), null);

    // Re-import fresh after deletion
    const third = importApkBuffer(apkBuf, { dataDir });
    assert.equal(third.ok, true);
    assert.equal(third.manifest.roomCount, 0);
    assert.equal(third.manifest.playReady, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
