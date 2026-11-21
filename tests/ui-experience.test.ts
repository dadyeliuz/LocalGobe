import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExternalImportSummary } from "../src/importer/types.ts";
import type { InstalledBuildManifest } from "../src/storage/manifest-generator.ts";
import { addedPhrase, countPhrase, discoveryPhrase, he, nounFor } from "../src/ui/i18n/he.ts";
import {
  applyFileResult,
  createImportSession,
  finishSession,
  summarizeOutcome,
} from "../src/ui/import-session.ts";
import {
  classifyMissingAsset,
  deriveHomeModel,
  routeDroppedFiles,
  type MissingAssetEntry,
} from "../src/ui/model.ts";
import {
  renderDropOverlay,
  renderMissingAssetToast,
  renderPlayScreen,
} from "../src/ui/views/play.ts";
import { renderFirstRun, renderHome } from "../src/ui/views/screens.ts";
import { renderSheet, type SheetContext } from "../src/ui/views/sheets.ts";

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

function makeManifest(overrides?: {
  playReady?: boolean;
  gameReady?: boolean;
  interfaceReady?: boolean;
  interfaceCount?: number;
  worldReady?: boolean;
  roomCount?: number;
  musicCount?: number;
  itemCount?: number;
  miniGameCount?: number;
}): InstalledBuildManifest {
  const o = {
    playReady: true,
    gameReady: true,
    interfaceReady: true,
    interfaceCount: 2,
    worldReady: true,
    roomCount: 1,
    musicCount: 0,
    itemCount: 0,
    miniGameCount: 0,
    ...overrides,
  };
  return {
    schemaVersion: 1,
    buildId: "20160725-android-1.4.7",
    displayName: "Mogobe Android 1.4.7",
    sourceType: "APK",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    categories: {
      game: { ready: o.gameReady, extractedCount: 12, requiredCount: 12, missingRequired: [] },
      interface: {
        ready: o.interfaceReady,
        presentCount: o.interfaceCount,
        requiredCount: 0,
        missingRequired: [],
        missingOptional: [],
        language: {
          present: o.interfaceReady,
          compatible: o.interfaceReady,
          status: o.interfaceReady ? "compatible" : "missing",
          sectionsCount: o.interfaceReady ? 20 : 0,
          missingRequiredSections: [],
          revisionsCount: o.interfaceReady ? 1 : 0,
        },
      },
      world: {
        ready: o.worldReady,
        bootstrapRoomId: 20,
        bootstrapRoomReady: o.worldReady,
        roomCount: o.roomCount,
        musicCount: o.musicCount,
        rooms: Array.from({ length: o.roomCount }, (_, idx) => ({
          roomId: 20 + idx,
          hasSwf: true,
          hasTxt: true,
          ready: true,
        })),
      },
      items: {
        count: o.itemCount,
        byFamily: { IconS: o.itemCount, IconW: 0, BigItem: 0, BtnItem: 0, BtnAccessory: 0, Cat: 0, Gift: 0, RoomItem: 0 },
      },
      miniGames: {
        availableCount: o.miniGameCount,
        totalKnownCount: 12,
        games: [],
      },
    },
    recognizedAssets: [],
    requiredMissingAssets: [],
    optionalMissingAssets: [],
    roomCount: o.roomCount,
    itemCount: o.itemCount,
    miniGameCount: o.miniGameCount,
    playReady: o.playReady,
  };
}

function makeSummary(manifest: InstalledBuildManifest, addedCount = 1): ExternalImportSummary {
  return {
    buildId: manifest.buildId,
    addedCount,
    updatedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    unclassifiedCount: 0,
    unknownCount: 0,
    rejectedCount: 0,
    addedByCategory: { game: 0, interface: 0, world: addedCount, items: 0, miniGames: 0 },
    unknownFiles: [],
    unclassifiedFiles: [],
    conflicts: [],
    items: [],
    manifest,
  };
}

function makeSheetCtx(build: InstalledBuildManifest | null): SheetContext {
  return {
    build,
    runtime: { ruffleReady: true, airShimsReady: true, smartFoxReady: true, dataDir: "data/" },
    prefs: { fullscreen: false, diagnostics: false },
    lastUnknownFiles: [],
  };
}

