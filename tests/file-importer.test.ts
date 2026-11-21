import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalDirectory, importExternalFiles } from "../src/importer/file-importer.ts";
import { readRevisionsRecord } from "../src/storage/revisions-store.ts";
import {
  buildSyntheticSupportedApk,
  makeSyntheticLanguageXml,
  makeSyntheticMapPopupSwf,
  makeSyntheticMp3,
  makeSyntheticSwf,
} from "./synthetic-fixtures.ts";

function setupInstalledBuild(withLanguage = true): string {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-files-test-"));
  const res = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(res.ok, true);
  if (withLanguage) {
    importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Language/lang.aspx", bytes: makeSyntheticLanguageXml() }],
      { dataDir },
    );
  }
  return dataDir;
}

test("Room 20 bootstrap rule gates Play readiness; other rooms are additive", () => {
  const dataDir = setupInstalledBuild();
  try {
    // Adding Room 70 alone MUST NOT unlock Play
    const r70 = importExternalFiles(
      "20160725-android-1.4.7",
      [
        { relativePath: "Swf/AssetsClean/Rooms/room_70.swf", bytes: makeSyntheticSwf("room70") },
        { relativePath: "Swf/AssetsClean/Rooms/room_70.txt", bytes: Buffer.from("room70=ok") },
      ],
      { dataDir },
    );
    assert.equal(r70.manifest.roomCount, 1);
    assert.equal(r70.manifest.categories.world.ready, false);
    assert.equal(r70.manifest.playReady, false);

    // Adding Room 20 SWF without TXT MUST NOT unlock Play
    const r20SwfOnly = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Swf/AssetsClean/Rooms/room_20.swf", bytes: makeSyntheticSwf("room20") }],
      { dataDir },
    );
    assert.equal(r20SwfOnly.manifest.categories.world.ready, false);
    assert.equal(r20SwfOnly.manifest.playReady, false);

    // Adding Room 20 TXT completes bootstrap -> Play ready!
    const r20Txt = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Swf/AssetsClean/Rooms/room_20.txt", bytes: Buffer.from("room20=ok") }],
      { dataDir },
    );
    assert.equal(r20Txt.manifest.categories.world.ready, true);
    assert.equal(r20Txt.manifest.roomCount, 2);
    assert.equal(r20Txt.manifest.playReady, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Automatic classification across Interface, World, Items, Mini Games, and Unknown skipping", () => {
  const dataDir = setupInstalledBuild();
  try {
    const summary = importExternalFiles(
      "20160725-android-1.4.7",
      [
        // Interface
        { relativePath: "Swf/AssetsClean/ControlPanel/controlPanel.txt", bytes: Buffer.from("effects=Rain,Snow") },
        { relativePath: "Swf/AssetsClean/ControlPanel/Effects/Rain.swf", bytes: makeSyntheticSwf("rain") },
        { relativePath: "Swf/AssetsClean/LoadingScreens/LoadingScreen_1.swf", bytes: makeSyntheticSwf("ls1") },
        // World (Room 20 + music)
        { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
        { relativePath: "Rooms/room_20.txt", bytes: Buffer.from("door=1") },
        { relativePath: "Sound/Rooms/TelAviv.mp3", bytes: makeSyntheticMp3("telaviv") },
        // Items across multiple families
        { relativePath: "Swf/AssetsClean/Items/IconS/109.swf", bytes: makeSyntheticSwf("item109s") },
        { relativePath: "Swf/AssetsClean/Items/IconW/109.swf", bytes: makeSyntheticSwf("item109w") },
        { relativePath: "Swf/AssetsClean/Items/BigItem/200.swf", bytes: makeSyntheticSwf("item200") },
        { relativePath: "Swf/AssetsClean/Items/BtnItem/300.swf", bytes: makeSyntheticSwf("item300") },
        { relativePath: "Swf/AssetsClean/Items/BtnAccessory/400.swf", bytes: makeSyntheticSwf("item400") },
        { relativePath: "Swf/AssetsClean/Items/Cat/500.swf", bytes: makeSyntheticSwf("item500") },
        { relativePath: "Swf/AssetsClean/Items/Gift/600.swf", bytes: makeSyntheticSwf("item600") },
        { relativePath: "Swf/AssetsClean/Items/RoomItem/700.swf", bytes: makeSyntheticSwf("item700") },
        // Mini Games: LifeGuard (no XML needed -> Available) + Falafel (missing XML -> Missing original configuration)
        { relativePath: "Swf/Apps/Games/LifeGuard.swf", bytes: makeSyntheticSwf("lifeguard") },
        { relativePath: "Swf/Assets/Games/Helps/LifeGuardHelp.swf", bytes: makeSyntheticSwf("lghelp") },
        { relativePath: "Swf/Apps/Games/Falafel.swf", bytes: makeSyntheticSwf("falafel") },
        // Unknown files
        { relativePath: "random/notes.pdf", bytes: Buffer.from("%PDF-1.4 synthetic") },
        { relativePath: "vacation.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
      ],
      { dataDir },
    );

    assert.equal(summary.addedByCategory.interface, 3);
    assert.equal(summary.addedByCategory.world, 3);
    assert.equal(summary.addedByCategory.items, 8);
    assert.equal(summary.addedByCategory.miniGames, 3);
    assert.equal(summary.unknownCount, 2);
    assert.deepEqual(summary.unknownFiles, ["random/notes.pdf", "vacation.jpg"]);

    const m = summary.manifest;
    assert.equal(m.playReady, true);
    assert.equal(m.categories.world.roomCount, 1);
    assert.equal(m.categories.world.musicCount, 1);
    assert.equal(m.categories.items.count, 7); // 7 unique item IDs (109 has IconS + IconW)
    assert.equal(m.categories.items.byFamily.IconS, 1);
    assert.equal(m.categories.items.byFamily.RoomItem, 1);

    const lg = m.categories.miniGames.games.find((g) => g.id === "lifeguard");
    const falafel = m.categories.miniGames.games.find((g) => g.id === "falafel");
    assert.equal(lg?.state, "Available");
    assert.equal(falafel?.state, "Missing original configuration");
    assert.equal(m.miniGameCount, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Duplicate handling, conflict ranking, and recursive folder import", () => {
  const dataDir = setupInstalledBuild();
  const folder = mkdtempSync(join(tmpdir(), "localgobe-folder-"));
  try {
    mkdirSync(join(folder, "nested", "Rooms"), { recursive: true });
    writeFileSync(join(folder, "nested", "Rooms", "room_20.swf"), makeSyntheticSwf("room20-v1"));
    writeFileSync(join(folder, "nested", "Rooms", "room_20.txt"), Buffer.from("v1"));

    const first = importExternalDirectory("20160725-android-1.4.7", folder, { dataDir });
    assert.equal(first.addedCount, 2);
    assert.equal(first.duplicateCount, 0);

    // Re-importing same folder -> deterministic duplicates, zero new additions
    const dup = importExternalDirectory("20160725-android-1.4.7", folder, { dataDir });
    assert.equal(dup.addedCount, 0);
    assert.equal(dup.duplicateCount, 2);

    // Different bytes claiming room_20.swf -> preserved as another historical revision, never conflict
    const anotherRev20 = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "room_20.swf", bytes: makeSyntheticSwf("room20-different") }],
      { dataDir },
    );
    assert.equal(anotherRev20.addedCount, 1);
    assert.equal(anotherRev20.conflictCount, 0);
    assert.equal(anotherRev20.items[0].status, "added");
    const rec20 = readRevisionsRecord("20160725-android-1.4.7", "world", "Rooms", 20, dataDir);
    assert.ok(rec20);
    assert.equal(Object.keys(rec20.revisions).length, 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Arbitrary room import matrix: Room 110 canonical, nested, archival suffix, incomplete pairing, and 3-room count", () => {
  const dataDir = setupInstalledBuild();
  try {
    // 1. room_110.swf only -> recognized as incomplete (NOT unknown)
    const r110SwfOnly = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "room_110_20150809221546_80976ff5.swf", bytes: makeSyntheticSwf("room110-v1") }],
      { dataDir },
    );
    assert.equal(r110SwfOnly.addedCount, 1);
    assert.equal(r110SwfOnly.unknownCount, 0);
    const rec110Partial = r110SwfOnly.manifest.categories.world.rooms.find((r) => r.roomId === 110);
    assert.ok(rec110Partial);
    assert.equal(rec110Partial.hasSwf, true);
    assert.equal(rec110Partial.hasTxt, false);
    assert.equal(rec110Partial.ready, false);
    assert.equal(r110SwfOnly.manifest.roomCount, 0);

    // 2. Matching archival room_110 TXT completes Room 110
    const r110Txt = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "by-room-id/110/room_110_20150809221546_70f82c71.txt", bytes: Buffer.from('{"mov":[]}') }],
      { dataDir },
    );
    assert.equal(r110Txt.addedCount, 1);
    const rec110Ready = r110Txt.manifest.categories.world.rooms.find((r) => r.roomId === 110);
    assert.equal(rec110Ready?.ready, true);
    assert.equal(r110Txt.manifest.roomCount, 1);
    assert.equal(r110Txt.manifest.playReady, false); // Room 20 still required for Play!

    // 3. room_70.txt only -> recognized incomplete, then completed by nested/Rooms/room_70.swf
    const r70TxtOnly = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "room_70.txt", bytes: Buffer.from('{"mov":[]}') }],
      { dataDir },
    );
    assert.equal(r70TxtOnly.addedCount, 1);
    assert.equal(r70TxtOnly.manifest.categories.world.rooms.find((r) => r.roomId === 70)?.ready, false);

    // 4. Add nested Room 70 SWF + Room 20 pair -> 3 usable rooms and Play becomes ready
    const rest = importExternalFiles(
      "20160725-android-1.4.7",
      [
        { relativePath: "nested/Rooms/room_70.swf", bytes: makeSyntheticSwf("room70") },
        { relativePath: "nested/Rooms/room_20.swf", bytes: makeSyntheticSwf("room20") },
        { relativePath: "nested/Rooms/room_20.txt", bytes: Buffer.from('{"mov":[]}') },
      ],
      { dataDir },
    );
    assert.equal(rest.manifest.roomCount, 3);
    assert.equal(rest.manifest.playReady, true);

    // 5. Duplicate Room 110 does not create a duplicate room
    const dup110 = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "nested/Rooms/room_110.swf", bytes: makeSyntheticSwf("room110-v1") }],
      { dataDir },
    );
    assert.equal(dup110.duplicateCount, 1);
    assert.equal(dup110.manifest.roomCount, 3);

    // 6. Multiple historical revisions are preserved in revisions store, never conflict
    const revCanonical110 = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Rooms/room_110.swf", bytes: makeSyntheticSwf("room110-canonical") }],
      { dataDir },
    );
    assert.equal(revCanonical110.addedCount, 1);

    const rev2017110 = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "room_110_20170330110240_fdab7a1c.swf", bytes: makeSyntheticSwf("room110-other") }],
      { dataDir },
    );
    assert.equal(rev2017110.addedCount, 1);
    assert.equal(rev2017110.conflictCount, 0);
    assert.equal(rev2017110.items[0].status, "added");
    const rec110 = readRevisionsRecord("20160725-android-1.4.7", "world", "Rooms", 110, dataDir);
    assert.ok(rec110);
    assert.equal(Object.keys(rec110.revisions).length >= 2, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Smart asset intake: 4 confidence tiers, popup family, inert unclassified storage, and mini-game decoupling", () => {
  const dataDir = setupInstalledBuild();
  try {
    const importRes = importExternalFiles(
      "20160725-android-1.4.7",
      [
        // KNOWN_PATTERN: Popups family
        { relativePath: "Popups/p_3.swf", bytes: makeSyntheticMapPopupSwf() },
        { relativePath: "popup_12.swf", bytes: makeSyntheticSwf("popup-12") },
        // PROBABLE_MOGOBE: Unnamed valid SWF & MP3 without known routing
        { relativePath: "mystery/unnamed_banner.swf", bytes: makeSyntheticSwf("unnamed-banner") },
        { relativePath: "ambient_soundtrack.mp3", bytes: makeSyntheticMp3("mystery-audio") },
        // INVALID_OR_UNRELATED: Corrupted / Non-Mogobe
        { relativePath: "manual.pdf", bytes: Buffer.from("%PDF-1.5 non-game doc") },
        { relativePath: "avatar.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      { dataDir },
    );

    // 1. Popups recognized into interface category
    assert.equal(importRes.addedByCategory.interface, 2);
    const p3 = importRes.manifest.recognizedAssets.find((a) => a.logicalId === "interface:popup-3");
    assert.ok(p3);
    assert.equal(p3.storagePath, "Popups/p_3.swf");
    assert.equal(p3.runtimeUrl, "/Swf/AssetsClean/Popups/p_3.swf");

    const p12 = importRes.manifest.recognizedAssets.find((a) => a.logicalId === "interface:popup-12");
    assert.ok(p12);
    assert.equal(p12.storagePath, "Popups/p_12.swf");

    // 2. Probable Mogobe files saved inertly to unclassified/
    assert.equal(importRes.unclassifiedCount, 2);
    assert.equal(importRes.unclassifiedFiles.length, 2);
    assert.ok(importRes.manifest.unclassifiedAssets);
    assert.equal(importRes.manifest.unclassifiedAssets.length, 2);

    const unclassSwf = importRes.manifest.unclassifiedAssets.find((u) => u.originalFilename === "unnamed_banner.swf");
    assert.ok(unclassSwf);
    assert.equal(unclassSwf.detectedType, "swf");
    assert.equal(unclassSwf.confidence, "PROBABLE_MOGOBE");

    const unclassMp3 = importRes.manifest.unclassifiedAssets.find((u) => u.originalFilename === "ambient_soundtrack.mp3");
    assert.ok(unclassMp3);
    assert.equal(unclassMp3.detectedType, "mp3");
    assert.equal(unclassMp3.confidence, "PROBABLE_MOGOBE");

    // 3. Only the non-Mogobe files are in unknownFiles
    assert.equal(importRes.unknownCount, 2);
    assert.deepEqual(importRes.unknownFiles, ["manual.pdf", "avatar.png"]);

    // 4. Mini-game catalog decoupling: without any mini-game files, games array is empty []
    assert.equal(importRes.manifest.categories.miniGames.games.length, 0);
    assert.equal(importRes.manifest.categories.miniGames.availableCount, 0);

    // 5. Add one mini-game: LifeGuard.swf -> only LifeGuard appears in games array
    const oneGameRes = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Swf/Apps/Games/LifeGuard.swf", bytes: makeSyntheticSwf("lifeguard") }],
      { dataDir },
    );
    assert.equal(oneGameRes.manifest.categories.miniGames.games.length, 1);
    assert.equal(oneGameRes.manifest.categories.miniGames.games[0].id, "lifeguard");
    assert.equal(oneGameRes.manifest.categories.miniGames.games[0].state, "Available");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
