import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalDirectory, importExternalFiles } from "../src/importer/file-importer.ts";
import { inspectMogobeLanguageXml } from "../src/importer/language-inspector.ts";
import { inspectMogobeChatXml } from "../src/importer/chat-inspector.ts";
import { handleGameRoute } from "../src/server/http/game-routes.ts";
import { readRevisionsRecord } from "../src/storage/revisions-store.ts";
import {
  buildSyntheticSupportedApk,
  makeSyntheticChatXml,
  makeSyntheticLanguageXml,
  makeSyntheticSwf,
} from "./synthetic-fixtures.ts";

function setupInstalledBuild(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-lang-test-"));
  const res = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(res.ok, true);
  return dataDir;
}

test("Language does NOT block playReady: APK + Room20 + no language -> playReady = true", () => {
  const dataDir = setupInstalledBuild();
  try {
    // Add Room 20 pair (SWF + TXT) but no language
    const roomRes = importExternalFiles(
      "20160725-android-1.4.7",
      [
        { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
        { relativePath: "Rooms/room_20.txt", bytes: Buffer.from("x=1") },
      ],
      { dataDir },
    );
    assert.equal(roomRes.manifest.categories.world.ready, true);
    assert.equal(roomRes.manifest.categories.interface.language?.present, false);
    assert.equal(roomRes.manifest.categories.interface.ready, true);
    // CRITICAL: playReady is TRUE even without language file
    assert.equal(roomRes.manifest.playReady, true);
    // Language warning is present to guide the user
    assert.ok(roomRes.manifest.categories.interface.language?.warning);

    // No active language -> HTTP route returns 200 with minimal empty protocol XML (never 404, never hanging client)
    const routeRes = handleGameRoute({
      rawUrl: "/servises/lang.aspx?lang=1",
      pathname: "/servises/lang.aspx",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });
    assert.equal(routeRes?.status, 200);
    assert.equal(routeRes?.mime, "application/xml; charset=utf-8");
    const bodyStr = String(routeRes?.body);
    assert.match(bodyStr, /<Lang\s+Language="1"/i);
    assert.match(bodyStr, /<Sections\s*\/>/i);
    // Zero Mogobe messages or sections in fallback
    assert.doesNotMatch(bodyStr, /<M\s+/i);
    assert.doesNotMatch(bodyStr, /<Section\s+/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Language without Room 20 does NOT unlock playReady: APK + language + no Room20 -> playReady = false", () => {
  const dataDir = setupInstalledBuild();
  try {
    const langRes = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Language/lang.aspx", bytes: makeSyntheticLanguageXml() }],
      { dataDir },
    );
    assert.equal(langRes.manifest.categories.interface.language?.present, true);
    assert.equal(langRes.manifest.categories.interface.language?.compatible, true);
    assert.equal(langRes.manifest.categories.interface.ready, true);
    assert.equal(langRes.manifest.categories.world.ready, false);
    // World is still missing Room 20, so play is blocked
    assert.equal(langRes.manifest.playReady, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Original language always wins: imported original is served directly, never merged", () => {
  const dataDir = setupInstalledBuild();
  try {
    const customMessage = "UNIQUE_USER_ORIGINAL_MESSAGE_999";
    const originalXml = Buffer.from(
      `\uFEFF<?xml version="1.0" encoding="utf-8"?><Lang Language="1" lastUpdate="2016-07-25 12:00:00 PM"><Sections><Section name="Login"><M id="1" msg="${customMessage}"/></Section></Sections></Lang>`,
      "utf8",
    );

    const res = importExternalFiles(
      "20160725-android-1.4.7",
      [
        { relativePath: "Language/lang.aspx", bytes: originalXml },
        { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
        { relativePath: "Rooms/room_20.txt", bytes: Buffer.from("x=1") },
      ],
      { dataDir },
    );
    assert.equal(res.manifest.categories.interface.ready, true);
    assert.equal(res.manifest.categories.world.ready, true);
    assert.equal(res.manifest.playReady, true);
    assert.equal(res.manifest.categories.interface.language?.present, true);
    assert.equal(res.manifest.categories.interface.language?.compatible, true);

    // Single source of truth: no duplicate flat Language/lang.aspx created
    const flatFile = join(dataDir, "builds", "20160725-android-1.4.7", "files", "Language", "lang.aspx");
    assert.equal(existsSync(flatFile), false, "Duplicate flat Language/lang.aspx must not exist");

    // HTTP route serves the original active revision bytes
    const routeRes = handleGameRoute({
      rawUrl: "/servises/lang.aspx?lang=1",
      pathname: "/servises/lang.aspx",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });
    assert.equal(routeRes?.status, 200);
    const bodyStr = String(routeRes?.body);
    assert.ok(bodyStr.includes(customMessage), "Must serve original user bytes");
    // UTF-8 BOM must be stripped
    assert.equal(bodyStr.charCodeAt(0) === 0xfeff, false, "BOM must be stripped from HTTP response");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Deeply nested language file is recognized and activated without duplicate flat copy", () => {
  const dataDir = setupInstalledBuild();
  const folder = mkdtempSync(join(tmpdir(), "localgobe-lang-nested-"));
  try {
    const deepDir = join(folder, "archive", "historical", "configs");
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, "lang.aspx"), makeSyntheticLanguageXml());

    const summary = importExternalDirectory("20160725-android-1.4.7", folder, { dataDir });
    assert.equal(summary.addedCount, 1);
    assert.equal(summary.items[0].logicalId, "interface:language-he");
    assert.equal(summary.items[0].status, "added");
    assert.equal(summary.manifest.categories.interface.language?.present, true);
    assert.equal(summary.manifest.categories.interface.language?.compatible, true);

    const flatFile = join(dataDir, "builds", "20160725-android-1.4.7", "files", "Language", "lang.aspx");
    assert.equal(existsSync(flatFile), false, "Duplicate flat Language/lang.aspx must not exist");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Mixed folder import: language + room + item are all imported in one batch without blocking play", () => {
  const dataDir = setupInstalledBuild();
  const folder = mkdtempSync(join(tmpdir(), "localgobe-mixed-"));
  try {
    mkdirSync(join(folder, "configs"), { recursive: true });
    mkdirSync(join(folder, "Rooms"), { recursive: true });
    mkdirSync(join(folder, "Items", "IconS"), { recursive: true });

    writeFileSync(join(folder, "configs", "lang.aspx"), makeSyntheticLanguageXml());
    writeFileSync(join(folder, "Rooms", "room_20.swf"), makeSyntheticSwf("r20"));
    writeFileSync(join(folder, "Rooms", "room_20.txt"), Buffer.from("v=1"));
    writeFileSync(join(folder, "Items", "IconS", "101.swf"), makeSyntheticSwf("item101"));

    const summary = importExternalDirectory("20160725-android-1.4.7", folder, { dataDir });
    assert.equal(summary.addedCount, 4);
    assert.equal(summary.manifest.categories.interface.language?.compatible, true);
    assert.equal(summary.manifest.categories.world.ready, true);
    assert.equal(summary.manifest.categories.items.count, 1);
    assert.equal(summary.manifest.playReady, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Multiple language revisions are preserved in revisions store; deterministic order-independent ranking", () => {
  const dataDirForward = setupInstalledBuild();
  const dataDirReverse = setupInstalledBuild();
  try {
    const revEarly = {
      relativePath: "2013/lang.aspx",
      bytes: makeSyntheticLanguageXml({
        lastUpdate: "2013-05-26 10:00:00 AM",
      }),
    };
    const revLate = {
      relativePath: "2015/lang.aspx",
      bytes: makeSyntheticLanguageXml({
        lastUpdate: "2015-08-09 04:00:00 PM",
      }),
    };

    // Forward import: early then late
    const fwd1 = importExternalFiles("20160725-android-1.4.7", [revEarly], { dataDir: dataDirForward });
    assert.equal(fwd1.manifest.categories.interface.language?.activeRevisionKey, "20130526100000");
    const fwd2 = importExternalFiles("20160725-android-1.4.7", [revLate], { dataDir: dataDirForward });
    assert.equal(fwd2.updatedCount, 1);
    assert.equal(fwd2.manifest.categories.interface.language?.activeRevisionKey, "20150809040000");

    // Reverse import: late then early
    const rev1 = importExternalFiles("20160725-android-1.4.7", [revLate], { dataDir: dataDirReverse });
    assert.equal(rev1.manifest.categories.interface.language?.activeRevisionKey, "20150809040000");
    const rev2 = importExternalFiles("20160725-android-1.4.7", [revEarly], { dataDir: dataDirReverse });
    assert.equal(rev2.conflictCount, 1);
    assert.equal(rev2.manifest.categories.interface.language?.activeRevisionKey, "20150809040000");

    // Both directories have both revisions preserved in their revisions store
    const recFwd = readRevisionsRecord("20160725-android-1.4.7", "interface", "Language", "he", dataDirForward);
    const recRev = readRevisionsRecord("20160725-android-1.4.7", "interface", "Language", "he", dataDirReverse);
    assert.equal(Object.keys(recFwd?.revisions ?? {}).length, 2);
    assert.equal(Object.keys(recRev?.revisions ?? {}).length, 2);
    assert.equal(recFwd?.activeRevisionKey, recRev?.activeRevisionKey);
  } finally {
    rmSync(dataDirForward, { recursive: true, force: true });
    rmSync(dataDirReverse, { recursive: true, force: true });
  }
});

test("Minimal language validation: valid structure activates, non-hash-gated", () => {
  const dataDir = setupInstalledBuild();
  try {
    const customXml = makeSyntheticLanguageXml({
      lastUpdate: "2016-09-01 12:00:00 PM",
    });

    const summary = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "lang.aspx", bytes: customXml }],
      { dataDir },
    );
    assert.equal(summary.addedCount, 1);
    assert.equal(summary.manifest.categories.interface.language?.compatible, true);
    assert.equal(summary.manifest.categories.interface.ready, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Corrupt or non-XML file is rejected and does not activate", () => {
  const dataDir = setupInstalledBuild();
  try {
    const corruptBytes = Buffer.from("corrupt garbage that is not valid xml");
    const insp = inspectMogobeLanguageXml(corruptBytes);
    assert.equal(insp.valid, false);

    const summary = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "configs/lang.aspx", bytes: corruptBytes }],
      { dataDir },
    );
    // Classified as unknown/invalid and skipped (does not activate)
    assert.equal(summary.unknownCount, 1);
    assert.equal(summary.manifest.categories.interface.language?.compatible, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Imported empty language protocol shim is REJECTED as an asset: requires section and M entries", () => {
  const dataDir = setupInstalledBuild();
  try {
    // 1. Empty protocol shim (has <Sections /> but NO Section tags and NO M entries)
    const emptyShimBytes = Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?><Lang Language="1"><Sections /></Lang>`,
      "utf8",
    );
    const inspEmpty = inspectMogobeLanguageXml(emptyShimBytes);
    assert.equal(inspEmpty.valid, false, "Empty protocol shim must not be considered a valid imported asset");
    assert.equal(inspEmpty.hasSections, false);

    // Import it along with Room 20
    const summaryEmpty = importExternalFiles(
      "20160725-android-1.4.7",
      [
        { relativePath: "Language/lang.aspx", bytes: emptyShimBytes },
        { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
        { relativePath: "Rooms/room_20.txt", bytes: Buffer.from("x=1") },
      ],
      { dataDir },
    );
    // Empty language file is rejected/unknown, not added as a recognized language
    assert.equal(summaryEmpty.manifest.categories.interface.language?.present, false);
    assert.equal(summaryEmpty.manifest.categories.interface.language?.active, false);
    assert.ok(summaryEmpty.manifest.categories.interface.language?.warning);
    // Play is STILL ready (Room 20 present, language never blocks play)
    assert.equal(summaryEmpty.manifest.playReady, true);

    // HTTP server route still returns HTTP 200 protocol shim so client doesn't hang
    const routeRes = handleGameRoute({
      rawUrl: "/servises/lang.aspx?lang=1",
      pathname: "/servises/lang.aspx",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });
    assert.equal(routeRes?.status, 200);
    assert.match(String(routeRes?.body), /<Lang Language="1"/i);
    assert.match(String(routeRes?.body), /<Sections\s*\/>/i);

    // 2. Language with Section but NO M entries is also rejected
    const sectionNoMsgBytes = Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?><Lang Language="1"><Sections><Section name="Login"></Section></Sections></Lang>`,
      "utf8",
    );
    const inspNoMsg = inspectMogobeLanguageXml(sectionNoMsgBytes);
    assert.equal(inspNoMsg.valid, false, "Language without M entries must be rejected");
    assert.equal(inspNoMsg.messagesCount, 0);

    const summaryNoMsg = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "Language/lang.aspx", bytes: sectionNoMsgBytes }],
      { dataDir },
    );
    assert.equal(summaryNoMsg.manifest.categories.interface.language?.present, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Chat XML: Smart structural inspection distinguishes genuine chat XML from dummy shims", () => {
  // 1. Genuine synthetic Mogobe chat XML (Hebrew)
  const chatBytes = makeSyntheticChatXml({ languageId: 1 });
  const insp = inspectMogobeChatXml(chatBytes, "chat_1.xml");
  assert.equal(insp.valid, true);
  assert.equal(insp.languageId, 1);
  assert.equal(insp.hasHebrew, true);
  assert.ok(insp.messagesCount >= 3);
  assert.ok(insp.categoriesCount >= 1);

  // 2. Protocol shim (<lang><chat><group id="local" txt="LOCAL_CHAT"/></chat></lang>) must be rejected as an asset
  const shimBytes = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><lang><chat><group id="local" txt="LOCAL_CHAT"/></chat></lang>');
  const shimInsp = inspectMogobeChatXml(shimBytes, "chat_1.xml");
  assert.equal(shimInsp.valid, false, "Dummy protocol shim must not qualify as a recognized chat asset");

  // 3. Alternate language (Russian chat_5.xml)
  const ruChatBytes = makeSyntheticChatXml({ languageId: 5, withHebrew: false });
  const ruInsp = inspectMogobeChatXml(ruChatBytes, "chat_5.xml");
  assert.equal(ruInsp.valid, true);
  assert.equal(ruInsp.languageId, 5);
  assert.equal(ruInsp.hasHebrew, false);
});

test("Chat XML: Importer recognizes chat_1.xml, activates it under interface, and serves authentic XML", () => {
  const dataDir = setupInstalledBuild();
  try {
    const chatBytes = makeSyntheticChatXml({ languageId: 1 });

    // Import chat_1.xml
    const importRes = importExternalFiles(
      "20160725-android-1.4.7",
      [{ relativePath: "chat_1.xml", bytes: chatBytes }],
      { dataDir },
    );

    assert.equal(importRes.addedCount, 1);
    assert.equal(importRes.unclassifiedCount, 0, "Chat XML must not be placed in unclassified");
    assert.equal(importRes.items[0].status, "added");
    assert.equal(importRes.items[0].category, "interface");
    assert.equal(importRes.items[0].logicalId, "interface:chat-language-he");

    // HTTP route /Xmls/lang/chat_1.xml serves authentic XML bytes, not LOCAL_CHAT fixture
    const routeRes = handleGameRoute({
      rawUrl: "/Xmls/lang/chat_1.xml?1.0.0",
      pathname: "/Xmls/lang/chat_1.xml",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });

    assert.equal(routeRes?.status, 200);
    const bodyStr = String(routeRes?.body);
    assert.ok(!bodyStr.includes("LOCAL_CHAT"), "Must serve authentic chat XML, not LOCAL_CHAT dummy fixture");
    assert.match(bodyStr, /<ms\s+id="1000"/i);
    assert.match(bodyStr, /<m\s+id="1010"/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Chat XML: Auto-promotes trapped unclassified chat file and removes it from unclassified storage", () => {
  const dataDir = setupInstalledBuild();
  try {
    const chatBytes = makeSyntheticChatXml({ languageId: 1 });

    // Simulate an existing unclassified chat file sitting in dataDir
    const unclassDir = join(dataDir, "builds", "20160725-android-1.4.7", "unclassified");
    mkdirSync(unclassDir, { recursive: true });
    const unclassPath = join(unclassDir, "3354bdf0e73f_chat_1.xml");
    writeFileSync(unclassPath, chatBytes);

    assert.equal(existsSync(unclassPath), true);

    // Client requests /Xmls/lang/chat_1.xml -> server auto-detects and promotes the file
    const routeRes = handleGameRoute({
      rawUrl: "/Xmls/lang/chat_1.xml",
      pathname: "/Xmls/lang/chat_1.xml",
      requestBody: "",
      origin: "http://127.0.0.1:5173",
      buildId: "20160725-android-1.4.7",
      dataDir,
    });

    assert.equal(routeRes?.status, 200);
    const bodyStr = String(routeRes?.body);
    assert.match(bodyStr, /<ms\s+id="1000"/i);
    assert.ok(!bodyStr.includes("LOCAL_CHAT"));

    // Trapped unclassified file was cleaned up from unclassified/
    assert.equal(existsSync(unclassPath), false, "Promoted unclassified chat file should be cleaned up");

    // Promoted file now exists in interface/Language/chat_1.xml
    const promotedPath = join(dataDir, "builds", "20160725-android-1.4.7", "interface", "Language", "chat_1.xml");
    assert.equal(existsSync(promotedPath), true, "Promoted file must exist in Language/chat_1.xml");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