test("index.html configures Hebrew RTL-first document", () => {
  const html = readFileSync(resolve(projectRoot, "index.html"), "utf8");
  assert.match(html, /<html[^>]*\blang="he"/);
  assert.match(html, /<html[^>]*\bdir="rtl"/);
});

test("Hebrew pluralization and natural discovery copy", () => {
  assert.equal(nounFor("room", 1), "חדר");
  assert.equal(nounFor("room", 8), "חדרים");
  assert.equal(countPhrase("room", 1), "חדר אחד");
  assert.equal(countPhrase("music", 1), "מנגינה אחת");
  assert.equal(addedPhrase("room", 8), "נוספו 8 חדרים");
  assert.equal(addedPhrase("item", 214), "נוספו 214 פריטים");
  assert.equal(discoveryPhrase("room", 1), "נמצא חדר חדש");
  assert.equal(discoveryPhrase("item", 48), "נמצאו 48 פריטים");
  assert.equal(discoveryPhrase("game", 1), "נמצא משחק נוסף");
});

const stripTags = (html: string) => html.replace(/<[^>]*>/g, " ");

test("First Run screen renders warm Hebrew welcome without developer jargon", () => {
  const html = renderFirstRun({ serviceError: false, fresh: true });
  const text = stripTags(html);
  assert.ok(text.includes(he.firstRunTitle));
  assert.ok(text.includes(he.addApk));
  assert.ok(text.includes(he.firstRunNote));
  assert.ok(!text.includes("Room 20"));
  assert.ok(!text.includes("missing"));
  assert.ok(!text.includes("%"));
});

test("Home screen transitions from needs-world guidance to Play-ready portal with empty & populated states", () => {
  const waitingManifest = makeManifest({ playReady: false, worldReady: false, roomCount: 0 });
  const waitingModel = deriveHomeModel(waitingManifest);
  assert.equal(waitingModel.stage, "needs-world");
  const waitingHtml = renderHome(waitingModel, { serviceError: false, fresh: true });
  assert.ok(waitingHtml.includes(he.almostThere));
  assert.ok(waitingHtml.includes(he.addWorldFilesLead));
  assert.ok(waitingHtml.includes(he.chooseFolder));
  assert.ok(waitingHtml.includes(he.chooseFiles));
  assert.ok(waitingHtml.includes(he.whatsMissing));
  assert.ok(waitingHtml.includes("room_20.swf"));
  assert.ok(waitingHtml.includes("room_20.txt"));

  // Partial Room 20 (SWF only) updates the guidance copy and disclosure pills
  const partialR20Manifest = makeManifest({ playReady: false, worldReady: false, roomCount: 0 });
  partialR20Manifest.categories.world.rooms = [{ roomId: 20, hasSwf: true, hasTxt: false, ready: false }];
  const partialHtml = renderHome(deriveHomeModel(partialR20Manifest), { serviceError: false, fresh: false });
  assert.ok(partialHtml.includes(he.entryRoomSwfOnlyLead));
  assert.ok(partialHtml.includes(he.fileFoundLabel));
  assert.ok(partialHtml.includes(he.fileMissingLabel));

  const readyEmptyManifest = makeManifest({ playReady: true, roomCount: 1, itemCount: 0, miniGameCount: 0 });
  const readyEmptyHtml = renderHome(deriveHomeModel(readyEmptyManifest), { serviceError: false, fresh: false });
  assert.ok(readyEmptyHtml.includes(he.play));
  assert.ok(readyEmptyHtml.includes(he.readyToPlay));
  assert.ok(readyEmptyHtml.includes(he.addContent));
  assert.ok(readyEmptyHtml.includes(he.noItemsYet));
  assert.ok(readyEmptyHtml.includes(he.noGamesYet));
  assert.ok(readyEmptyHtml.includes(he.addRooms));
  assert.ok(readyEmptyHtml.includes(he.addItems));
  assert.ok(readyEmptyHtml.includes(he.addGames));
  assert.ok(readyEmptyHtml.includes(he.interfaceReady));

  const richManifest = makeManifest({ playReady: true, roomCount: 12, musicCount: 5, itemCount: 436, miniGameCount: 19 });
  const richHtml = renderHome(deriveHomeModel(richManifest), { serviceError: false, fresh: false });
  const richText = stripTags(richHtml);
  assert.ok(richHtml.includes('data-count="12"'));
  assert.ok(richHtml.includes('data-count="436"'));
  assert.ok(richHtml.includes('data-count="19"'));
  assert.ok(richText.includes("עם 5 מנגינות"));
  assert.ok(!richText.includes("complete"));
  assert.ok(!richText.includes("%"));
});

