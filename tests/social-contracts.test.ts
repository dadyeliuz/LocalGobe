import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importApkBuffer } from "../src/importer/apk-importer.ts";
import { createOrEnsureAccount, getAccountId } from "../src/storage/accounts-store.ts";
import { NulFramer, frameText } from "../src/server/smartfox/framing.ts";
import { signExtensionData } from "../src/server/smartfox/extensions.ts";
import { startSmartFoxTcpServer } from "../src/server/smartfox/smartfox-server.ts";
import { buildSyntheticSupportedApk } from "./synthetic-fixtures.ts";

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

test("Social contracts: complete buddy state machine (request -> accept -> best friend -> normal -> block -> unblock)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-social-buddy-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  createOrEnsureAccount("Alice", "passAlice", 10, dataDir);
  createOrEnsureAccount("Bob", "passBob", 11, dataDir);

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA = new Socket();
  const sockB = new Socket();
  let clientA: TestClient | null = null;
  let clientB: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA.connect(port, "127.0.0.1", () => res()));
    clientA = new TestClient(sockA);
    const aliceId = await performHandshakeAndJoin(clientA, "Alice");

    await new Promise<void>((res) => sockB.connect(port, "127.0.0.1", () => res()));
    clientB = new TestClient(sockB);
    const bobId = await performHandshakeAndJoin(clientB, "Bob");

    const aliceAccId = getAccountId("Alice", dataDir);
    const bobAccId = getAccountId("Bob", dataDir);

    // ── 1. Alice adds Bob via real FriendInfoView room-click payload shape (buddyId: 0, buddyName: "Bob") ──
    clientA.write(buildXtFrame("buddyList__addBuddyRequest", { buddyId: 0, buddyName: "Bob" }));
    const addRes = await clientA.nextXt("buddyList__addBuddyRequest");
    assert.equal(addRes.status, true);

    // Bob receives unsolicited realtime server push notification on his live session
    const bobPush = await clientB.nextXt("buddyList__addBuddyRequest");
    assert.equal(bobPush.msgId, -1);
    assert.equal(bobPush.numRequests, 1);

    // When Bob opens MogoWall normally, it requests Friends tab (showPage = 3).
    // The server response MUST contain all relationships including incoming requests (status: 1),
    // because WallFreindListView filters WallData.friendsList locally and switching to the Request tab
    // does NOT perform a new server request.
    clientB.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const bobWallFriends = await clientB.nextXt("buddyList__getUserBuddies");
    assert.equal(bobWallFriends.showPage, 3);
    const bobReqInWall = (bobWallFriends.buddies as Array<{ buddyId: number; buddyName: string; status: number }>).filter(
      (b) => b.status === 1,
    );
    assert.equal(bobReqInWall.length, 1);
    assert.equal(bobReqInWall[0].buddyName, "Alice");
    assert.equal(bobReqInWall[0].buddyId, aliceAccId);

    // Bob inspects Request tab directly (showPage = 5, e.g. clicking btnBodyOffer): should see Alice with status 1
    clientB.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 5 }));
    const bobRequests = await clientB.nextXt("buddyList__getUserBuddies");
    assert.equal(bobRequests.showPage, 5);
    const bobReqBuddies = bobRequests.buddies as Array<{ buddyId: number; buddyName: string; status: number }>;
    assert.equal(bobReqBuddies.length, 1);
    assert.equal(bobReqBuddies[0].buddyName, "Alice");
    assert.equal(bobReqBuddies[0].status, 1);
    assert.equal(bobReqBuddies[0].buddyId, aliceAccId);

    // Alice inspects Request tab (showPage = 5): should NOT see Bob (Alice sent outgoing request)
    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 5 }));
    const aliceRequests = await clientA.nextXt("buddyList__getUserBuddies");
    assert.equal((aliceRequests.buddies as Array<unknown>).length, 0);

    // Card check: while request is pending, isAllowToAdd is false
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: bobId }));
    const cardBforA = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(cardBforA.isAllowToAdd, false);

    // ── 2. Bob accepts Alice's request using stable account ID ──
    clientB.write(buildXtFrame("buddyList__acceptBuddysRequest", { buddys: [aliceAccId] }));
    const acceptRes = await clientB.nextXt("buddyList__acceptBuddysRequest");
    assert.equal(acceptRes.status, true);

    // Both should now see each other in Buddy tab (showPage = 3) with status 2 and stable account IDs
    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const aliceBuddies = await clientA.nextXt("buddyList__getUserBuddies");
    const aBuddiesList = aliceBuddies.buddies as Array<{ buddyId: number; buddyName: string; status: number }>;
    assert.equal(aBuddiesList.length, 1);
    assert.equal(aBuddiesList[0].buddyName, "Bob");
    assert.equal(aBuddiesList[0].status, 2);
    assert.equal(aBuddiesList[0].buddyId, bobAccId);

    clientB.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const bobBuddies = await clientB.nextXt("buddyList__getUserBuddies");
    const bBuddiesList = bobBuddies.buddies as Array<{ buddyId: number; buddyName: string; status: number }>;
    assert.equal(bBuddiesList.length, 1);
    assert.equal(bBuddiesList[0].buddyName, "Alice");
    assert.equal(bBuddiesList[0].status, 2);
    assert.equal(bBuddiesList[0].buddyId, aliceAccId);

    // Friends count on cards is now 1
    clientA.write(buildXtFrame("user__getUserCard", { userId: aliceId }));
    const cardAlice = await clientA.nextXt("user__getUserCard");
    assert.equal(cardAlice.friends, "1");

    // ── 3. Alice adds Bob to Best Buddies (status: 4) using stable account ID ──
    clientA.write(buildXtFrame("buddyList__addToBestBuddys", { buddys: [bobAccId] }));
    const bestRes = await clientA.nextXt("buddyList__addToBestBuddys");
    assert.equal(bestRes.status, true);

    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const aliceBuddiesBest = await clientA.nextXt("buddyList__getUserBuddies");
    const aBestList = aliceBuddiesBest.buddies as Array<{ buddyId: number; buddyName: string; status: number }>;
    assert.equal(aBestList[0].status, 4);
    assert.equal(aBestList[0].buddyId, bobAccId);

    // Bob still sees Alice as normal friend (status 2)
    clientB.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const bobBuddiesNormal = await clientB.nextXt("buddyList__getUserBuddies");
    assert.equal((bobBuddiesNormal.buddies as Array<{ status: number }>)[0].status, 2);

    // ── 4. Alice demotes Bob back to normal friend using stable account ID ──
    clientA.write(buildXtFrame("buddyList__deleteFromBestBuddys", { buddys: [bobAccId] }));
    const delBestRes = await clientA.nextXt("buddyList__deleteFromBestBuddys");
    assert.equal(delBestRes.status, true);

    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const aliceBuddiesDemoted = await clientA.nextXt("buddyList__getUserBuddies");
    assert.equal((aliceBuddiesDemoted.buddies as Array<{ status: number }>)[0].status, 2);

    // ── 5. Alice blocks Bob using stable account ID ──
    clientA.write(buildXtFrame("buddyList__blockBuddys", { buddys: [bobAccId] }));
    const blockRes = await clientA.nextXt("buddyList__blockBuddys");
    assert.equal(blockRes.status, true);

    // In WallData.friendsList, Bob is now status 3 (blocked)
    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const aliceBuddiesAfterBlock = await clientA.nextXt("buddyList__getUserBuddies");
    const ignoreList = (aliceBuddiesAfterBlock.buddies as Array<{ buddyId: number; buddyName: string; status: number }>).filter(
      (b) => b.status === 3,
    );
    assert.equal(ignoreList.length, 1);
    assert.equal(ignoreList[0].buddyName, "Bob");
    assert.equal(ignoreList[0].status, 3);
    assert.equal(ignoreList[0].buddyId, bobAccId);

    // Alice viewing Bob's card: isBlock is true, isAllowToAdd is false, chat/trade disabled
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: bobId }));
    const cardBobBlocked = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(cardBobBlocked.isBlock, true);
    assert.equal(cardBobBlocked.isAllowToAdd, false);
    assert.equal(cardBobBlocked.isAvliablChat, false);
    assert.equal(cardBobBlocked.isAvliablTrade, false);

    // Bob viewing Alice's card: isBlock is false (Bob didn't block Alice), but cannot add or chat
    clientB.write(buildXtFrame("user__getUserCardInfo", { userId: aliceId }));
    const cardAliceForBob = await clientB.nextXt("user__getUserCardInfo");
    assert.equal(cardAliceForBob.isBlock, false);
    assert.equal(cardAliceForBob.isAllowToAdd, false);
    assert.equal(cardAliceForBob.isAvliablChat, false);
    assert.equal(cardAliceForBob.isAvliablTrade, false);

    // ── 6. Alice unblocks Bob (deleteBuddy on ignore item) using stable account ID ──
    clientA.write(buildXtFrame("buddyList__deleteBuddys", { buddys: [bobAccId] }));
    const unblockRes = await clientA.nextXt("buddyList__deleteBuddys");
    assert.equal(unblockRes.status, true);

    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 4 }));
    const aliceIgnoreEmpty = await clientA.nextXt("buddyList__getUserBuddies");
    assert.equal((aliceIgnoreEmpty.buddies as Array<unknown>).length, 0);

    // Now Alice can add Bob again
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: bobId }));
    const cardBobUnblocked = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(cardBobUnblocked.isBlock, false);
    assert.equal(cardBobUnblocked.isAllowToAdd, true);
    assert.equal(cardBobUnblocked.isAvliablChat, true);
  } finally {
    clientA?.destroy();
    clientB?.destroy();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Social contracts: rejection flow", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-social-reject-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  createOrEnsureAccount("Alice", "passAlice", 10, dataDir);
  createOrEnsureAccount("Charlie", "passCharlie", 12, dataDir);

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA = new Socket();
  const sockC = new Socket();
  let clientA: TestClient | null = null;
  let clientC: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA.connect(port, "127.0.0.1", () => res()));
    clientA = new TestClient(sockA);
    const aliceId = await performHandshakeAndJoin(clientA, "Alice");

    await new Promise<void>((res) => sockC.connect(port, "127.0.0.1", () => res()));
    clientC = new TestClient(sockC);
    const charlieId = await performHandshakeAndJoin(clientC, "Charlie");
    const aliceAccId = getAccountId("Alice", dataDir);

    // Alice requests Charlie via real room avatar click shape
    clientA.write(buildXtFrame("buddyList__addBuddyRequest", { buddyId: 0, buddyName: "Charlie" }));
    await clientA.nextXt("buddyList__addBuddyRequest");

    // Charlie receives realtime push notification
    const charliePush = await clientC.nextXt("buddyList__addBuddyRequest");
    assert.equal(charliePush.msgId, -1);
    assert.equal(charliePush.numRequests, 1);

    // Charlie sees request in WallData.friendsList (showPage = 3)
    clientC.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const charlieWall = await clientC.nextXt("buddyList__getUserBuddies");
    const charliePending = (charlieWall.buddies as Array<{ buddyId: number; status: number }>).find((b) => b.status === 1);
    assert.ok(charliePending);
    assert.equal(charliePending.buddyId, aliceAccId);

    // Charlie rejects it using stable account ID
    clientC.write(buildXtFrame("buddyList__rejectBuddyRequest", { buddys: [aliceAccId] }));
    const rejRes = await clientC.nextXt("buddyList__rejectBuddyRequest");
    assert.equal(rejRes.status, true);

    // Request tab for Charlie is empty
    clientC.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 5 }));
    const charlieReq = await clientC.nextXt("buddyList__getUserBuddies");
    assert.equal((charlieReq.buddies as Array<unknown>).length, 0);

    // Buddy tab for Alice is empty
    clientA.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const aliceBuddies = await clientA.nextXt("buddyList__getUserBuddies");
    assert.equal((aliceBuddies.buddies as Array<unknown>).length, 0);
  } finally {
    clientA?.destroy();
    clientC?.destroy();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Social contracts: multi-user isolation across 3 players", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-social-multi-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  createOrEnsureAccount("Alice", "passAlice", 10, dataDir);
  createOrEnsureAccount("Bob", "passBob", 11, dataDir);
  createOrEnsureAccount("Charlie", "passCharlie", 12, dataDir);

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA = new Socket();
  const sockB = new Socket();
  const sockC = new Socket();
  let clientA: TestClient | null = null;
  let clientB: TestClient | null = null;
  let clientC: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA.connect(port, "127.0.0.1", () => res()));
    clientA = new TestClient(sockA);
    const aliceId = await performHandshakeAndJoin(clientA, "Alice");

    await new Promise<void>((res) => sockB.connect(port, "127.0.0.1", () => res()));
    clientB = new TestClient(sockB);
    const bobId = await performHandshakeAndJoin(clientB, "Bob");

    await new Promise<void>((res) => sockC.connect(port, "127.0.0.1", () => res()));
    clientC = new TestClient(sockC);
    const charlieId = await performHandshakeAndJoin(clientC, "Charlie");

    // Alice adds Bob
    clientA.write(buildXtFrame("buddyList__addBuddyRequest", { buddyId: bobId, buddyName: "Bob" }));
    await clientA.nextXt("buddyList__addBuddyRequest");
    clientB.write(buildXtFrame("buddyList__acceptBuddysRequest", { buddys: [aliceId] }));
    await clientB.nextXt("buddyList__acceptBuddysRequest");

    // Bob blocks Charlie
    clientB.write(buildXtFrame("buddyList__blockBuddys", { buddys: [charlieId] }));
    await clientB.nextXt("buddyList__blockBuddys");

    // Check Alice friends count: 1
    clientA.write(buildXtFrame("user__getUserCard", { userId: aliceId }));
    const cardA = await clientA.nextXt("user__getUserCard");
    assert.equal(cardA.friends, "1");

    // Check Charlie friends count: 0
    clientC.write(buildXtFrame("user__getUserCard", { userId: charlieId }));
    const cardC = await clientC.nextXt("user__getUserCard");
    assert.equal(cardC.friends, "0");

    // Alice is NOT blocked by Charlie, and does NOT have Charlie blocked
    clientA.write(buildXtFrame("user__getUserCardInfo", { userId: charlieId }));
    const cardCforA = await clientA.nextXt("user__getUserCardInfo");
    assert.equal(cardCforA.isBlock, false);
    assert.equal(cardCforA.isAllowToAdd, true);

    // Bob DOES have Charlie blocked
    clientB.write(buildXtFrame("user__getUserCardInfo", { userId: charlieId }));
    const cardCforB = await clientB.nextXt("user__getUserCardInfo");
    assert.equal(cardCforB.isBlock, true);
    assert.equal(cardCforB.isAllowToAdd, false);
  } finally {
    clientA?.destroy();
    clientB?.destroy();
    clientC?.destroy();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Social contracts: durable hearts transfer and counter validation without fabricated calendar logic", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-social-hearts-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  createOrEnsureAccount("Alice", "passAlice", 10, dataDir);
  createOrEnsureAccount("Bob", "passBob", 11, dataDir);

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA = new Socket();
  const sockB = new Socket();
  let clientA: TestClient | null = null;
  let clientB: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA.connect(port, "127.0.0.1", () => res()));
    clientA = new TestClient(sockA);
    const aliceId = await performHandshakeAndJoin(clientA, "Alice");

    await new Promise<void>((res) => sockB.connect(port, "127.0.0.1", () => res()));
    clientB = new TestClient(sockB);
    const bobId = await performHandshakeAndJoin(clientB, "Bob");

    // 1. rewardSystem__getStatus returns empty bonus list
    clientA.write(buildXtFrame("rewardSystem__getStatus", {}));
    const rsStatus = await clientA.nextXt("rewardSystem__getStatus");
    assert.deepEqual(rsStatus.status, []);

    // 2. rewardSystem__getDetails returns initial hearts
    clientA.write(buildXtFrame("rewardSystem__getDetails", { showPage: 6 }));
    const rsDetails = await clientA.nextXt("rewardSystem__getDetails");
    assert.equal(rsDetails.showPage, 6);
    const hearts = rsDetails.hearts as Record<string, number>;
    assert.equal(hearts.toGive, 5);
    assert.equal(hearts.toGiveMax, 5);
    assert.equal(hearts.received, 0);

    // 3. Alice gives 1 heart to Bob
    clientA.write(buildXtFrame("rewardSystem__giveHeartTofriends", { rsfIds: [bobId] }));
    const giveRes = await clientA.nextXt("rewardSystem__giveHeartTofriends");
    assert.equal(giveRes.status, true);
    assert.equal(giveRes.showPage, 6);
    const afterGiveHearts = giveRes.hearts as Record<string, number>;
    assert.equal(afterGiveHearts.toGive, 4);

    // Bob checks reward details: received is now 1
    clientB.write(buildXtFrame("rewardSystem__getDetails", { showPage: 6 }));
    const bobDetails = await clientB.nextXt("rewardSystem__getDetails");
    const bobHearts = bobDetails.hearts as Record<string, number>;
    assert.equal(bobHearts.received, 1);

    // 4. Giving to self or invalid target fails cleanly (status: 2)
    clientA.write(buildXtFrame("rewardSystem__giveHeartTofriends", { rsfIds: [aliceId] }));
    const selfRes = await clientA.nextXt("rewardSystem__giveHeartTofriends");
    assert.equal(selfRes.status, 2);

    // 5. Transfer remaining 4 hearts to Bob
    for (let i = 0; i < 4; i++) {
      clientA.write(buildXtFrame("rewardSystem__giveHeartTofriends", { rsfIds: [bobId] }));
      const res = await clientA.nextXt("rewardSystem__giveHeartTofriends");
      assert.equal(res.status, true);
    }
    // Now Alice has 0 hearts to give
    clientA.write(buildXtFrame("rewardSystem__getDetails", { showPage: 6 }));
    const emptyDetails = await clientA.nextXt("rewardSystem__getDetails");
    assert.equal((emptyDetails.hearts as Record<string, number>).toGive, 0);

    // 6. When toGive is 0, transfer fails with status 1 (insufficient hearts)
    clientA.write(buildXtFrame("rewardSystem__giveHeartTofriends", { rsfIds: [bobId] }));
    const failRes = await clientA.nextXt("rewardSystem__giveHeartTofriends");
    assert.equal(failRes.status, 1);
    assert.equal(failRes.maxMsg, 0);
  } finally {
    clientA?.destroy();
    clientB?.destroy();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Social contracts: persistence across server restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-social-restart-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  createOrEnsureAccount("Alice", "passAlice", 10, dataDir);
  createOrEnsureAccount("Bob", "passBob", 11, dataDir);

  // Server instance 1: create friendship and give heart
  const serverInst1 = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA1 = new Socket();
  const sockB1 = new Socket();
  let clientA1: TestClient | null = null;
  let clientB1: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA1.connect(serverInst1.port, "127.0.0.1", () => res()));
    clientA1 = new TestClient(sockA1);
    const aId = await performHandshakeAndJoin(clientA1, "Alice");

    await new Promise<void>((res) => sockB1.connect(serverInst1.port, "127.0.0.1", () => res()));
    clientB1 = new TestClient(sockB1);
    const bId = await performHandshakeAndJoin(clientB1, "Bob");

    // Establish friendship
    clientA1.write(buildXtFrame("buddyList__addBuddyRequest", { buddyId: bId, buddyName: "Bob" }));
    await clientA1.nextXt("buddyList__addBuddyRequest");
    clientB1.write(buildXtFrame("buddyList__acceptBuddysRequest", { buddys: [aId] }));
    await clientB1.nextXt("buddyList__acceptBuddysRequest");

    // Give heart
    clientA1.write(buildXtFrame("rewardSystem__giveHeartTofriends", { rsfIds: [bId] }));
    await clientA1.nextXt("rewardSystem__giveHeartTofriends");
  } finally {
    clientA1?.destroy();
    clientB1?.destroy();
    serverInst1.server.close();
  }

  // Server instance 2: verify state persisted from disk
  const serverInst2 = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA2 = new Socket();
  const sockB2 = new Socket();
  let clientA2: TestClient | null = null;
  let clientB2: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA2.connect(serverInst2.port, "127.0.0.1", () => res()));
    clientA2 = new TestClient(sockA2);
    await performHandshakeAndJoin(clientA2, "Alice");

    await new Promise<void>((res) => sockB2.connect(serverInst2.port, "127.0.0.1", () => res()));
    clientB2 = new TestClient(sockB2);
    await performHandshakeAndJoin(clientB2, "Bob");

    // Friendship is preserved
    clientA2.write(buildXtFrame("buddyList__getUserBuddies", { showPage: 3 }));
    const buddies = await clientA2.nextXt("buddyList__getUserBuddies");
    const list = buddies.buddies as Array<{ buddyName: string; status: number }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].buddyName, "Bob");
    assert.equal(list[0].status, 2);

    // Bob's received hearts are preserved
    clientB2.write(buildXtFrame("rewardSystem__getDetails", { showPage: 6 }));
    const details = await clientB2.nextXt("rewardSystem__getDetails");
    assert.equal((details.hearts as Record<string, number>).received, 1);

    // Alice's remaining hearts to give are preserved (5 - 1 = 4)
    clientA2.write(buildXtFrame("rewardSystem__getDetails", { showPage: 6 }));
    const aliceDetails = await clientA2.nextXt("rewardSystem__getDetails");
    assert.equal((aliceDetails.hearts as Record<string, number>).toGive, 4);
  } finally {
    clientA2?.destroy();
    clientB2?.destroy();
    serverInst2.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Social contracts: wall messages lifecycle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "localgobe-social-wall-"));
  const buildId = "20160725-android-1.4.7";
  importApkBuffer(buildSyntheticSupportedApk(), { dataDir });

  createOrEnsureAccount("Alice", "passAlice", 10, dataDir);

  const { server, port } = await startSmartFoxTcpServer({ port: 0, buildId, dataDir });
  const sockA = new Socket();
  let clientA: TestClient | null = null;

  try {
    await new Promise<void>((res) => sockA.connect(port, "127.0.0.1", () => res()));
    clientA = new TestClient(sockA);
    await performHandshakeAndJoin(clientA, "Alice");

    // 1. Templates returns clean empty array without reconstructed text
    clientA.write(buildXtFrame("wall__getMessageTemplates", {}));
    const tpl = await clientA.nextXt("wall__getMessageTemplates");
    assert.equal(tpl.wmr, 10);
    assert.deepEqual(tpl.wmsgt, []);

    // 2. Send custom wall message
    clientA.write(buildXtFrame("wall__sendCustomMessage", { content: "Hello Wall!" }));
    const sendRes = await clientA.nextXt("wall__sendCustomMessage");
    assert.equal(sendRes.status, true);

    // 3. Unread messages count
    clientA.write(buildXtFrame("wall__getNumUnReadMessages", {}));
    const unread = await clientA.nextXt("wall__getNumUnReadMessages");
    assert.equal(unread.newMsgs, 1);

    // 4. Retrieve messages
    clientA.write(buildXtFrame("wall__getUserMessages", {}));
    const userMsgs = await clientA.nextXt("wall__getUserMessages");
    const msgs = userMsgs.wmsg as Array<{ id: number; c: string; n: boolean }>;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].c, "Hello Wall!");
    assert.equal(msgs[0].n, true);

    // 5. Mark as read
    clientA.write(buildXtFrame("wall__setMessageRead", { wmsgId: msgs[0].id }));
    const readRes = await clientA.nextXt("wall__setMessageRead");
    assert.equal(readRes.wmsgId, msgs[0].id);

    clientA.write(buildXtFrame("wall__getNumUnReadMessages", {}));
    const unreadAfter = await clientA.nextXt("wall__getNumUnReadMessages");
    assert.equal(unreadAfter.newMsgs, 0);

    // 6. Delete message
    clientA.write(buildXtFrame("wall__deleteUserMessage", { wmsgId: msgs[0].id }));
    const delRes = await clientA.nextXt("wall__deleteUserMessage");
    assert.equal(delRes.status, true);

    clientA.write(buildXtFrame("wall__getUserMessages", {}));
    const emptyMsgs = await clientA.nextXt("wall__getUserMessages");
    assert.equal((emptyMsgs.wmsg as Array<unknown>).length, 0);
  } finally {
    clientA?.destroy();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
