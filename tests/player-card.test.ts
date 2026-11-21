import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { importExternalFiles } from "../src/importer/file-importer.ts";
import { getPlayerCardStatus, readBuildManifest } from "../src/storage/build-store.ts";
import { createOrEnsureAccount } from "../src/storage/accounts-store.ts";
import { handleGameRoute } from "../src/server/http/game-routes.ts";
import { NulFramer, frameText } from "../src/server/smartfox/framing.ts";
import { signExtensionData } from "../src/server/smartfox/extensions.ts";
import { startSmartFoxTcpServer } from "../src/server/smartfox/smartfox-server.ts";
import { buildSyntheticSupportedApk, makeSyntheticSwf } from "./synthetic-fixtures.ts";

function buildXtFrame(cmd: string, payload: unknown, room = -1): Buffer {
  const d = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const m = signExtensionData(d);
  return frameText(JSON.stringify({ t: "xt", b: { x: "worlds4uEx", c: cmd, r: room, p: { d, m } } }));
}

function parseXtFrame(frameStr: string): { command: string; payload: Record<string, unknown> } | null {
  try {
    const obj = JSON.parse(frameStr) as {
      b?: {
        o?: Record<string, unknown> & { _cmd?: string };
        c?: string;
        p?: { d?: string };
      };
    };
    if (obj?.b?.o?._cmd) {
      const { _cmd, ...payload } = obj.b.o;
      return { command: _cmd, payload };
    }
    if (obj?.b?.c && obj.b?.p?.d) {
      const payload = JSON.parse(Buffer.from(obj.b.p.d, "base64").toString("utf8")) as Record<string, unknown>;
      return { command: obj.b.c, payload };
    }
  } catch {}
  return null;
}