test("Add Content sheet exposes all friendly categories while keeping automatic mixed import", () => {
  const manifest = makeManifest({ roomCount: 3, itemCount: 120, miniGameCount: 4 });
  const html = renderSheet({ kind: "add", context: "world" }, makeSheetCtx(manifest));
  assert.ok(html.includes(he.addSheetTitle));
  assert.ok(html.includes("חדרים ומוזיקה"));
  assert.ok(html.includes("פריטים"));
  assert.ok(html.includes("מיני־משחקים"));
  assert.ok(html.includes("ממשק ותוספות"));
  assert.ok(html.includes(he.chooseFolder));
  assert.ok(html.includes(he.chooseFiles));
  assert.ok(html.includes(he.addSheetAnyNote));
});

test("Global drag/drop routing and overlay state adapt to installation state", () => {
  assert.deepEqual(routeDroppedFiles(["mogobe.apk"], false), { kind: "apk", index: 0 });
  assert.deepEqual(routeDroppedFiles(["room_20.swf"], false), { kind: "need-apk" });
  assert.deepEqual(routeDroppedFiles(["room_20.swf", "IconS/1.swf"], true), { kind: "files", indices: [0, 1] });
  assert.deepEqual(routeDroppedFiles(["mogobe.apk"], true), { kind: "apk", index: 0 });

  const overlayNoBuild = renderDropOverlay({ active: true, hasBuild: false, context: "all" });
  assert.ok(overlayNoBuild.includes(he.dropTitleApk));
  const overlayWithBuild = renderDropOverlay({ active: true, hasBuild: true, context: "all" });
  assert.ok(overlayWithBuild.includes(he.dropTitleFiles));
  const overlayItems = renderDropOverlay({ active: true, hasBuild: true, context: "items" });
  assert.ok(overlayItems.includes("פריטים"));
});

test("Post-setup & repeated mixed imports update World, Items, and Mini Games counts dynamically", () => {
  // First import: makes the world ready (Room 20)
  const beforeWorld = makeManifest({ playReady: false, worldReady: false, roomCount: 0, itemCount: 0, miniGameCount: 0 });
  let s1 = createImportSession("world", beforeWorld, 2);
  const afterRoom20 = makeManifest({ playReady: true, worldReady: true, roomCount: 1, itemCount: 0, miniGameCount: 0 });
  s1 = applyFileResult(s1, makeSummary(afterRoom20, 1));
  s1 = finishSession(s1);
  const o1 = summarizeOutcome(s1);
  assert.equal(o1.kind, "added");
  assert.equal(o1.becameReady, true);
  assert.equal(o1.stats[0]?.amount, 1);

  // Second (post-setup) mixed import opened from "world" context that also brings Items and Mini Games
  let s2 = createImportSession("world", afterRoom20, 3);
  const afterRooms = makeManifest({ playReady: true, roomCount: 8, itemCount: 0, miniGameCount: 0 });
  s2 = applyFileResult(s2, makeSummary(afterRooms, 7));
  assert.equal(s2.lastEvent?.key, "room");

  const afterItems = makeManifest({ playReady: true, roomCount: 8, itemCount: 214, miniGameCount: 0 });
  s2 = applyFileResult(s2, makeSummary(afterItems, 214));
  assert.equal(s2.lastEvent?.key, "item");
  assert.equal(s2.lastEvent?.text, "נמצאו 214 פריטים");

  const afterGames = makeManifest({ playReady: true, roomCount: 8, itemCount: 214, miniGameCount: 4 });
  s2 = applyFileResult(s2, makeSummary(afterGames, 4));
  assert.equal(s2.lastEvent?.key, "game");

  s2 = finishSession(s2);
  const o2 = summarizeOutcome(s2);
  assert.equal(o2.kind, "added");
  assert.equal(o2.becameReady, false);
  assert.equal(o2.foundOutsideContext, true);
  assert.deepEqual(
    o2.stats.map((st) => [st.key, st.amount]),
    [
      ["room", 7],
      ["item", 214],
      ["game", 4],
    ],
  );

  const doneHtml = renderSheet({ kind: "import", session: s2, id: 2 }, makeSheetCtx(afterGames));
  assert.ok(doneHtml.includes(he.importDoneTitle));
  assert.ok(doneHtml.includes(he.alsoFound));
  assert.ok(doneHtml.includes(he.play));
  assert.ok(doneHtml.includes(he.importAddMore));
});

