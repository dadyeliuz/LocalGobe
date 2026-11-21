import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalFiles } from "../src/importer/file-importer.ts";
import { handleApiRoute } from "../src/server/http/api-routes.ts";
import { handleGameRoute } from "../src/server/http/game-routes.ts";
import { readBuildManifest, refreshBuildManifest } from "../src/storage/build-store.ts";
import { readRevisionsRecord } from "../src/storage/revisions-store.ts";
import {
  getRoomPlayableRevisions,
  getSelectedRoomRevision,
  resolveRoomRevision,
  setRoomRevisionSelection,
} from "../src/storage/room-resolver.ts";
import { buildSyntheticSupportedApk, makeSyntheticSwf } from "./synthetic-fixtures.ts";

function setupBaseBuild(): { dataDir: string; buildId: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-rev-test-"));
  const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(apkRes.ok, true);
  const buildId = "20160725-android-1.4.7";

  // Base bootstrap room 20
  importExternalFiles(
    buildId,
    [
      { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("room20-base") },
      { relativePath: "Rooms/room_20.txt", bytes: Buffer.from('{"mov":[]}') },
    ],
    { dataDir },
  );

  return { dataDir, buildId };
}

test("Multi-folder drop / import: 7 top-level folders all traversed, logical room = 1, revisions = 7", () => {
  const { dataDir, buildId } = setupBaseBuild();
  try {
    // 7 top-level folders dropped simultaneously, each containing a historical revision of Room 110
    const multiRootFiles = [
      { relativePath: "FolderA/room_110.swf", bytes: makeSyntheticSwf("r110-folder-a") },
      { relativePath: "FolderA/room_110.txt", bytes: Buffer.from('{"folder":"A"}') },

      { relativePath: "FolderB/room_110.swf", bytes: makeSyntheticSwf("r110-folder-b") },
      { relativePath: "FolderB/room_110.txt", bytes: Buffer.from('{"folder":"B"}') },

      { relativePath: "FolderC/room_110.swf", bytes: makeSyntheticSwf("r110-folder-c") },
      { relativePath: "FolderC/room_110.txt", bytes: Buffer.from('{"folder":"C"}') },

      { relativePath: "FolderD/room_110.swf", bytes: makeSyntheticSwf("r110-folder-d") },
      { relativePath: "FolderD/room_110.txt", bytes: Buffer.from('{"folder":"D"}') },

      { relativePath: "FolderE/room_110.swf", bytes: makeSyntheticSwf("r110-folder-e") },
      { relativePath: "FolderE/room_110.txt", bytes: Buffer.from('{"folder":"E"}') },

      { relativePath: "FolderF/room_110.swf", bytes: makeSyntheticSwf("r110-folder-f") },
      { relativePath: "FolderF/room_110.txt", bytes: Buffer.from('{"folder":"F"}') },

      { relativePath: "FolderG/room_110.swf", bytes: makeSyntheticSwf("r110-folder-g") },
      { relativePath: "FolderG/room_110.txt", bytes: Buffer.from('{"folder":"G"}') },
    ];

    const result = importExternalFiles(buildId, multiRootFiles, { dataDir });

    // Zero conflicts! Every folder is preserved as valid historical assets
    assert.equal(result.conflictCount, 0);
    assert.equal(result.addedCount, 14);

    const rec = readRevisionsRecord(buildId, "world", "Rooms", 110, dataDir);
    assert.ok(rec);
    const revKeys = Object.keys(rec.revisions);
    assert.equal(revKeys.length, 7);

    // Provenance preserved for all 7 roots
    assert.ok(rec.revisions["FolderA"]);
    assert.ok(rec.revisions["FolderB"]);
    assert.ok(rec.revisions["FolderC"]);
    assert.ok(rec.revisions["FolderD"]);
    assert.ok(rec.revisions["FolderE"]);
    assert.ok(rec.revisions["FolderF"]);
    assert.ok(rec.revisions["FolderG"]);

    // Manifest room counting: logical room count is 2 (room 20 + room 110), NOT 8!
    const manifest = refreshBuildManifest(buildId, dataDir);
    assert.ok(manifest);
    assert.equal(manifest.categories.world.roomCount, 2);
    assert.equal(manifest.roomCount, 2);
    const room110 = manifest.categories.world.rooms.find((r) => r.roomId === 110);
    assert.ok(room110);
    assert.equal(room110.revisionsCount, 7);
    assert.equal(room110.playableRevisionsCount, 7);
    assert.equal(room110.ready, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Order-invariance: importing folders in reverse order yields identical preserved revisions", () => {
  const runOrder = (roots: string[]) => {
    const { dataDir, buildId } = setupBaseBuild();
    try {
      for (const root of roots) {
        importExternalFiles(
          buildId,
          [
            { relativePath: `${root}/room_110.swf`, bytes: makeSyntheticSwf(`r110-${root}`) },
            { relativePath: `${root}/room_110.txt`, bytes: Buffer.from(`{"src":"${root}"}`) },
          ],
          { dataDir },
        );
      }
      const rec = readRevisionsRecord(buildId, "world", "Rooms", 110, dataDir);
      assert.ok(rec);
      const playable = getRoomPlayableRevisions(buildId, 110, dataDir);
      return {
        keys: Object.keys(rec.revisions).sort(),
        playableKeys: playable.map((p) => p.revisionKey),
        recommended: playable.find((p) => p.isRecommended)?.revisionKey,
      };
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  const forward = runOrder(["2013", "2014", "2015", "2016"]);
  const reverse = runOrder(["2016", "2015", "2014", "2013"]);

  assert.deepEqual(forward.keys, reverse.keys);
  assert.deepEqual(forward.playableKeys, reverse.playableKeys);
  assert.equal(forward.recommended, reverse.recommended);
});

test("Atomic SWF + TXT pairing and dynamic runtime selection", () => {
  const { dataDir, buildId } = setupBaseBuild();
  try {
    // Ingest 2 distinct revisions of Room 110
    importExternalFiles(
      buildId,
      [
        { relativePath: "archive/2013/room_110_20130526000000.swf", bytes: makeSyntheticSwf("swf-2013") },
        { relativePath: "archive/2013/room_110_20130526000000.txt", bytes: Buffer.from('{"year":2013}') },
        { relativePath: "archive/2015/room_110_20150829141022.swf", bytes: makeSyntheticSwf("swf-2015") },
        { relativePath: "archive/2015/room_110_20150829141022.txt", bytes: Buffer.from('{"year":2015}') },
      ],
      { dataDir },
    );

    // 1. By default, recommended revision (20150829141022) is resolved
    const bundleDefault = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(bundleDefault);
    assert.equal(bundleDefault.revisionKey, "20150829141022");
    assert.equal(bundleDefault.selectionMode, "recommended");

    // HTTP serves 2015 SWF + 2015 TXT
    const defaultSwf = handleGameRoute({ url: "/Swf/AssetsClean/Rooms/room_110.swf", buildId, dataDir });
    const defaultTxt = handleGameRoute({ url: "/Swf/AssetsClean/Rooms/room_110.txt", buildId, dataDir });
    assert.ok(defaultSwf && defaultTxt);
    assert.equal(defaultSwf.status, 200);
    assert.equal(defaultTxt.status, 200);
    assert.equal(defaultTxt.body.toString("utf8"), '{"year":2015}');
    assert.equal(defaultSwf.headers?.["Cache-Control"], "no-store, must-revalidate");
    assert.ok(defaultSwf.headers?.["ETag"]);

    // 2. User dynamically selects 2013 revision via API
    const selectRes = handleApiRoute({
      method: "POST",
      pathname: `/api/builds/${buildId}/rooms/110/select-revision`,
      query: new URLSearchParams(),
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ revisionKey: "20130526000000" })),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId: buildId,
      setActiveBuildId: () => {},
    });
    assert.ok(selectRes);
    assert.equal(selectRes.status, 200);

    // Dynamic resolver now immediately resolves 2013
    const bundleSelected = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(bundleSelected);
    assert.equal(bundleSelected.revisionKey, "20130526000000");
    assert.equal(bundleSelected.selectionMode, "selected");

    // HTTP routes immediately serve 2013 SWF and 2013 TXT atomically!
    const swf2013 = handleGameRoute({ url: "/Swf/AssetsClean/Rooms/room_110.swf", buildId, dataDir });
    const txt2013 = handleGameRoute({ url: "/Swf/AssetsClean/Rooms/room_110.txt", buildId, dataDir });
    assert.ok(swf2013 && txt2013);
    assert.equal(swf2013.status, 200);
    assert.equal(txt2013.status, 200);
    assert.equal(txt2013.body.toString("utf8"), '{"year":2013}');
    assert.equal(swf2013.headers?.["Cache-Control"], "no-store, must-revalidate");

    // ETag header switches to 2013's sha256
    assert.notEqual(swf2013.headers?.["ETag"], defaultSwf.headers?.["ETag"]);

    // 3. User switches back to "auto"
    handleApiRoute({
      method: "POST",
      pathname: `/api/builds/${buildId}/rooms/110/select-revision`,
      query: new URLSearchParams(),
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ revisionKey: "auto" })),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId: buildId,
      setActiveBuildId: () => {},
    });

    const bundleAuto = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(bundleAuto);
    assert.equal(bundleAuto.revisionKey, "20150829141022");
    assert.equal(bundleAuto.selectionMode, "recommended");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Selection persistence across restart", () => {
  const { dataDir, buildId } = setupBaseBuild();
  try {
    importExternalFiles(
      buildId,
      [
        { relativePath: "archive/2013/room_110_20130526000000.swf", bytes: makeSyntheticSwf("swf-2013") },
        { relativePath: "archive/2013/room_110_20130526000000.txt", bytes: Buffer.from('{"year":2013}') },
        { relativePath: "archive/2015/room_110_20150829141022.swf", bytes: makeSyntheticSwf("swf-2015") },
        { relativePath: "archive/2015/room_110_20150829141022.txt", bytes: Buffer.from('{"year":2015}') },
      ],
      { dataDir },
    );

    // Save selection
    setRoomRevisionSelection(buildId, 110, "20130526000000", dataDir);

    // Simulate complete process reload
    const selectedKey = getSelectedRoomRevision(buildId, 110, dataDir);
    assert.equal(selectedKey, "20130526000000");

    const resolved = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(resolved);
    assert.equal(resolved.revisionKey, "20130526000000");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Incomplete revision preserved but never selectable or activating", () => {
  const { dataDir, buildId } = setupBaseBuild();
  try {
    // 1. Ingest an incomplete revision (SWF only, missing TXT)
    const incompleteRes = importExternalFiles(
      buildId,
      [{ relativePath: "archive/2014/room_110_20140226000000.swf", bytes: makeSyntheticSwf("swf-incomplete") }],
      { dataDir },
    );
    assert.equal(incompleteRes.addedCount, 1);

    // File is preserved in revisions on disk
    const rec1 = readRevisionsRecord(buildId, "world", "Rooms", 110, dataDir);
    assert.ok(rec1);
    assert.ok(rec1.revisions["20140226000000"]);

    // But resolver fails cleanly: room 110 cannot be played with only an incomplete revision
    const resolvedIncomplete = resolveRoomRevision(buildId, 110, dataDir);
    assert.equal(resolvedIncomplete, null);

    const playable1 = getRoomPlayableRevisions(buildId, 110, dataDir);
    assert.equal(playable1.length, 1);
    assert.equal(playable1[0].isComplete, false);
    assert.deepEqual(playable1[0].missingFiles, ["room_110.txt"]);

    // 2. Add a complete 2013 revision
    importExternalFiles(
      buildId,
      [
        { relativePath: "archive/2013/room_110_20130526000000.swf", bytes: makeSyntheticSwf("swf-complete") },
        { relativePath: "archive/2013/room_110_20130526000000.txt", bytes: Buffer.from('{"mov":[]}') },
      ],
      { dataDir },
    );

    // Now resolver succeeds with the complete revision
    const resolvedComplete = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(resolvedComplete);
    assert.equal(resolvedComplete.revisionKey, "20130526000000");

    // Even if user attempts to select the incomplete revision, resolver safely rejects it and falls back to complete
    setRoomRevisionSelection(buildId, 110, "20140226000000", dataDir);
    const resolvedSafe = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(resolvedSafe);
    assert.equal(resolvedSafe.revisionKey, "20130526000000");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Mismatched revision provenance: Room 110 with 2014 SWF and 2015 TXT is preserved but NOT complete or selectable; matching 2014 pair is complete and selectable", () => {
  const { dataDir, buildId } = setupBaseBuild();
  try {
    // 1. Misplaced / stored under the same logical room revision folder:
    // A 2014 SWF and a 2015 TXT placed in the same revision folder
    const revDir = join(dataDir, "builds", buildId, "world", "Rooms", "110", "revisions", "20140518115313");
    mkdirSync(revDir, { recursive: true });

    const swfBytes2014 = makeSyntheticSwf("r110-2014");
    const txtBytes2015 = Buffer.from('{"year":2015,"mismatched":true}');
    writeFileSync(join(revDir, "room_110_20140518115313_c132c252.swf"), swfBytes2014);
    writeFileSync(join(revDir, "room_110_20150922101459_f2827c83.txt"), txtBytes2015);

    // Write initial revision record with 2014 SWF only (as would happen on import)
    const recDir = join(dataDir, "builds", buildId, "world", "Rooms", "110");
    const sha2014 = createHash("sha256").update(swfBytes2014).digest("hex");
    const initialRec = {
      logicalId: "world:room-110",
      category: "world" as const,
      entityId: 110,
      activeRevisionKey: "20140518115313",
      activeReason: "קובץ חדר SWF",
      revisions: {
        "20140518115313": {
          revisionKey: "20140518115313",
          logicalId: "world:room-110",
          category: "world" as const,
          files: {
            swf: {
              role: "swf",
              filename: "room_110_20140518115313_c132c252.swf",
              originalFilename: "room_110_20140518115313_c132c252.swf",
              originalRelativePath: "room_110_20140518115313_c132c252.swf",
              sha256: sha2014,
              size: swfBytes2014.length,
            },
          },
          timestamp: "20140518115313",
          formattedDate: "18.05.2014 11:53:13",
          provenance: "room_110_20140518115313_c132c252.swf",
          compatibility: "compatible" as const,
          importedAt: new Date().toISOString(),
          isCanonical: false,
        },
      },
    };
    writeFileSync(join(recDir, "revisions.json"), JSON.stringify(initialRec, null, 2));

    // A. Verify files are physically preserved on disk (preserved = YES)
    assert.equal(existsSync(join(revDir, "room_110_20140518115313_c132c252.swf")), true);
    assert.equal(existsSync(join(revDir, "room_110_20150922101459_f2827c83.txt")), true);

    // B. Reconciler reads revisions and must NOT pair the mismatched 2015 TXT
    const recAfter = readRevisionsRecord(buildId, "world", "Rooms", 110, dataDir);
    assert.ok(recAfter);
    assert.equal(recAfter.revisions["20140518115313"].files.txt, undefined);

    // C. Verify isComplete = NO
    const playable = getRoomPlayableRevisions(buildId, 110, dataDir);
    assert.equal(playable.length, 1);
    assert.equal(playable[0].isComplete, false);

    // D. Even if user explicitly selects this revision, selectable = NO (resolveRoomRevision returns null)
    setRoomRevisionSelection(buildId, 110, "20140518115313", dataDir);
    const resolvedMismatched = resolveRoomRevision(buildId, 110, dataDir);
    assert.equal(resolvedMismatched, null);

    // E. Even if revisions.json had both files recorded directly in rev.files:
    const maliciousRec = {
      ...initialRec,
      revisions: {
        "20140518115313": {
          ...initialRec.revisions["20140518115313"],
          files: {
            ...initialRec.revisions["20140518115313"].files,
            txt: {
              role: "txt",
              filename: "room_110_20150922101459_f2827c83.txt",
              originalFilename: "room_110_20150922101459_f2827c83.txt",
              originalRelativePath: "room_110_20150922101459_f2827c83.txt",
              sha256: createHash("sha256").update(txtBytes2015).digest("hex"),
              size: txtBytes2015.length,
            },
          },
        },
      },
    };
    writeFileSync(join(recDir, "revisions.json"), JSON.stringify(maliciousRec, null, 2));

    const playableMalicious = getRoomPlayableRevisions(buildId, 110, dataDir);
    assert.equal(playableMalicious[0].isComplete, false);
    assert.ok(playableMalicious[0].missingFiles?.includes("provenance-mismatch"));
    // Graceful fallback: when only a mismatched pair exists, resolver yields a fallback bundle instead of hard-blocking
    const resolvedMalicious = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(resolvedMalicious);
    assert.equal(resolvedMalicious.isFallbackPair, true);
    assert.equal(resolvedMalicious.isComplete, true);

    // 2. Now supply matching 2014 TXT with proven matching provenance
    const txtBytes2014 = Buffer.from('{"year":2014,"provenance":"matching"}');
    writeFileSync(join(revDir, "room_110_20140518115313_c132c252.txt"), txtBytes2014);

    const safeRec = {
      ...initialRec,
      revisions: {
        "20140518115313": {
          ...initialRec.revisions["20140518115313"],
          files: {
            swf: initialRec.revisions["20140518115313"].files.swf,
            txt: {
              role: "txt",
              filename: "room_110_20140518115313_c132c252.txt",
              originalFilename: "room_110_20140518115313_c132c252.txt",
              originalRelativePath: "room_110_20140518115313_c132c252.txt",
              sha256: createHash("sha256").update(txtBytes2014).digest("hex"),
              size: txtBytes2014.length,
            },
          },
        },
      },
    };
    writeFileSync(join(recDir, "revisions.json"), JSON.stringify(safeRec, null, 2));

    // Expected: isComplete = YES, selectable = YES
    const playableMatched = getRoomPlayableRevisions(buildId, 110, dataDir);
    assert.equal(playableMatched[0].isComplete, true);

    const resolvedMatched = resolveRoomRevision(buildId, 110, dataDir);
    assert.ok(resolvedMatched);
    assert.equal(resolvedMatched.revisionKey, "20140518115313");
    assert.equal(resolvedMatched.isComplete, true);
    assert.equal(resolvedMatched.isFallbackPair, false);
    assert.equal(resolvedMatched.swfFilename, "room_110_20140518115313_c132c252.swf");
    assert.equal(resolvedMatched.txtFilename, "room_110_20140518115313_c132c252.txt");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Room 20 cross-revision fallback: separate SWF and TXT imports allow playReady and bootstrap", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-rev-test-"));
  const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(apkRes.ok, true);
  const buildId = "20160725-android-1.4.7";
  try {
    // 1. Ingest Room 20 SWF with archival name/timestamp
    const res1 = importExternalFiles(
      buildId,
      [{ relativePath: "archive/2015/room_20_20150809221546_80976ff5.swf", bytes: makeSyntheticSwf("r20-swf") }],
      { dataDir },
    );
    assert.equal(res1.addedCount, 1);

    // At this point, TXT is missing, so room 20 is not ready yet
    const manifestMid = readBuildManifest(buildId, dataDir);
    assert.equal(manifestMid?.playReady, false);

    // 2. Ingest Room 20 TXT from a separate folder / unversioned canonical name
    const res2 = importExternalFiles(
      buildId,
      [{ relativePath: "configs/room_20.txt", bytes: Buffer.from('{"room":20,"triggers":[]}') }],
      { dataDir },
    );
    assert.equal(res2.addedCount, 1);

    // 3. Manifest must now be playReady with room 20 ready via fallback pairing
    const manifestAfter = readBuildManifest(buildId, dataDir);
    assert.ok(manifestAfter);
    assert.equal(manifestAfter.categories.world.ready, true);
    assert.equal(manifestAfter.playReady, true);

    const r20 = manifestAfter.categories.world.rooms.find((r) => r.roomId === 20);
    assert.ok(r20);
    assert.equal(r20.ready, true);
    assert.equal(r20.hasSwf, true);
    assert.equal(r20.hasTxt, true);
    assert.equal(r20.isFallbackPair, true);

    // 4. Room resolver succeeds and provides working bundle
    const bundle = resolveRoomRevision(buildId, 20, dataDir);
    assert.ok(bundle);
    assert.equal(bundle.isComplete, true);
    assert.equal(bundle.isFallbackPair, true);
    assert.ok(bundle.swfBytes.length > 0);
    assert.ok(bundle.txtBytes && bundle.txtBytes.length > 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
