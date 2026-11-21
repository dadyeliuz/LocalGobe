import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalFiles } from "../src/importer/file-importer.ts";
import { NulFramer, frameText } from "../src/server/smartfox/framing.ts";
import { signExtensionData } from "../src/server/smartfox/extensions.ts";
import { startSmartFoxTcpServer } from "../src/server/smartfox/smartfox-server.ts";
import { handleGameRoute } from "../src/server/http/game-routes.ts";
import {
  readRevisionsRecord,
  rankPopupRevisions,
  verifyMapPopupCompatibility,
  verifyMapPopupStructuralContract,
} from "../src/storage/revisions-store.ts";
import {
  buildSyntheticSupportedApk,
  makeSyntheticSwf,
  makeSyntheticMapPopupSwf,
} from "./synthetic-fixtures.ts";

function buildXtFrame(cmd: string, payload: unknown, room = -1): Buffer {
  const d = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const m = signExtensionData(d);
  return frameText(JSON.stringify({ t: "xt", b: { x: "worlds4uEx", c: cmd, r: room, p: { d, m } } }));
}

async function nextFrame(socket: Socket, framer: NulFramer): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const frames = framer.push(chunk);
      if (frames.length > 0) {
        socket.off("data", onData);
        resolve(frames[0].toString("utf8"));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function makeCompatibleMapSwf(): Buffer {
  return makeSyntheticMapPopupSwf({
    rooms: ["btnRoom_20", "btnRoom_110", "btnRoom_70"],
  });
}

test("Popup revisions: incompatible external p_3 is preserved but does not auto-activate; compatible external p_3 activates", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-rev-p3-"));
  try {
    const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
    assert.equal(apkRes.ok, true);

    // 1. Incompatible external p_3 (e.g. historical 2013 p_3 lacking btnRoom_ contract)
    const incompatibleP3 = makeSyntheticSwf("incompatible-2013-p3");
    const checkIncompat = verifyMapPopupCompatibility(incompatibleP3);
    assert.equal(checkIncompat.compatible, false);

    const import1 = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "p_3.swf", bytes: incompatibleP3 }],
      { dataDir },
    );
    assert.equal(import1.addedCount, 1);

    // External revision is preserved on disk
    const rec1 = readRevisionsRecord("20160725-android-1.4.7", "interface", "Popups", 3, dataDir);
    assert.ok(rec1);
    assert.equal(rec1.activeRevisionKey, null);
    assert.ok(rec1.activeReason?.includes("אינה פעילה"));

    // Route returns 404 when no compatible revision is active (no synthetic fallback)
    const routeRes1 = handleGameRoute({
      url: "/Swf/AssetsClean/Popups/popup_3.swf",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });
    assert.ok(routeRes1);
    assert.equal(routeRes1.status, 404);

    // 2. Compatible external p_3 (satisfies 2016 contract: mlPopup_3 + btnRoom_<id>)
    const compatibleP3 = makeCompatibleMapSwf();
    const checkCompat = verifyMapPopupCompatibility(compatibleP3);
    assert.equal(checkCompat.compatible, true);

    const import2 = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "p_3_20160725_compat.swf", bytes: compatibleP3 }],
      { dataDir },
    );
    assert.equal(import2.addedCount, 1);

    const rec2 = readRevisionsRecord("20160725-android-1.4.7", "interface", "Popups", 3, dataDir);
    assert.ok(rec2);
    assert.ok(rec2.activeRevisionKey);
    assert.equal(rec2.activeRevisionKey, "20160725");

    // Route now serves the active compatible revision
    const routeRes2 = handleGameRoute({
      url: "/Swf/AssetsClean/Popups/popup_3.swf",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });
    assert.ok(routeRes2);
    assert.equal(routeRes2.status, 200);
    assert.equal(routeRes2.body.includes("btnRoom_110"), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MapPopup structural parser: strictly validates DefineSprite and PlaceObject hierarchy, rejects string-only illusions", () => {
  // 1. Valid hierarchy -> compatible
  const validSwf = makeSyntheticMapPopupSwf({
    includeRootPopup: true,
    includeBtnClose: true,
    includeMcMap: true,
    rooms: ["btnRoom_20", "btnRoom_110"],
  });
  const resValid = verifyMapPopupStructuralContract(validSwf);
  assert.equal(resValid.compatible, true);
  assert.equal(resValid.structurallyCompatible, true);
  assert.equal(resValid.recognized, true);
  assert.equal(resValid.rootMlPopupFound, true);
  assert.equal(resValid.mlPopupSpriteFound, true);
  assert.equal(resValid.hasBtnClose, true);
  assert.equal(resValid.hasMcMap, true);
  assert.equal(resValid.mcMapSpriteFound, true);
  assert.equal(resValid.roomButtonCount, 2);

  // 2. mlPopup_3 string exists but not instantiated as PlaceObject -> incompatible
  const stringOnlyPopupSwf = makeSyntheticMapPopupSwf({
    includeRootPopup: false,
    stringOnlyPopup: true,
  });
  const resStringOnlyPopup = verifyMapPopupStructuralContract(stringOnlyPopupSwf);
  assert.equal(resStringOnlyPopup.compatible, false);
  assert.equal(resStringOnlyPopup.rootMlPopupFound, false);
  assert.ok(resStringOnlyPopup.reason.includes("Missing root timeline PlaceObject"));

  // 3. mlPopup_3 instantiated but mcMap absent -> incompatible
  const noMcMapSwf = makeSyntheticMapPopupSwf({
    includeRootPopup: true,
    includeBtnClose: true,
    includeMcMap: false,
  });
  const resNoMcMap = verifyMapPopupStructuralContract(noMcMapSwf);
  assert.equal(resNoMcMap.compatible, false);
  assert.equal(resNoMcMap.hasMcMap, false);
  assert.ok(resNoMcMap.reason.includes("mcMap"));

  // 4. mcMap present but btnClose absent -> incompatible
  const noBtnCloseSwf = makeSyntheticMapPopupSwf({
    includeRootPopup: true,
    includeBtnClose: false,
    includeMcMap: true,
  });
  const resNoBtnClose = verifyMapPopupStructuralContract(noBtnCloseSwf);
  assert.equal(resNoBtnClose.compatible, false);
  assert.equal(resNoBtnClose.hasBtnClose, false);
  assert.ok(resNoBtnClose.reason.includes("btnClose"));

  // 5. btnRoom string exists only in string pool/ActionScript but not as a PlaceObject in mcMap -> incompatible
  const stringOnlyBtnRoomSwf = makeSyntheticMapPopupSwf({
    includeRootPopup: true,
    includeBtnClose: true,
    includeMcMap: true,
    stringOnlyBtnRoom: true,
  });
  const resStringOnlyRoom = verifyMapPopupStructuralContract(stringOnlyBtnRoomSwf);
  assert.equal(resStringOnlyRoom.compatible, false);
  assert.equal(resStringOnlyRoom.roomButtonCount, 0);
  assert.ok(resStringOnlyRoom.reason.includes("btnRoom_<roomId>"));

  // 6. Real nested btnRoom_20 instance inside mcMap -> compatible
  const realNestedRoomSwf = makeSyntheticMapPopupSwf({
    includeRootPopup: true,
    includeBtnClose: true,
    includeMcMap: true,
    rooms: ["btnRoom_20"],
  });
  const resRealNested = verifyMapPopupStructuralContract(realNestedRoomSwf);
  assert.equal(resRealNested.compatible, true);
  assert.deepEqual(resRealNested.roomButtons, ["btnRoom_20"]);
});