test("Play mode keeps minimal Hebrew chrome around the 768x480 stage", () => {
  const html = renderPlayScreen({ displayName: "Mogobe Android 1.4.7", menuOpen: true, entering: true });
  assert.ok(html.includes(he.back));
  assert.ok(html.includes(he.fullscreen));
  assert.ok(html.includes(he.restartGame));
  assert.ok(html.includes('id="player-host"'));
  assert.ok(!html.includes(he.addContent));
});

test("Incomplete room import shows specific guidance instead of 'not Mogobe files'", () => {
  const before = makeManifest({ playReady: false, worldReady: false, roomCount: 0 });
  const afterR20Swf = makeManifest({ playReady: false, worldReady: false, roomCount: 0 });
  afterR20Swf.categories.world.rooms = [{ roomId: 20, hasSwf: true, hasTxt: false, ready: false }];

  let s = createImportSession("world", before, 1);
  const summary = makeSummary(afterR20Swf, 1);
  summary.items = [{ relativePath: "room_20.swf", status: "added", category: "world", logicalId: "world:room-20-swf" }];
  s = applyFileResult(s, summary);
  s = finishSession(s);

  const outcome = summarizeOutcome(s);
  assert.equal(outcome.kind, "incomplete");
  assert.equal(outcome.incompleteRooms.length, 1);
  assert.equal(outcome.incompleteRooms[0].roomId, 20);
  assert.equal(outcome.incompleteRooms[0].hasSwf, true);
  assert.equal(outcome.incompleteRooms[0].hasTxt, false);

  const html = renderSheet({ kind: "import", session: s, id: 1 }, makeSheetCtx(afterR20Swf));
  assert.ok(html.includes(he.importEntrySwfOnlyTitle));
  assert.ok(html.includes("room_20.txt"));
  assert.ok(!html.includes(he.importUnknownTitle));
});

test("Details sheet decouples mini-game catalog and surfaces unclassified assets", () => {
  // Case A: 0 mini-games imported -> renders empty state, no "עוד לא נוסף"
  const emptyManifest = makeManifest({ miniGameCount: 0 });
  emptyManifest.categories.miniGames.games = [];
  const emptyHtml = renderSheet({ kind: "details", confirmRemove: false }, makeSheetCtx(emptyManifest));
  assert.ok(emptyHtml.includes(he.noGamesYet));
  assert.ok(!emptyHtml.includes("עוד לא נוסף"));

  // Case B: 1 mini-game imported -> only that game is rendered
  const populatedManifest = makeManifest({ miniGameCount: 1 });
  populatedManifest.categories.miniGames.games = [
    {
      id: "lifeguard",
      displayName: "LifeGuard",
      roomId: 30,
      state: "Available",
      hasMainSwf: true,
      hasXml: false,
      hasHelpSwf: true,
      hasManagerSwf: true,
    },
  ];
  populatedManifest.unclassifiedAssets = [
    {
      sha256: "abc123def456",
      originalFilename: "mystery_anim.swf",
      relativePath: "unnamed/mystery_anim.swf",
      size: 4096,
      detectedType: "swf",
      confidence: "PROBABLE_MOGOBE",
      evidence: "Shockwave Flash (SWF) binary",
      importedAt: "2026-01-01T00:00:00.000Z",
      storagePath: "abc123def456_mystery_anim.swf",
    },
  ];

  const populatedHtml = renderSheet({ kind: "details", confirmRemove: false }, makeSheetCtx(populatedManifest));
  assert.ok(populatedHtml.includes("LifeGuard"));
  assert.ok(populatedHtml.includes("זמין"));
  assert.ok(!populatedHtml.includes("עוד לא נוסף"));
  assert.ok(populatedHtml.includes(he.detailsUnclassified));
  assert.ok(populatedHtml.includes("mystery_anim.swf"));
  assert.ok(populatedHtml.includes("Shockwave Flash (SWF) binary"));
});

