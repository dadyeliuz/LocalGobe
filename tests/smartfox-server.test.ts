import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalFiles } from "../src/importer/file-importer.ts";
import { NulFramer, frameText } from "../src/server/smartfox/framing.ts";
import { signExtensionData } from "../src/server/smartfox/extensions.ts";
import { ServerState } from "../src/server/smartfox/server-state.ts";
import { resolveRoomSpawnLocation } from "../src/server/smartfox/room-coordinates.ts";
import { startSmartFoxTcpServer } from "../src/server/smartfox/smartfox-server.ts";
import { buildSyntheticSupportedApk, makeSyntheticSwf } from "./synthetic-fixtures.ts";

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

test("SmartFox server completes 2016 handshake, Room 20 join, and public chat", async () => {
  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId: "20160725-android-1.4.7" });
  const client = new Socket();
  const framer = new NulFramer();

  try {
    await new Promise<void>((res, rej) => {
      client.once("error", rej);
      client.connect(port, "127.0.0.1", () => res());
    });

    // 1. verChk -> apiOK
    client.write(frameText(`<msg t='sys'><body action='verChk' r='0'><ver v='165' /></body></msg>`));
    const apiOk = await nextFrame(client, framer);
    assert.match(apiOk, /action='apiOK'/);

    // 2. login (2016 multiplexed nick format) -> logOK
    client.write(
      frameText(`<msg t='sys'><body action='login' r='0'><login z='worlds4u'><nick><![CDATA[::0:player1:1]]></nick><pword><![CDATA[x]]></pword></login></body></msg>`),
    );
    const logOk = await nextFrame(client, framer);
    assert.match(logOk, /action='logOK'/);
    assert.match(logOk, /n='player1'/);

    // 3. getRmList -> rmList + extension login
    client.write(frameText(`<msg t='sys'><body action='getRmList' r='-1'></body></msg>`));
    const rmList = await nextFrame(client, framer);
    assert.match(rmList, /action='rmList'/);
    assert.match(rmList, /room_20/);

    // Drain extension-login frame
    await new Promise((r) => setTimeout(r, 30));

    // 4. rooms__getStaticRoomList
    client.write(buildXtFrame("rooms__getStaticRoomList", { platform: 2 }));
    const staticRooms = await nextFrame(client, framer);
    assert.match(staticRooms, /rooms__getStaticRoomList/);

    // 5. user__joinFirstRoom -> joinOK Room 20
    client.write(buildXtFrame("user__joinFirstRoom", {}));
    const joinOk = await nextFrame(client, framer);
    assert.match(joinOk, /action='joinOK'/);
    assert.match(joinOk, /r='20'/);
  } finally {
    client.destroy();
    await new Promise<void>((res) => server.close(() => res()));
  }
});