test("MapPopup ranking & preference: unknown hash activates if compatible, build generation preferred deterministically", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-rev-p3-ranking-"));
  try {
    const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
    assert.equal(apkRes.ok, true);

    // Revision 1: 2014 map (compatible, 8 rooms, 2014-10-15)
    const map2014 = makeSyntheticMapPopupSwf({
      rooms: ["btnRoom_1", "btnRoom_100", "btnRoom_150", "btnRoom_160", "btnRoom_430", "btnRoom_500", "btnRoom_730", "btnRoom_10080"],
    });

    // Revision 2: 2016 map (compatible, 24 rooms, 2016-06-29)
    const map2016 = makeSyntheticMapPopupSwf({
      rooms: [
        "btnRoom_1", "btnRoom_100", "btnRoom_10010", "btnRoom_10077", "btnRoom_10080", "btnRoom_10098",
        "btnRoom_10112", "btnRoom_10246", "btnRoom_10296", "btnRoom_110", "btnRoom_140", "btnRoom_150",
        "btnRoom_160", "btnRoom_20", "btnRoom_250", "btnRoom_430", "btnRoom_50", "btnRoom_500",
        "btnRoom_555", "btnRoom_630", "btnRoom_660", "btnRoom_70", "btnRoom_730", "btnRoom_760"
      ],
    });

    // Revision 3: Unknown hash with genuine structure (compatible, 20 rooms, no timestamp in filename)
    const mapUnknown = makeSyntheticMapPopupSwf({
      rooms: ["btnRoom_20", "btnRoom_110", "btnRoom_70", "btnRoom_100"],
    });

    // Import 2014 first
    importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "p_3_20141015.swf", bytes: map2014 }],
      { dataDir },
    );
    let rec = readRevisionsRecord("20160725-android-1.4.7", "interface", "Popups", 3, dataDir);
    assert.ok(rec);
    assert.equal(rec.activeRevisionKey, "20141015");

    // Import 2016 next -> 2016 build preference prioritizes 2016 generation
    importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "p_3_20160629.swf", bytes: map2016 }],
      { dataDir },
    );
    rec = readRevisionsRecord("20160725-android-1.4.7", "interface", "Popups", 3, dataDir);
    assert.ok(rec);
    assert.equal(rec.activeRevisionKey, "20160629");

    // Import generic unknown hash -> verified structurally, preserved alongside others without overwriting
    importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "p_3_unknown.swf", bytes: mapUnknown }],
      { dataDir },
    );
    rec = readRevisionsRecord("20160725-android-1.4.7", "interface", "Popups", 3, dataDir);
    assert.ok(rec);
    // 3 revisions preserved in record
    assert.equal(Object.keys(rec.revisions).length, 3);
    // 2016 build preference still keeps 20160629 active
    assert.equal(rec.activeRevisionKey, "20160629");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Room multi-revision: 7 revisions of same room ID, deterministic pairing, date ranking, and order-independence", () => {
  const runMatrix = (folderOrder: number[]) => {
    const dataDir = mkdtempSync(join(tmpdir(), "localgobe-rev-r110-"));
    try {
      const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
      assert.equal(apkRes.ok, true);

      // Base room 20
      importExternalFiles(
        "20160725-android-1.4.7",
        [
          { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
          { relativePath: "Rooms/room_20.txt", bytes: Buffer.from('{"mov":[]}') },
        ],
        { dataDir },
      );

      // Define 7 distinct historical revisions of Room 110
      const allBatches = [
        // 0: 2013 complete pair
        [
          { relativePath: "archive/20130526/room_110_20130526000000.swf", bytes: makeSyntheticSwf("r110-2013") },
          { relativePath: "archive/20130526/room_110_20130526000000.txt", bytes: Buffer.from('{"mov":[13]}') },
        ],
        // 1: 2014 incomplete (SWF only)
        [
          { relativePath: "archive/20140226/room_110_20140226000000.swf", bytes: makeSyntheticSwf("r110-2014-incomplete") },
        ],
        // 2: 2015-08-09 complete pair
        [
          { relativePath: "archive/20150809/room_110_20150809221546_80976ff5.swf", bytes: makeSyntheticSwf("r110-2015-aug9") },
          { relativePath: "archive/20150809/room_110_20150809221546_70f82c71.txt", bytes: Buffer.from('{"mov":[1509]}') },
        ],
        // 3: 2015-08-29 complete pair (most recent complete pair!)
        [
          { relativePath: "archive/20150829/room_110_20150829141022_99a8b7c6.swf", bytes: makeSyntheticSwf("r110-2015-aug29") },
          { relativePath: "archive/20150829/room_110_20150829141022_11b2c3d4.txt", bytes: Buffer.from('{"mov":[1529]}') },
        ],
        // 4: 2016-01-01 incomplete (TXT only)
        [
          { relativePath: "archive/20160101/room_110_20160101000000.txt", bytes: Buffer.from('{"mov":[1601]}') },
        ],
        // 5: 2016-06-01 incomplete (SWF only)
        [
          { relativePath: "archive/20160601/room_110_20160601000000.swf", bytes: makeSyntheticSwf("r110-2016-incomplete") },
        ],
        // 6: 2012 complete pair
        [
          { relativePath: "archive/20120101/room_110_20120101000000.swf", bytes: makeSyntheticSwf("r110-2012") },
          { relativePath: "archive/20120101/room_110_20120101000000.txt", bytes: Buffer.from('{"mov":[1201]}') },
        ],
      ];

      for (const idx of folderOrder) {
        importExternalFiles("20160725-android-1.4.7", allBatches[idx], { dataDir });
      }

      const rec = readRevisionsRecord("20160725-android-1.4.7", "world", "Rooms", 110, dataDir);
      assert.ok(rec);
      // All 7 distinct revisions preserved on disk
      const revKeys = Object.keys(rec.revisions);
      assert.equal(revKeys.length, 7);

      // Deterministic active selection: 20150829141022 (highest-date complete pair)
      assert.equal(rec.activeRevisionKey, "20150829141022");
      const activeRev = rec.revisions[rec.activeRevisionKey];
      assert.ok(activeRev.files.swf);
      assert.ok(activeRev.files.txt);
      assert.equal(activeRev.files.swf.originalFilename, "room_110_20150829141022_99a8b7c6.swf");
      assert.equal(activeRev.files.txt.originalFilename, "room_110_20150829141022_11b2c3d4.txt");

      // Verify that incomplete revisions were never paired across unrelated folders
      const rev2014 = rec.revisions["20140226000000"];
      assert.ok(rev2014.files.swf);
      assert.equal(rev2014.files.txt, undefined);

      const rev2016txt = rec.revisions["20160101000000"];
      assert.equal(rev2016txt.files.swf, undefined);
      assert.ok(rev2016txt.files.txt);

      // Verify active revision served over HTTP
      const swfRes = handleGameRoute({
        url: "/Swf/AssetsClean/Rooms/room_110.swf",
        buildId: "20160725-android-1.4.7",
        dataDir,
      });
      assert.ok(swfRes);
      assert.equal(swfRes.status, 200);

      const txtRes = handleGameRoute({
        url: "/Swf/AssetsClean/Rooms/room_110.txt",
        buildId: "20160725-android-1.4.7",
        dataDir,
      });
      assert.ok(txtRes);
      assert.equal(txtRes.status, 200);
      assert.equal(txtRes.body.toString("utf8"), '{"mov":[1529]}');

      return {
        activeRevisionKey: rec.activeRevisionKey,
        swfSha: activeRev.files.swf.sha256,
        txtSha: activeRev.files.txt.sha256,
      };
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  // Run in forward order: 0, 1, 2, 3, 4, 5, 6
  const forwardResult = runMatrix([0, 1, 2, 3, 4, 5, 6]);

  // Run in reverse order: 6, 5, 4, 3, 2, 1, 0
  const reverseResult = runMatrix([6, 5, 4, 3, 2, 1, 0]);

  // Run in arbitrary shuffled order: 4, 1, 6, 3, 0, 5, 2
  const shuffledResult = runMatrix([4, 1, 6, 3, 0, 5, 2]);

  // Import order MUST be completely independent:
  assert.equal(forwardResult.activeRevisionKey, "20150829141022");
  assert.equal(reverseResult.activeRevisionKey, forwardResult.activeRevisionKey);
  assert.equal(shuffledResult.activeRevisionKey, forwardResult.activeRevisionKey);
  assert.equal(reverseResult.swfSha, forwardResult.swfSha);
  assert.equal(shuffledResult.txtSha, forwardResult.txtSha);
});

test("SmartFox room navigation: missing-room returns native rejection; installed room joins successfully", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-sfs-map-"));
  const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(apkRes.ok, true);

  importExternalFiles(
    "20160725-android-1.4.7",
    [
      { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
      { relativePath: "Rooms/room_20.txt", bytes: Buffer.from('{"mov":[]}') },
      { relativePath: "room_110_20150809221546_80976ff5.swf", bytes: makeSyntheticSwf("r110") },
      { relativePath: "room_110_20150809221546_70f82c71.txt", bytes: Buffer.from('{"mov":[]}') },
    ],
    { dataDir },
  );

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId: "20160725-android-1.4.7", dataDir });
  const client = new Socket();
  const framer = new NulFramer();

  try {
    await new Promise<void>((res, rej) => {
      client.once("error", rej);
      client.connect(port, "127.0.0.1", () => res());
    });

    client.write(frameText(`<msg t='sys'><body action='verChk' r='0'><ver v='165' /></body></msg>`));
    await nextFrame(client, framer);

    client.write(
      frameText(`<msg t='sys'><body action='login' r='0'><login z='worlds4u'><nick><![CDATA[::0:cartographer:1]]></nick><pword><![CDATA[x]]></pword></login></body></msg>`),
    );
    await nextFrame(client, framer);

    client.write(frameText(`<msg t='sys'><body action='getRmList' r='-1'></body></msg>`));
    await nextFrame(client, framer);
    await new Promise((r) => setTimeout(r, 30));

    client.write(buildXtFrame("rooms__getStaticRoomList", { platform: 2 }));
    await nextFrame(client, framer);

    // Join Room 20
    client.write(buildXtFrame("user__joinFirstRoom", {}));
    const join20 = await nextFrame(client, framer);
    assert.match(join20, /action='joinOK' r='20'/);

    // 1. Click uninstalled map room (Room 140 - Market):
    // MapPopup onIconClick sends rooms__jumpToRoom with roomId: 140
    client.write(buildXtFrame("rooms__jumpToRoom", { roomId: 140, userId: 1, userName: "cartographer" }));
    const rejection = await nextFrame(client, framer);
    // Server returns native rejection; does not emit joinOK, user stays in Room 20
    assert.match(rejection, /"status":false/);
    assert.match(rejection, /"roomId":140/);
    assert.match(rejection, /"errorId":11/);
    assert.doesNotMatch(rejection, /action='joinOK'/);

    // 2. Click installed map room (Room 110 - Talina):
    // MapPopup onIconClick sends rooms__jumpToRoom with roomId: 110
    client.write(buildXtFrame("rooms__jumpToRoom", { roomId: 110, userId: 1, userName: "cartographer" }));
    const join110 = await nextFrame(client, framer);
    assert.match(join110, /action='joinOK' r='110'/);
  } finally {
    client.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
