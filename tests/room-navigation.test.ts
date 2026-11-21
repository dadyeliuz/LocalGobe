import assert from "node:assert/strict";
import { test } from "node:test";
import { Socket } from "node:net";
import {
  CANONICAL_ROOM_ALIASES,
  resolveTargetRoomId,
  resolveTargetRoomIdDetailed,
  WORLD_MAP_NAVIGATION_MANIFEST,
} from "../src/server/smartfox/room-navigation.ts";
import { ServerState } from "../src/server/smartfox/server-state.ts";

test("World map navigation manifest maps all button identifiers to authentic room targets", () => {
  const expectedMappings: Record<string, number> = {
    TelAviv: 20,
    Jerusalem: 100,
    Market: 140,
    Eilat: 110,
    Haifa: 160,
    PrivateRoom: 1,
    TelAvivNight: 50,
    KingsRoad: 70,
    Desertia: 250,
    ForestRiver: 430,
    Pool: 150,
    Arava: 500,
    HalavV: 630,
    Shugibeach: 660,
    Airplane: 730,
    NewHousesArea: 10010,
    NakikHaNesharim: 760,
  };

  assert.equal(WORLD_MAP_NAVIGATION_MANIFEST.length, Object.keys(expectedMappings).length);

  for (const entry of WORLD_MAP_NAVIGATION_MANIFEST) {
    const expected = expectedMappings[entry.nameId];
    assert.ok(expected !== undefined, `Unexpected entry ${entry.nameId} in world map navigation manifest`);
    assert.equal(entry.targetRoomId, expected, `Manifest targetRoomId for ${entry.nameId} must be ${expected}`);
    assert.equal(entry.source, "MAP_BUTTON");

    // Test resolution through resolver
    const resolved = resolveTargetRoomId({ nameId: entry.nameId });
    assert.equal(resolved, expected, `Resolver must resolve ${entry.nameId} to ${expected}`);
  }
});

test("Room destination resolution never defaults to Room 20 on unrecognized or blank payloads", () => {
  assert.equal(resolveTargetRoomId(undefined), null);
  assert.equal(resolveTargetRoomId({}), null);
  assert.equal(resolveTargetRoomId({ nameId: "" }), null);
  assert.equal(resolveTargetRoomId({ nameId: "nonexistent_room_xyz" }), null);

  const detailedUnrecognized = resolveTargetRoomIdDetailed({ nameId: "nonexistent_room_xyz" });
  assert.equal(detailedUnrecognized.roomId, null);
  assert.equal(detailedUnrecognized.rule, "UNKNOWN_STRING_IDENTIFIER");
});

test("Room destination resolver handles physical doors, numeric IDs, and canonical aliases", () => {
  // Physical door
  assert.equal(resolveTargetRoomId({ gCId: 70 }), 70);
  assert.equal(resolveTargetRoomId({ grfCompunentId: 110 }), 110);

  // Direct numeric
  assert.equal(resolveTargetRoomId({ roomId: 140 }), 140);
  assert.equal(resolveTargetRoomId({ targetRoomId: 160 }), 160);

  // String numeric / prefix
  assert.equal(resolveTargetRoomId({ nameId: "250" }), 250);
  assert.equal(resolveTargetRoomId({ nameId: "room_50" }), 50);

  // Canonical alias
  assert.equal(resolveTargetRoomId({ nameId: "Cinema" }), CANONICAL_ROOM_ALIASES.Cinema);
  assert.equal(resolveTargetRoomId({ nameId: "AzrieliStore" }), 60);
});

test("Store protocol purchase failure and currency response semantics", () => {
  const state = new ServerState();
  const mockSocket = new Socket();
  const session = state.createSession(mockSocket, "Shopper");
  state.handleLogin(session, "Shopper");

  // In production runtime, store catalog is empty by default:
  assert.equal(state.storeCatalog.length, 0);

  // Attempting to buy an item when catalog is unavailable returns msgId 2 (generic purchase failure)
  const missingResult = state.buyItem(session, 109);
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.msgId, 2, "msgId 2 represents generic purchase failure response");

  // Test with configured catalog item
  state.storeCatalog.push({
    id: 10001,
    typeId: 109,
    sCat: 1,
    pCat: 3,
    price: 10000, // expensive
    inStock: true,
    locked: false,
    sts: 0,
    src: 1,
    s: 0,
    trd: 1,
    mType: 1,
  });

  // User has default 500 coins, price is 10000 -> msgId 1 (insufficient currency)
  session.playerData.coins = 500;
  const poorResult = state.buyItem(session, 109);
  assert.equal(poorResult.success, false);
  assert.equal(poorResult.msgId, 1, "msgId 1 represents insufficient-currency response");

  // When user has sufficient coins -> success
  session.playerData.coins = 20000;
  const successResult = state.buyItem(session, 109);
  assert.equal(successResult.success, true);
  assert.equal(session.playerData.coins, 10000, "Coins must be deducted");
  assert.equal(session.playerData.inventory.length, 1, "Item must be added to user inventory");
  assert.equal(session.playerData.inventory[0].typeId, 109);
});