class TestClient {
  readonly socket: Socket;
  readonly queue: string[] = [];
  readonly waiters: Array<(frame: string) => void> = [];
  readonly framer = new NulFramer();

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      const frames = this.framer.push(chunk);
      for (const f of frames) {
        const text = f.toString("utf8");
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(text);
        } else {
          this.queue.push(text);
        }
      }
    });
  }

  async nextFrame(tag = "unknown", timeoutMs = 3000): Promise<string> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolveWrapper);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`[${tag}] Timed out waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const resolveWrapper = (frame: string) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(resolveWrapper);
    });
  }

  async nextXt(expectedCmd: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const received: string[] = [];
    while (Date.now() < deadline) {
      const frameStr = await this.nextFrame(`xt:${expectedCmd}`, Math.max(100, deadline - Date.now()));
      received.push(frameStr.slice(0, 100));
      const parsed = parseXtFrame(frameStr);
      if (parsed && parsed.command === expectedCmd) {
        return parsed.payload;
      }
    }
    throw new Error(`Timed out waiting for XT command: ${expectedCmd}. Received: ${JSON.stringify(received)}`);
  }

  write(buf: Buffer): void {
    this.socket.write(buf);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function performHandshakeAndJoin(
  client: TestClient,
  username: string,
): Promise<number> {
  client.write(frameText("<msg t='sys'><body action='verChk' r='0'><ver v='165' /></body></msg>"));
  await client.nextFrame(`${username}:verChk`);

  client.write(
    frameText(
      `<msg t='sys'><body action='login' r='0'><login z='worlds4u'><nick><![CDATA[::0:${username}:1]]></nick><pword><![CDATA[x]]></pword></login></body></msg>`,
    ),
  );
  const logOk = await client.nextFrame(`${username}:login`);
  const idMatch = /id='(\d+)'/.exec(logOk);
  const userId = idMatch ? Number(idMatch[1]) : 1;

  client.write(frameText("<msg t='sys'><body action='getRmList' r='-1'></body></msg>"));
  await client.nextFrame(`${username}:rmList`);
  await client.nextXt("login");

  client.write(buildXtFrame("rooms__getStaticRoomList", { platform: 2 }));
  await client.nextXt("rooms__getStaticRoomList");

  client.write(buildXtFrame("user__joinFirstRoom", {}));
  await client.nextFrame(`${username}:joinOK`);

  return userId;
}

test("Player Card intake recognizes MogoWall.swf, FriendCard.swf, MogoWall.txt as group or individually", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-card-intake-"));
  try {
    const buildId = "20160725-android-1.4.7";
    const apkRes = importApkBuffer(buildSyntheticSupportedApk(), { dataDir });
    assert.equal(apkRes.ok, true);

    // Initial status before intake
    let status = getPlayerCardStatus(buildId, dataDir);
    assert.equal(status.mogoWallSwfPresent, false);
    assert.equal(status.friendCardSwfPresent, false);
    assert.equal(status.mogoWallConfigPresent, false);

    // 1. Group intake (folder intake)
    const syntheticWallSwf = makeSyntheticSwf("mogowall-test");
    const syntheticFriendSwf = makeSyntheticSwf("friendcard-test");
    const syntheticWallTxt = Buffer.from("v=1.0.0\nWall=enabled\n");

    const groupSummary = importExternalFiles(
      buildId,
      [
        { relativePath: "Mogowall-2017/MogoWall.swf", bytes: syntheticWallSwf },
        { relativePath: "Mogowall-2017/FriendCard.swf", bytes: syntheticFriendSwf },
        { relativePath: "Mogowall-2017/MogoWall.txt", bytes: syntheticWallTxt },
      ],
      { dataDir },
    );

    assert.equal(groupSummary.addedCount, 3);
    assert.equal(groupSummary.addedByCategory.interface, 3);

    status = getPlayerCardStatus(buildId, dataDir);
    assert.equal(status.mogoWallSwfPresent, true);
    assert.equal(status.friendCardSwfPresent, true);
    assert.equal(status.mogoWallConfigPresent, true);

    const manifest = readBuildManifest(buildId, dataDir);
    assert.ok(manifest);
    assert.deepEqual(manifest.categories.interface.playerCard, {
      mogoWallSwfPresent: true,
      friendCardSwfPresent: true,
      mogoWallConfigPresent: true,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Player Card intake works for separate, unordered individual files", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-card-indiv-"));
  try {
    const buildId = "20160725-android-1.4.7";
    importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

    // Import TXT first
    importExternalFiles(
      buildId,
      [{ relativePath: "MogoWall.txt", bytes: Buffer.from("config=test") }],
      { dataDir },
    );
    let status = getPlayerCardStatus(buildId, dataDir);
    assert.equal(status.mogoWallConfigPresent, true);
    assert.equal(status.mogoWallSwfPresent, false);
    assert.equal(status.friendCardSwfPresent, false);

    // Import FriendCard.swf second
    importExternalFiles(
      buildId,
      [{ relativePath: "FriendCard.swf", bytes: makeSyntheticSwf("fc") }],
      { dataDir },
    );
    status = getPlayerCardStatus(buildId, dataDir);
    assert.equal(status.mogoWallConfigPresent, true);
    assert.equal(status.friendCardSwfPresent, true);
    assert.equal(status.mogoWallSwfPresent, false);

    // Import MogoWall.swf third
    importExternalFiles(
      buildId,
      [{ relativePath: "MogoWall.swf", bytes: makeSyntheticSwf("mw") }],
      { dataDir },
    );
    status = getPlayerCardStatus(buildId, dataDir);
    assert.equal(status.mogoWallConfigPresent, true);
    assert.equal(status.friendCardSwfPresent, true);
    assert.equal(status.mogoWallSwfPresent, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("HTTP routes serve MogoWall.swf, FriendCard.swf, MogoWall.txt with double-slash and query toleration", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-card-http-"));
  try {
    const buildId = "20160725-android-1.4.7";
    importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

    const wallSwfBytes = makeSyntheticSwf("wall-bytes");
    const friendSwfBytes = makeSyntheticSwf("friend-bytes");
    const wallTxtBytes = Buffer.from("layout=default");

    // Before import: expect 404 (no fallback fake assets)
    const beforeWall = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall/MogoWall.swf",
    });
    assert.equal(beforeWall?.status, 404);

    // Import original assets
    importExternalFiles(
      buildId,
      [
        { relativePath: "MogoWall.swf", bytes: wallSwfBytes },
        { relativePath: "FriendCard.swf", bytes: friendSwfBytes },
        { relativePath: "MogoWall.txt", bytes: wallTxtBytes },
      ],
      { dataDir },
    );

    // 1. Serving MogoWall.swf
    const resWall = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall/MogoWall.swf",
    });
    assert.equal(resWall?.status, 200);
    assert.equal(resWall?.mime, "application/x-shockwave-flash");
    assert.deepEqual(resWall?.body, wallSwfBytes);

    // Query string tolerance
    const resWallQuery = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall/MogoWall.swf?1.0.0",
    });
    assert.equal(resWallQuery?.status, 200);
    assert.deepEqual(resWallQuery?.body, wallSwfBytes);

    // 2. Serving FriendCard.swf
    const resFriend = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall/FriendCard.swf",
    });
    assert.equal(resFriend?.status, 200);
    assert.equal(resFriend?.mime, "application/x-shockwave-flash");
    assert.deepEqual(resFriend?.body, friendSwfBytes);

    // 3. Serving MogoWall.txt
    const resTxt = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall/MogoWall.txt",
    });
    assert.equal(resTxt?.status, 200);
    assert.equal(resTxt?.mime, "text/plain; charset=utf-8");
    assert.deepEqual(resTxt?.body, wallTxtBytes);

    // 4. Double-slash historical normalization: /Swf/AssetsClean/MogoWall//MogoWall.txt
    const resDoubleSlash = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall//MogoWall.txt",
    });
    assert.equal(resDoubleSlash?.status, 200);
    assert.deepEqual(resDoubleSlash?.body, wallTxtBytes);

    // 5. Query string with double slash: /Swf/AssetsClean/MogoWall//MogoWall.txt?appVer=1.4.7
    const resDoubleSlashQuery = handleGameRoute({
      buildId,
      dataDir,
      pathname: "/Swf/AssetsClean/MogoWall//MogoWall.txt?appVer=1.4.7",
    });
    assert.equal(resDoubleSlashQuery?.status, 200);
    assert.deepEqual(resDoubleSlashQuery?.body, wallTxtBytes);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("SmartFox user__getUserCardInfo guarantees non-null hearts and honest availability", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-card-sfs-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  // Create an offline account in accounts-store
  createOrEnsureAccount("persisted_player", "secretPass", 12, dataDir);

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA = new Socket();
  const sockB = new Socket();

  let clientA: TestClient | null = null;
  let clientB: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA.connect(port, "127.0.0.1", () => res()));
    clientA = new TestClient(sockA);
    const userAId = await performHandshakeAndJoin(clientA, "userA");

    await new Promise<void>((res) => sockB.connect(port, "127.0.0.1", () => res()));
    clientB = new TestClient(sockB);
    const userBId = await performHandshakeAndJoin(clientB, "userB");

    // ── 1. Own card request (User A requests own card info) ──
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: userAId }));
    const ownCard = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(ownCard.userName, "userA");

    // Critical fix: hearts MUST NOT be null
    assert.ok(ownCard.hearts);
    const ownHearts = ownCard.hearts as Record<string, unknown>;
    assert.equal(typeof ownHearts.toGive, "number");
    assert.equal(typeof ownHearts.toGiveMax, "number");
    assert.equal(typeof ownHearts.received, "number");

    // Honest availability for own card: cannot chat or trade with oneself
    assert.equal(ownCard.isAvliablChat, false);
    assert.equal(ownCard.isAvliablTrade, false);
    assert.equal(ownCard.isAllowToAdd, false);
    assert.equal(ownCard.member, false);
    assert.deepEqual(ownCard.groups, []);
    assert.equal(ownCard.isBlock, false);

    // ── 2. Other player in same room (User A requests User B's card info) ──
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: userBId }));
    const friendCard = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(friendCard.userName, "userB");

    // Critical fix: hearts present
    assert.ok(friendCard.hearts);
    // Honest availability: both in Room 20, online, not busy -> available = true
    assert.equal(friendCard.isAvliablChat, true);
    assert.equal(friendCard.isAvliablTrade, true);
    assert.equal(friendCard.isAllowToAdd, true);

    // ── 3. Offline persisted player lookup ──
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: -1, userName: "persisted_player" }));
    const offlineCard = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(offlineCard.userName, "persisted_player");
    assert.ok(offlineCard.hearts);
    // Honest availability: offline player -> cannot chat or trade
    assert.equal(offlineCard.isAvliablChat, false);
    assert.equal(offlineCard.isAvliablTrade, false);

    // ── 4. user__getUserCard for offline persisted player ──
    clientA.write(buildXtFrame("user__getUserCard", { userId: -1, userName: "persisted_player" }));
    const userCard = await clientA.nextXt("user__getUserCard");
    assert.equal(userCard.userName, "persisted_player");
    assert.equal(userCard.online, false);
    assert.equal(userCard.color, 12);
    assert.equal(userCard.mo_1, 500);
    // Ensure no secrets leaked
    assert.equal(userCard.passwordHash, undefined);
    assert.equal(userCard.salt, undefined);

    // ── 5. user__updateAvatarInUseItems acknowledgment ──
    clientA.write(buildXtFrame("user__updateAvatarInUseItems", { items: [] }));
    const updateRes = await clientA.nextXt("user__updateAvatarInUseItems");
    assert.equal(updateRes.status, true);

    // ── 6. rewardSystem stubs ──
    clientA.write(buildXtFrame("rewardSystem__getStatus", {}));
    const rewardStatus = await clientA.nextXt("rewardSystem__getStatus");
    assert.deepEqual(rewardStatus.status, []);

    clientA.write(buildXtFrame("rewardSystem__getDetails", { showPage: 6 }));
    const rewardDetails = await clientA.nextXt("rewardSystem__getDetails");
    assert.equal(rewardDetails.showPage, 6);
    assert.ok(rewardDetails.hearts);
  } finally {
    clientA?.destroy();
    clientB?.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
