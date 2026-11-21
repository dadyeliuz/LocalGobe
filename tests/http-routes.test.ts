import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getRuntimeFontsDir } from "../src/storage/paths.ts";
import { handleApiRoute } from "../src/server/http/api-routes.ts";
import { handleGameRoute, handleFontRoute } from "../src/server/http/game-routes.ts";
import { buildSyntheticSupportedApk, makeSyntheticLanguageXml, makeSyntheticSwf } from "./synthetic-fixtures.ts";

test("HTTP API & Game routes work cleanly from an empty data directory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-http-test-"));
  let activeBuildId = "20160725-android-1.4.7";
  try {
    // 1. Empty state -> 0 installed builds
    const listEmpty = handleApiRoute({
      method: "GET",
      pathname: "/api/builds",
      query: new URLSearchParams(),
      headers: {},
      body: Buffer.alloc(0),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(listEmpty?.status, 200);
    const emptyJson = JSON.parse(String(listEmpty?.body));
    assert.equal(emptyJson.installed.length, 0);

    // 2. Import synthetic APK via POST /api/import/apk
    const apkRes = handleApiRoute({
      method: "POST",
      pathname: "/api/import/apk",
      query: new URLSearchParams(),
      headers: { "x-file-name": "mogobe.apk" },
      body: buildSyntheticSupportedApk(),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(apkRes?.status, 200);

    // 3. Import Language + Room 20 SWF + TXT via POST /api/import/file
    const langRes = handleApiRoute({
      method: "POST",
      pathname: "/api/import/file",
      query: new URLSearchParams(),
      headers: { "x-build-id": activeBuildId, "x-relative-path": encodeURIComponent("Language/lang.aspx") },
      body: makeSyntheticLanguageXml(),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(langRes?.status, 200);

    const swfBytes = makeSyntheticSwf("room20-http");
    const r1 = handleApiRoute({
      method: "POST",
      pathname: "/api/import/file",
      query: new URLSearchParams(),
      headers: { "x-build-id": activeBuildId, "x-relative-path": encodeURIComponent("Rooms/room_20.swf") },
      body: swfBytes,
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(r1?.status, 200);

    const r2 = handleApiRoute({
      method: "POST",
      pathname: "/api/import/file",
      query: new URLSearchParams(),
      headers: { "x-build-id": activeBuildId, "x-relative-path": encodeURIComponent("Rooms/room_20.txt") },
      body: Buffer.from("room20-meta"),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(r2?.status, 200);
    const r2Json = JSON.parse(String(r2?.body));
    assert.equal(r2Json.manifest.playReady, true);

    // 4. Verify game route serves Room 20 SWF byte-identically
    const servedRoom = handleGameRoute({
      rawUrl: "/Swf/AssetsClean/Rooms/room_20.swf",
      pathname: "/Swf/AssetsClean/Rooms/room_20.swf",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(servedRoom?.status, 200);
    assert.equal(servedRoom?.mime, "application/x-shockwave-flash");
    assert.deepEqual(servedRoom?.body, swfBytes);

    // 5. Import Room 110 (with archival filename + UTF-8 BOM on TXT) and verify dynamic HTTP serving
    const r110Swf = makeSyntheticSwf("room110-http");
    const r110TxtBody = Buffer.from('{"mov":["mcHotel.mcDoor"]}', "utf8");
    const r110TxtWithBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), r110TxtBody]);
    const r110a = handleApiRoute({
      method: "POST",
      pathname: "/api/import/file",
      query: new URLSearchParams(),
      headers: { "x-build-id": activeBuildId, "x-relative-path": encodeURIComponent("ASSETSCLEAN/room_110_20150809221546_80976ff5.swf") },
      body: r110Swf,
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(r110a?.status, 200);
    const r110b = handleApiRoute({
      method: "POST",
      pathname: "/api/import/file",
      query: new URLSearchParams(),
      headers: { "x-build-id": activeBuildId, "x-relative-path": encodeURIComponent("ASSETSCLEAN/room_110_20150809221546_70f82c71.txt") },
      body: r110TxtWithBom,
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(r110b?.status, 200);

    const served110Swf = handleGameRoute({
      rawUrl: "/Swf/AssetsClean/Rooms/room_110.swf?1.4.7",
      pathname: "/Swf/AssetsClean/Rooms/room_110.swf",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(served110Swf?.status, 200);
    assert.deepEqual(served110Swf?.body, r110Swf);

    const served110Txt = handleGameRoute({
      rawUrl: "/swf/assetsclean/rooms/Room_110.txt",
      pathname: "/swf/assetsclean/rooms/Room_110.txt",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(served110Txt?.status, 200);
    assert.deepEqual(served110Txt?.body, r110TxtBody);

    // Uninstalled room returns clean 404 (never falls back to Room 20)
    const missingRoom = handleGameRoute({
      rawUrl: "/Swf/AssetsClean/Rooms/room_999.swf",
      pathname: "/Swf/AssetsClean/Rooms/room_999.swf",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(missingRoom?.status, 404);

    // 6. Runtime config configures embedded device font renderer with Arimo font source
    const rtCfgRes = handleApiRoute({
      method: "GET",
      pathname: `/api/builds/${activeBuildId}/runtime-config`,
      query: new URLSearchParams(),
      headers: {},
      body: Buffer.alloc(0),
      origin: "http://127.0.0.1:5173",
      dataDir,
      activeBuildId,
      setActiveBuildId: (id) => { activeBuildId = id; },
    });
    assert.equal(rtCfgRes?.status, 200);
    const rtCfgJson = JSON.parse(String(rtCfgRes?.body));
    assert.equal(rtCfgJson.runtimeConfig.deviceFontRenderer, "embedded");
    assert.deepEqual(rtCfgJson.runtimeConfig.fontSources, ["/local-fonts/arimo.ttf"]);

    const fontsDir = getRuntimeFontsDir(dataDir);
    mkdirSync(fontsDir, { recursive: true });
    writeFileSync(join(fontsDir, "arimo.ttf"), Buffer.from("synthetic-ttf-font-data"));

    const fontRes = handleFontRoute("/local-fonts/arimo.ttf", dataDir);
    assert.equal(fontRes?.status, 200);
    assert.equal(fontRes?.mime, "font/ttf");
    assert.ok(fontRes?.body && fontRes.body.length > 0);

    // 7. Path traversal is rejected with 400
    const badPath = handleGameRoute({
      rawUrl: "/game/../build.json",
      pathname: "/game/../build.json",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: activeBuildId,
      dataDir,
    });
    assert.equal(badPath?.status, 400);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