test("Missing asset classification and toast/log presentation", () => {
  // 1. Classification
  const popupRes = classifyMissingAsset("/Swf/AssetsClean/Popups/popup_3.swf?1.0.0");
  assert.equal(popupRes.category, "popup");
  assert.equal(popupRes.filename, "popup_3.swf");
  assert.ok(popupRes.categoryLabel.includes("Popup"));

  const roomRes = classifyMissingAsset("/Swf/Assets/Rooms/room_20.swf");
  assert.equal(roomRes.category, "room");
  assert.equal(roomRes.filename, "room_20.swf");

  const soundRes = classifyMissingAsset("/Sound/bg_music.mp3");
  assert.equal(soundRes.category, "sound");

  const itemRes = classifyMissingAsset("/Swf/Assets/Items/1234.swf");
  assert.equal(itemRes.category, "item");

  const xmlRes = classifyMissingAsset("/Xmls/maps.xml");
  assert.equal(xmlRes.category, "interface");

  // 2. Play Chrome missing assets chip and menu
  const playEmpty = renderPlayScreen({
    displayName: "Mogobe 2016",
    menuOpen: true,
    entering: false,
    missingCount: 0,
  });
  assert.ok(!playEmpty.includes("has-missing"));
  assert.ok(playEmpty.includes(he.missingAssetsLog));

  const playMissing = renderPlayScreen({
    displayName: "Mogobe 2016",
    menuOpen: false,
    entering: false,
    missingCount: 4,
  });
  assert.ok(playMissing.includes("has-missing"));
  assert.ok(playMissing.includes("play-chip-badge"));
  assert.ok(playMissing.includes(">4<"));

  // 3. Fading Toast rendering
  assert.equal(renderMissingAssetToast(null), "");

  const singleToast = renderMissingAssetToast({
    filename: "popup_3.swf",
    categoryLabel: "חלון קופץ (Popup)",
    batchCount: 1,
    timestamp: Date.now(),
  });
  assert.ok(singleToast.includes("missing-asset-toast"));
  assert.ok(singleToast.includes("popup_3.swf"));
  assert.ok(singleToast.includes("חלון קופץ"));
  assert.ok(singleToast.includes(he.viewLog));

  const batchToast = renderMissingAssetToast({
    filename: "room_20.txt",
    categoryLabel: "חדר (Room)",
    batchCount: 5,
    timestamp: Date.now(),
  });
  assert.ok(batchToast.includes("5"));
  assert.ok(batchToast.includes("room_20.txt"));

  // 4. Missing Assets Sheet: Empty and populated
  const emptyCtx: SheetContext = {
    ...makeSheetCtx(makeManifest()),
    missingAssets: [],
  };
  const emptySheetHtml = renderSheet({ kind: "missing-log" }, emptyCtx);
  assert.ok(emptySheetHtml.includes(he.missingAssetsLog));
  assert.ok(emptySheetHtml.includes(he.noMissingAssetsYet));

  const sampleEntries: MissingAssetEntry[] = [
    {
      id: "miss-1",
      url: "http://127.0.0.1:5173/Swf/AssetsClean/Popups/popup_3.swf?1.0.0",
      path: "/Swf/AssetsClean/Popups/popup_3.swf",
      filename: "popup_3.swf",
      category: "popup",
      categoryLabel: "חלון קופץ (Popup)",
      timestamp: 1700000000000,
      timeFormatted: "14:30:00",
      count: 2,
    },
    {
      id: "miss-2",
      url: "http://127.0.0.1:5173/Sound/click.mp3",
      path: "/Sound/click.mp3",
      filename: "click.mp3",
      category: "sound",
      categoryLabel: "סאונד / מוזיקה",
      timestamp: 1700000005000,
      timeFormatted: "14:30:05",
      count: 1,
    },
  ];
  const populatedCtx: SheetContext = {
    ...makeSheetCtx(makeManifest()),
    missingAssets: sampleEntries,
  };
  const populatedSheetHtml = renderSheet({ kind: "missing-log" }, populatedCtx);
  assert.ok(populatedSheetHtml.includes(he.missingAssetsLog));
  assert.ok(populatedSheetHtml.includes("popup_3.swf"));
  assert.ok(populatedSheetHtml.includes("click.mp3"));
  assert.ok(populatedSheetHtml.includes("×2"));
  assert.ok(populatedSheetHtml.includes("/Swf/AssetsClean/Popups/popup_3.swf"));
  assert.ok(populatedSheetHtml.includes(he.copyMissingList));
  assert.ok(populatedSheetHtml.includes(he.clearLog));
});