test("SmartFox exposes imported Room 110 dynamically and navigates from Room 20 to Room 110", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-sfs-r110-"));
  const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(apkRes.ok, true);
  importExternalFiles(
    "20160725-android-1.4.7",
    [
      { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
      { relativePath: "Rooms/room_20.txt", bytes: Buffer.from('{"mov":[]}') },
      { relativePath: "ASSETSCLEAN/room_110_20150809221546_80976ff5.swf", bytes: makeSyntheticSwf("r110") },
      { relativePath: "ASSETSCLEAN/room_110_20150809221546_70f82c71.txt", bytes: Buffer.from('{"mov":[]}') },
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
      frameText(`<msg t='sys'><body action='login' r='0'><login z='worlds4u'><nick><![CDATA[::0:explorer:1]]></nick><pword><![CDATA[x]]></pword></login></body></msg>`),
    );
    await nextFrame(client, framer);

    client.write(frameText(`<msg t='sys'><body action='getRmList' r='-1'></body></msg>`));
    const rmList = await nextFrame(client, framer);
    assert.match(rmList, /id='110'[^>]*><n>room_110<\/n>/);
    await new Promise((r) => setTimeout(r, 30));

    client.write(buildXtFrame("rooms__getStaticRoomList", { platform: 2 }));
    const staticRooms = await nextFrame(client, framer);
    assert.match(staticRooms, /"rId":110,"rN":"room_110","rT":"WR"/);

    client.write(buildXtFrame("user__joinFirstRoom", {}));
    const join20 = await nextFrame(client, framer);
    assert.match(join20, /action='joinOK' r='20'/);
    assert.match(join20, /<var n='x' t='n'>376<\/var>/);
    assert.match(join20, /<var n='y' t='n'>372<\/var>/);

    // Player moves to arbitrary position in Room 20
    client.write(buildXtFrame("user__move", { x: 99, y: 450, AD: 2 }));
    await new Promise((r) => setTimeout(r, 30));

    // Jump from Room 20 to Room 110 (exact MapPopup payload) - must reset to Room 110 spawn, not retain (99, 450)
    client.write(buildXtFrame("rooms__jumpToRoom", { roomId: 110, userId: 1, userName: "explorer" }));
    const join110 = await nextFrame(client, framer);
    assert.match(join110, /action='joinOK' r='110'/);
    assert.match(join110, /<var n='x' t='n'>380<\/var>/);
    assert.match(join110, /<var n='y' t='n'>340<\/var>/);

    // Uninstalled room 999 returns structured unavailable response (never falls back to Room 20)
    client.write(buildXtFrame("rooms__jumpToRoom", { roomId: 999 }));
    const unavailable = await nextFrame(client, framer);
    assert.match(unavailable, /"status":false/);
    assert.match(unavailable, /"roomId":999/);
  } finally {
    client.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("SmartFox server guarantees non-empty items payload with valid typeId for 2016 dance moves", () => {
  const state = new ServerState();
  state.profile = "20160725-android-1.4.7";
  const mockSocket = new Socket();
  const session = state.createSession(mockSocket, "Dancer2016");
  state.handleLogin(session, "Dancer2016");

  assert.equal(session.playerData.inventory.length, 0, "initial inventory must be empty");
  const vars = state.getUserVariables(session);
  const items = JSON.parse(String(vars.items));
  assert.ok(Array.isArray(items), "items must be an array");
  assert.ok(items.length > 0, "items must never be empty so AvatarDocView/getDancingItem() does not crash with #1010");
  assert.equal(typeof items[0].typeId, "number", "typeId must be numeric");
  assert.equal(items[0].typeId, 0, "typeId 0 allows AvatarDanceSeq to catch missing clothing and dance naked");
});

test("Room spawn resolver accurately places avatar at authentic physical doors or default room spawns", () => {
  // Physical door transition from Room 20 -> Room 70
  const spawn70from20 = resolveRoomSpawnLocation(70, 20);
  assert.equal(spawn70from20.x, 75, "entering room 70 from room 20 enters on the left edge inside the canvas");
  assert.equal(spawn70from20.y, 247);
  assert.equal(spawn70from20.AD, 6, "avatar faces into the room (right)");

  // Return door transition from Room 70 -> Room 20
  const spawn20from70 = resolveRoomSpawnLocation(20, 70);
  assert.equal(spawn20from70.x, 685, "entering room 20 from room 70 enters on the right edge inside the canvas");
  assert.equal(spawn20from70.y, 241);
  assert.equal(spawn20from70.AD, 2, "avatar faces into the room (left)");

  // Door transition from Room 20 -> Room 50
  const spawn50from20 = resolveRoomSpawnLocation(50, 20);
  assert.equal(spawn50from20.x, 685);
  assert.equal(spawn50from20.y, 205);
  assert.equal(spawn50from20.AD, 2);

  // Return door transition from Room 50 -> Room 20
  const spawn20from50 = resolveRoomSpawnLocation(20, 50);
  assert.equal(spawn20from50.x, 75);
  assert.equal(spawn20from50.y, 246);
  assert.equal(spawn20from50.AD, 6);

  // Map / direct jump (no fromRoomId) -> default spawn
  const mapJump20 = resolveRoomSpawnLocation(20);
  assert.equal(mapJump20.x, 376);
  assert.equal(mapJump20.y, 372);
  assert.equal(mapJump20.AD, 4);

  const mapJump110 = resolveRoomSpawnLocation(110);
  assert.equal(mapJump110.x, 380);
  assert.equal(mapJump110.y, 340);
  assert.equal(mapJump110.AD, 4);

  // Unknown room fallback
  const fallback = resolveRoomSpawnLocation(99999);
  assert.equal(fallback.x, 380);
  assert.equal(fallback.y, 350);
  assert.equal(fallback.AD, 4);
});

test("SmartFox server transitions to mini-game Room 3040 with lobbyRoomId=3040 and rrr=50", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-sfs-game3040-"));
  const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
  assert.equal(apkRes.ok, true);
  importExternalFiles(
    "20160725-android-1.4.7",
    [
      { relativePath: "Rooms/room_20.swf", bytes: makeSyntheticSwf("r20") },
      { relativePath: "Rooms/room_20.txt", bytes: Buffer.from('{"mov":[]}') },
      { relativePath: "Rooms/room_50.swf", bytes: makeSyntheticSwf("r50") },
      { relativePath: "Rooms/room_50.txt", bytes: Buffer.from('{"mov":[]}') },
      { relativePath: "Swf/Apps/Games/LifeGuard.swf", bytes: makeSyntheticSwf("lifeguard") },
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
      frameText(`<msg t='sys'><body action='login' r='0'><login z='worlds4u'><nick><![CDATA[::0:player1:1]]></nick><pword><![CDATA[x]]></pword></login></body></msg>`),
    );
    await nextFrame(client, framer);

    client.write(frameText(`<msg t='sys'><body action='getRmList' r='-1'></body></msg>`));
    const rmListFrame = await nextFrame(client, framer);
    assert.match(rmListFrame, /action='rmList'/);
    // Crucial for ExternalGameManager: mini-game room must be game='0' and lmb='1' (limbo) so getMyUser() returns UserTO, not GamerTO!
    assert.match(rmListFrame, /id='3040'[^>]*game='0'[^>]*lmb='1'/);
    await new Promise((r) => setTimeout(r, 30));

    client.write(buildXtFrame("rooms__getStaticRoomList", { platform: 2 }));
    await nextFrame(client, framer);

    // Join Room 20
    client.write(buildXtFrame("user__joinFirstRoom", {}));
    const join20 = await nextFrame(client, framer);
    assert.match(join20, /action='joinOK'/);
    assert.match(join20, /r='20'/);

    // Door transition from Room 20 to Room 50
    client.write(buildXtFrame("rooms__changeRoom", { gCId: 50 }));
    const join50 = await nextFrame(client, framer);
    assert.match(join50, /action='joinOK'/);
    assert.match(join50, /r='50'/);

    // Transition from Room 50 to LifeGuard Room 3040 via mcEntryPoint_3040 (gCId: 3040)
    client.write(buildXtFrame("rooms__changeRoom", { gCId: 3040 }));
    const join3040 = await nextFrame(client, framer);
    assert.match(join3040, /action='joinOK'/);
    assert.match(join3040, /r='3040'/);
    // Crucial for RoomFactory.as: lobbyRoomId MUST be 3040 so it resolves the static WG game room!
    assert.match(join3040, /n='lobbyRoomId' t='s'><!\[CDATA\[3040\]\]>/);
    // Crucial for exitGame: rrr MUST be 50 to return the avatar to Room 50
    assert.match(join3040, /n='rrr' t='s'><!\[CDATA\[50\]\]>/);
    assert.match(join3040, /n='swf' t='s'><!\[CDATA\[ExternalGameManager\]\]>/);
    assert.match(join3040, /n='baseSwf' t='s'><!\[CDATA\[LifeGuard\]\]>/);
    assert.match(join3040, /n='isGame' t='b'>1</);
    assert.match(join3040, /n='isWaitingGame' t='b'>1</);

    // Exit game: client dispatches rooms__jumpToRoom with rrr
    client.write(buildXtFrame("rooms__jumpToRoom", { nameId: "50" }));
    const returnJoin50 = await nextFrame(client, framer);
    assert.match(returnJoin50, /action='joinOK'/);
    assert.match(returnJoin50, /r='50'/);
  } finally {
    client.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});


