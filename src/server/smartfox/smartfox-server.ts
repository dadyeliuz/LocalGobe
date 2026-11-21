/**
 * LocalGobe Production SmartFox Server & WebSocket Bridge.
 *
 * Provides authoritative local multiplayer state: login, Room 20 bootstrap,
 * room navigation, movement, public/private chat, trade, inventory, emotes,
 * special effects, mini-games, and persistent player state.
 */
import { createHash } from "node:crypto";
import { createServer, type Server as NetServer, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { child, decodeFrame, type XmlNode } from "./codecs.ts";
import { buildExtensionResponse, signExtensionData } from "./extensions.ts";
import { NulFramer } from "./framing.ts";
import { buildSystemResponse } from "./system.ts";
import {
  getStaticGameRoom,
  resolveRoomAvailability,
  resolveTargetRoomIdDetailed,
  ServerState,
  STATIC_GAME_ROOMS,
  type OutgoingDispatch,
  type PlayerSession,
} from "./server-state.ts";
import {
  getAccount,
  getAccountById,
  getAccountId,
  updateAccountPlayerState,
  getAccountRelationships,
  addBuddyRequest,
  acceptBuddyRequest,
  rejectBuddyRequest,
  deleteBuddy,
  setBestBuddy,
  blockBuddy,
  getAccountHearts,
  giveAccountHearts,
  getAccountWallMessages,
  addAccountWallMessage,
  markAccountWallMessageRead,
  deleteAccountWallMessage,
} from "../../storage/accounts-store.ts";
import { readBuildManifest } from "../../storage/build-store.ts";

export const BOOTSTRAP_ROOM = { id: 20, name: "room_20", type: "WR" } as const;

export type SmartFoxEvent = { time: string; event: string; [key: string]: unknown };

export type SmartFoxRuntimeHandle = {
  tcpPort: number;
  wsPort: number;
  serverState: ServerState;
  close(): Promise<void>;
};

export function extractCanonicalUsername(rawNick: string): string {
  const trimmed = rawNick.trim();
  const match = trimmed.match(/^::[0-9O]+:?([^:]+?)(?::-?\d+)*$/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return trimmed;
}

function commandFromFrame(bytes: Buffer): { command: string; room: number; payload: unknown } | null {
  const decoded = decodeFrame(bytes);
  if (decoded.kind !== "XT" || !decoded.command) return null;
  const body = (decoded.object as { b: { c?: string; r?: number; p?: { d?: unknown; m?: string } } }).b;
  if (typeof body.p?.d === "string" && typeof body.p?.m === "string") {
    if (signExtensionData(body.p.d) !== body.p.m) throw new Error("invalid extension signature");
    return {
      command: decoded.command,
      room: body.r ?? -1,
      payload: JSON.parse(Buffer.from(body.p.d, "base64").toString("utf8")) as unknown,
    };
  }
  return { command: decoded.command, room: body.r ?? -1, payload: body.p?.d ?? {} };
}

function getInstalledStaticRooms(buildId: string, dataDir?: string): Array<{ rId: number; rN: string; rT: string; fR?: number; sTc?: number }> {
  const rooms: Array<{ rId: number; rN: string; rT: string; fR?: number; sTc?: number }> = [
    { rId: BOOTSTRAP_ROOM.id, rN: BOOTSTRAP_ROOM.name, rT: BOOTSTRAP_ROOM.type },
  ];

  const manifest = readBuildManifest(buildId, dataDir);
  if (manifest) {
    for (const room of manifest.categories.world.rooms) {
      if (room.ready && !rooms.some((r) => r.rId === room.roomId)) {
        rooms.push({ rId: room.roomId, rN: `room_${room.roomId}`, rT: "WR" });
      }
    }
  }

  for (const game of STATIC_GAME_ROOMS) {
    if (!rooms.some((r) => r.rId === game.rId)) {
      rooms.push({
        rId: game.rId,
        rN: game.rN,
        rT: game.rT,
        fR: game.fR,
        sTc: game.sTc,
      });
    }
  }

  return rooms;
}

export async function startSmartFoxTcpServer(options: {
  port?: number;
  buildId?: string;
  dataDir?: string;
  initialRoomId?: number;
  onEvent?: (event: SmartFoxEvent) => void;
  serverState?: ServerState;
} = {}): Promise<{ server: NetServer; port: number; serverState: ServerState }> {
  const port = options.port ?? 8001;
  const buildId = options.buildId ?? "20160725-android-1.4.7";
  const startRoomId = options.initialRoomId ?? BOOTSTRAP_ROOM.id;
  const report = options.onEvent ?? (() => {});

  const serverState =
    options.serverState ??
    new ServerState(startRoomId, `room_${startRoomId}`, BOOTSTRAP_ROOM.type, {
      profile: buildId,
      workspaceRoot: options.dataDir,
    });

  const server = createServer((socket) => {
    const framer = new NulFramer();
    const session = serverState.createSession(socket, "user");
    const sentRoomIds = new Set<number>();

    const emit = (event: string, details: Record<string, unknown> = {}) =>
      report({ time: new Date().toISOString(), event, ...details });

    const send = (label: string, bytes: Buffer) => {
      socket.write(bytes);
      emit("send", { label });
    };

    const dispatch = (dispatches: OutgoingDispatch[]) => {
      for (const d of dispatches) {
        d.socket.write(d.bytes);
        emit("send", { label: d.label, targetUserId: serverState.getSession(d.socket)?.userId });
      }
    };

    const fail = (reason: string) => {
      emit("error", { reason });
      socket.destroy();
    };

    const handle = (bytes: Buffer) => {
      const decoded = decodeFrame(bytes);
      const extension = commandFromFrame(bytes);
      const summary = decoded.summary;

      emit("receive", {
        summary,
        room: extension?.room,
        ...(decoded.action === "login"
          ? { bytes: bytes.length + 1, sha256: createHash("sha256").update(bytes).update("\0").digest("hex") }
          : {}),
      });

      if (session.phase === 0 && decoded.action === "verChk") {
        session.phase = 1;
        send("apiOK", buildSystemResponse("apiOK"));
      } else if (session.phase === 1 && decoded.action === "login") {
        session.phase = 2;
        const text = bytes.toString("utf8");
        const matchNick = text.match(/<nick>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/nick>/i);
        const rawNick = matchNick?.[1] || "user";
        session.is2016 = Boolean(rawNick.includes(":") || rawNick.startsWith("::") || buildId === "20160725-android-1.4.7");
        const canonical = extractCanonicalUsername(rawNick);
        const account = getAccount(canonical, options.dataDir);
        const initialProps = account
          ? { coins: account.coins, inventory: account.inventory, hasPersistentAccount: true }
          : undefined;

        const loginRes = serverState.handleLogin(session, canonical, account?.color, initialProps);
        if (loginRes.kickedPreviousSession) {
          dispatch(loginRes.kicks);
        }
        send("logOK", buildSystemResponse("logOK", { id: session.userId, name: session.userName }));
      } else if (session.phase === 2 && decoded.action === "getRmList") {
        session.phase = 3;
        const staticRooms = getInstalledStaticRooms(buildId, options.dataDir);
        const rmListRooms = staticRooms.map((r) => {
          sentRoomIds.add(r.rId);
          return {
            id: r.rId,
            name: r.rN,
            isGame: false,
            isLimbo: r.rT === "WG",
            userCount: serverState.rooms.get(r.rId)?.sessions.size ?? 0,
          };
        });
        send("rmList", buildSystemResponse("rmList", { rooms: rmListRooms }));
        send("extension-login", buildExtensionResponse("login", {
          uSFSId: session.userId,
          appUserId: session.userId,
          userName: session.userName,
          ageGroup: 1,
          chatMode: true,
          worldAdvan: false,
          lastLogin: 0,
          ld: [{ i: 1, t: 1 }],
          lang: 4,
          userType: "local",
          prevLogin: 0,
        }));
      } else if (session.phase === 3 && extension?.command === "rooms__getStaticRoomList") {
        session.phase = 4;
        const staticRooms = getInstalledStaticRooms(buildId, options.dataDir);
        send("static-rooms", buildExtensionResponse("rooms__getStaticRoomList", {
          StaticRooms: staticRooms,
        }));
      } else if (session.phase === 4 && extension?.command === "user__joinFirstRoom") {
        session.phase = 5;
        const joinResult = serverState.joinRoom(session, startRoomId);
        send("joinOK", joinResult.joinOkBytes);
        dispatch(joinResult.broadcasts);
        const userRelationships = getAccountRelationships(session.userName, options.dataDir);
        const pendingCount = Object.values(userRelationships).filter(
          (r) => r.status === 1 && r.direction === "incoming",
        ).length;
        if (pendingCount > 0) {
          send(
            "pending-buddy-requests",
            buildExtensionResponse("buddyList__addBuddyRequest", { msgId: -1, numRequests: pendingCount }),
          );
        }
      } else if (session.phase === 5) {
        if (decoded.kind === "SYS") {
          const bodyNode = child(decoded.object as XmlNode, "body");
          if (decoded.action === "setUvars") {
            const varsNode = child(bodyNode, "vars");
            const updatedVars: Record<string, string | number | boolean> = {};
            if (varsNode) {
              for (const v of varsNode.children.filter((n) => n.name === "var")) {
                const n = v.attrs.n;
                const t = v.attrs.t;
                if (n === "mo_1" || n === "mo_2" || n === "coins" || n === "items" || n === "score") continue;
                updatedVars[n] = t === "n" ? Number(v.text) : t === "b" ? v.text === "1" : v.text;
              }
            }
            dispatch(serverState.updateUserVariables(session, updatedVars));
            return;
          }
          if (decoded.action === "pubMsg") {
            const txt = child(bodyNode, "txt")?.text ?? "";
            dispatch(serverState.broadcastPublicChat(session, txt));
            return;
          }
          if (decoded.action === "prvMsg") {
            const txtNode = child(bodyNode, "txt");
            const txt = txtNode?.text ?? "";
            const rcp = txtNode?.attrs?.rcp ? Number(txtNode.attrs.rcp) : undefined;
            if (rcp !== undefined) dispatch(serverState.sendPrivateChat(session, rcp, txt));
            return;
          }
          if (decoded.action === "loadB") {
            send("bList", buildSystemResponse("bList", {
              buddies: session.playerData.buddies.map((b) => ({ id: b.buddyId, name: b.buddyName, isOnline: true })),
            }));
            return;
          }
        }

        if (extension) {
          const cmd = extension.command;
          const payload = (extension.payload ?? {}) as Record<string, unknown>;

          if (cmd === "wall__getNumUnReadMessages") {
            const storedMsgs = getAccountWallMessages(session.userName, options.dataDir);
            const msgs = storedMsgs.length > 0 ? storedMsgs : session.playerData.wallMessages;
            const unread = msgs.filter((m) => m.n).length;
            send(cmd, buildExtensionResponse(cmd, { newMsgs: unread, wearSwimsuit: true, showSms: true, isVehicle: false, adminChat: false }));
            return;
          }
          if (cmd === "wall__getUserMessages") {
            const storedMsgs = getAccountWallMessages(session.userName, options.dataDir);
            const msgs = storedMsgs.length > 0 ? storedMsgs : session.playerData.wallMessages;
            send(cmd, buildExtensionResponse(cmd, { wmsg: msgs }));
            return;
          }
          if (cmd === "wall__getMessageTemplates") {
            send(cmd, buildExtensionResponse(cmd, { wmr: 10, wmsgt: [] }));
            return;
          }
          if (cmd === "wall__sendCustomMessage") {
            const content = String(payload.content ?? payload.c ?? payload.text ?? "");
            const targetName = typeof payload.toUserName === "string" && payload.toUserName.trim()
              ? payload.toUserName.trim()
              : session.userName;
            const msg = addAccountWallMessage(targetName, session.userId, session.userName, content, options.dataDir);
            session.playerData.wallMessages.push(msg);
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "wall__setMessageRead") {
            const wmsgId = Number(payload.wmsgId);
            markAccountWallMessageRead(session.userName, wmsgId, options.dataDir);
            const msg = session.playerData.wallMessages.find((m) => m.id === wmsgId);
            if (msg) msg.n = false;
            send(cmd, buildExtensionResponse(cmd, { wmsgId }));
            return;
          }
          if (cmd === "wall__deleteUserMessage") {
            const wmsgId = Number(payload.wmsgId);
            deleteAccountWallMessage(session.userName, wmsgId, options.dataDir);
            session.playerData.wallMessages = session.playerData.wallMessages.filter((m) => m.id !== wmsgId);
            send(cmd, buildExtensionResponse(cmd, { wmsgId, status: true }));
            return;
          }
          if (cmd === "user__getGiftsItemList") {
            send(cmd, buildExtensionResponse(cmd, { items: [] }));
            return;
          }
          if (cmd === "user__getUserCard") {
            const reqUserId = Number(payload.userId);
            const reqUserName = typeof payload.userName === "string" ? payload.userName.trim() : "";

            let targetSession = reqUserId && reqUserId !== -1 ? serverState.getSessionByUserId(reqUserId) : undefined;
            if (!targetSession && reqUserName) {
              targetSession = serverState.activeUsersByName.get(reqUserName.toLowerCase());
            }
            if (!targetSession && !reqUserName && (!reqUserId || reqUserId === session.userId)) {
              targetSession = session;
            }

            if (targetSession) {
              const cardInventory = targetSession.playerData.inventory;
              const relationships = getAccountRelationships(targetSession.userName, options.dataDir);
              const relCount = Object.keys(relationships).length > 0
                ? Object.values(relationships).filter((r) => r.status === 2 || r.status === 4).length
                : targetSession.playerData.buddies.filter((b) => b.status === 2 || b.status === 4).length;
              send(cmd, buildExtensionResponse(cmd, {
                userId: targetSession.userId,
                userName: targetSession.userName,
                online: true,
                color: targetSession.color,
                items: cardInventory.filter((i) => i.sts === 1),
                gender: 1,
                age: "0",
                friends: String(relCount),
                score: 100,
                mo_1: targetSession.playerData.coins,
                mo_2: 0,
              }));
              return;
            }

            // Target is offline or persistent-only lookup
            const targetAccountName = reqUserName || (reqUserId && reqUserId !== -1 ? String(reqUserId) : "");
            const account = targetAccountName ? getAccount(targetAccountName, options.dataDir) : undefined;

            if (account) {
              const storedItems = account.inventory ?? [];
              const relationships = getAccountRelationships(account.username, options.dataDir);
              const relCount = Object.values(relationships).filter((r) => r.status === 2 || r.status === 4).length;
              send(cmd, buildExtensionResponse(cmd, {
                userId: reqUserId || account.id || -1,
                userName: account.username,
                online: false,
                color: account.color ?? 10,
                items: storedItems.filter((i) => i.sts === 1),
                gender: 1,
                age: "0",
                friends: String(relCount),
                score: 100,
                mo_1: account.coins ?? 500,
                mo_2: 0,
              }));
              return;
            }

            // Fallback for unknown player
            send(cmd, buildExtensionResponse(cmd, {
              userId: reqUserId || -1,
              userName: reqUserName || "Friend",
              online: false,
              color: 10,
              items: [],
              gender: 1,
              age: "0",
              friends: "0",
              score: 100,
              mo_1: 500,
              mo_2: 0,
            }));
            return;
          }
          if (cmd === "user__getUserCardInfo") {
            const reqUserId = Number(payload.userId);
            const reqUserName = typeof payload.userName === "string" ? payload.userName.trim() : "";

            let targetSession: PlayerSession | undefined;
            if (reqUserId && reqUserId !== -1) {
              targetSession = serverState.getSessionByUserId(reqUserId);
            } else if (reqUserName) {
              targetSession = serverState.activeUsersByName.get(reqUserName.toLowerCase());
            } else {
              targetSession = session;
            }

            let cardUserName = targetSession ? targetSession.userName : reqUserName;
            if (!cardUserName) {
              cardUserName = (!reqUserId || reqUserId === session.userId) ? session.userName : "Friend";
            }
            if (!targetSession && reqUserName) {
              const acc = getAccount(reqUserName, options.dataDir);
              if (acc) cardUserName = acc.username;
            }

            const isMe = targetSession
              ? targetSession.userId === session.userId
              : (cardUserName.toLowerCase() === session.userName.toLowerCase());
            const isOnline = targetSession !== undefined;
            const sameRoom = targetSession !== undefined && targetSession.roomId === session.roomId;
            const targetInteraction = targetSession ? serverState.getInteractionForUser(targetSession.userId) : undefined;
            const selfInteraction = serverState.getInteractionForUser(session.userId);
            const isBusy = Boolean(targetInteraction || selfInteraction);

            // Social relationship resolution between session and target
            const myRelationships = getAccountRelationships(session.userName, options.dataDir);
            const myRel = myRelationships[cardUserName.toLowerCase()];
            const targetRelationships = getAccountRelationships(cardUserName, options.dataDir);
            const targetRel = targetRelationships[session.userName.toLowerCase()];

            const isBlock = myRel?.status === 3;
            const targetBlockedMe = targetRel?.status === 3;
            const alreadyFriendOrPending = Boolean(myRel && (myRel.status === 1 || myRel.status === 2 || myRel.status === 4));
            const isAllowToAdd = !isMe && !isBlock && !targetBlockedMe && !alreadyFriendOrPending;
            const available = !isMe && isOnline && sameRoom && !isBusy && !isBlock && !targetBlockedMe;

            // Target or self hearts from persistent store
            const targetHearts = getAccountHearts(cardUserName, options.dataDir);

            send(cmd, buildExtensionResponse(cmd, {
              userName: cardUserName,
              groups: [],
              isRoomOpen: false,
              member: false,
              newMsgs: "0",
              isAvliablChat: available,
              isAvliablTrade: available,
              isAvliablPresent: !isBlock && !targetBlockedMe,
              isAllowToAdd,
              isBlock,
              hearts: {
                toGive: targetHearts.toGive,
                toGiveMax: targetHearts.toGiveMax,
                received: targetHearts.received,
              },
            }));
            return;
          }
          if (cmd === "user__getInventoryItems") {
            const targetId = Number(payload.userId) || session.userId;
            const targetSession = serverState.getSessionByUserId(targetId) ?? session;
            send(cmd, buildExtensionResponse(cmd, {
              userId: targetId,
              items: targetSession.playerData.inventory,
            }));
            return;
          }
          if (cmd === "user__setInUseItem") {
            const rawItems = Array.isArray(payload.items) ? payload.items : [payload];
            const first = rawItems[0] as Record<string, unknown> | undefined;
            const targetItemId = Number(first?.id ?? first?.itemId ?? payload.itemId ?? payload.id);
            const targetTypeId = Number(first?.typeId ?? payload.typeId);
            const item = session.playerData.inventory.find(
              (i) => i.id === targetItemId || (targetTypeId && i.typeId === targetTypeId),
            );
            if (item) {
              for (const other of session.playerData.inventory) {
                if (other.id !== item.id && (other.pCat ?? 3) === (item.pCat ?? 3)) other.sts = 0;
              }
              item.sts = 1;
              serverState.persistPlayerState(session);
            }
            const inUseItems = session.playerData.inventory.filter((i) => i.sts === 1);
            send(cmd, buildExtensionResponse(cmd, { items: inUseItems }));
            dispatch(serverState.updateUserVariables(session, { items: JSON.stringify(inUseItems) }, false));
            return;
          }
          if (cmd === "user__setNotInUseItem") {
            const rawItems = Array.isArray(payload.items) ? payload.items : [payload];
            const first = rawItems[0] as Record<string, unknown> | undefined;
            const targetItemId = Number(first?.id ?? first?.itemId ?? payload.itemId ?? payload.id);
            const targetTypeId = Number(first?.typeId ?? payload.typeId);
            const item = session.playerData.inventory.find(
              (i) => i.id === targetItemId || (targetTypeId && i.typeId === targetTypeId),
            );
            if (item) item.sts = 0;
            else for (const i of session.playerData.inventory) i.sts = 0;
            serverState.persistPlayerState(session);
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            const inUseItems = session.playerData.inventory.filter((i) => i.sts === 1);
            dispatch(serverState.updateUserVariables(session, { items: JSON.stringify(inUseItems) }, false));
            return;
          }
          if (cmd === "user__updateAvatarInUseItems") {
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "rewardSystem__getStatus") {
            send(cmd, buildExtensionResponse(cmd, { status: [] }));
            return;
          }
          if (cmd === "rewardSystem__getDetails") {
            const rawPage = (payload as Record<string, unknown>)?.showPage;
            const hearts = getAccountHearts(session.userName, options.dataDir);
            send(cmd, buildExtensionResponse(cmd, {
              showPage: Number(rawPage) || 6,
              hearts: {
                toGive: hearts.toGive,
                toGiveMax: hearts.toGiveMax,
                received: hearts.received,
              },
            }));
            return;
          }
          if (cmd === "rewardSystem__giveHeartTofriends" || cmd === "rewardSystem__giveHeartTofriend") {
            const rawList = Array.isArray(payload.rsfIds)
              ? payload.rsfIds
              : [payload.rsfId ?? payload.buddyId].filter((x) => x !== undefined && x !== null);
            const resolvedTargets: string[] = [];
            for (const item of rawList) {
              if (typeof item === "string" && isNaN(Number(item))) {
                resolvedTargets.push(item.trim());
              } else {
                const numId = Number(item);
                const s = serverState.getSessionByUserId(numId);
                if (s) {
                  resolvedTargets.push(s.userName);
                } else {
                  const acc = getAccountById(numId, options.dataDir);
                  if (acc) resolvedTargets.push(acc.username);
                  else resolvedTargets.push(String(numId));
                }
              }
            }
            const result = giveAccountHearts(session.userName, resolvedTargets, options.dataDir);
            if (result.status === 1) {
              send(cmd, buildExtensionResponse(cmd, {
                status: 1,
                maxMsg: result.maxMsg ?? 0,
                showPage: 6,
                hearts: {
                  toGive: result.hearts.toGive,
                  toGiveMax: result.hearts.toGiveMax,
                  received: result.hearts.received,
                },
              }));
              return;
            }
            if (result.status === 2) {
              send(cmd, buildExtensionResponse(cmd, {
                status: 2,
                showPage: 6,
                hearts: {
                  toGive: result.hearts.toGive,
                  toGiveMax: result.hearts.toGiveMax,
                  received: result.hearts.received,
                },
              }));
              return;
            }
            send(cmd, buildExtensionResponse(cmd, {
              status: true,
              showPage: 6,
              hearts: {
                toGive: result.hearts.toGive,
                toGiveMax: result.hearts.toGiveMax,
                received: result.hearts.received,
              },
            }));
            return;
          }
          if (cmd === "user__getMyMoney") {
            send(cmd, buildExtensionResponse(cmd, { userId: session.userId, money: session.playerData.coins }));
            return;
          }
          if (cmd === "user__buyItem") {
            const itemId = Number(payload.itemId);
            const result = serverState.buyItem(session, itemId);
            if (result.success && session.playerData.hasPersistentAccount) {
              updateAccountPlayerState(
                session.userName,
                { coins: session.playerData.coins, inventory: session.playerData.inventory },
                options.dataDir,
              );
            }
            dispatch(result.dispatches);
            return;
          }
          if (cmd === "buddyList__getUserBuddies") {
            const rawPage = payload.showPage;
            const showPage = rawPage !== undefined ? Number(rawPage) : 3;
            const relationships = getAccountRelationships(session.userName, options.dataDir);
            const mappedBuddies: { buddyId: number; buddyName: string; status: number; serverName: string }[] = [];

            for (const [, rel] of Object.entries(relationships)) {
              // The 2016 client expects buddies to contain all relationship types:
              // - Best friends: status 4
              // - Normal friends: status 2
              // - Blocked/ignored: status 3
              // - Incoming requests: status 1 (direction: incoming)
              // Outgoing requests are not displayed in the friend list.
              // Client-side WallFreindListView filters this single list locally across its tabs.
              if (
                rel.status === 2 ||
                rel.status === 4 ||
                rel.status === 3 ||
                (rel.status === 1 && rel.direction === "incoming")
              ) {
                const buddyId = getAccountId(rel.targetUsername, options.dataDir);
                mappedBuddies.push({
                  buddyId,
                  buddyName: rel.targetUsername,
                  status: rel.status,
                  serverName: "Local",
                });
              }
            }

            // Fallback for sessions without persistent accounts if relationships were empty
            if (mappedBuddies.length === 0 && Object.keys(relationships).length === 0 && session.playerData.buddies.length > 0) {
              for (const b of session.playerData.buddies) {
                mappedBuddies.push(b);
              }
            }

            send(cmd, buildExtensionResponse(cmd, { showPage, buddies: mappedBuddies }));
            return;
          }
          if (cmd === "buddyList__addBuddyRequest") {
            let targetName = "";
            if (typeof payload.buddyName === "string" && payload.buddyName.trim()) {
              targetName = payload.buddyName.trim();
            } else if (typeof payload.userName === "string" && payload.userName.trim()) {
              targetName = payload.userName.trim();
            } else if (payload.buddyId !== undefined && payload.buddyId !== null) {
              const numId = Number(payload.buddyId);
              const foundAcc = getAccountById(numId, options.dataDir);
              if (foundAcc) {
                targetName = foundAcc.username;
              } else {
                const foundSession = serverState.getSessionByUserId(numId);
                if (foundSession) targetName = foundSession.userName;
              }
            }
            if (targetName) {
              addBuddyRequest(session.userName, targetName, options.dataDir);

              // Notify recipient in realtime if online
              const targetKey = targetName.toLowerCase().trim();
              const targetSession = serverState.activeUsersByName.get(targetKey);
              if (targetSession) {
                const bRelationships = getAccountRelationships(targetName, options.dataDir);
                const numRequests = Object.values(bRelationships).filter(
                  (r) => r.status === 1 && r.direction === "incoming",
                ).length;
                if (numRequests > 0) {
                  targetSession.socket.write(
                    buildExtensionResponse("buddyList__addBuddyRequest", { msgId: -1, numRequests }),
                  );
                }
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true, msgId: -1 }));
            return;
          }
          if (cmd === "buddyList__acceptBuddysRequest" || cmd === "buddyList__acceptBuddyRequest") {
            const rawBuddies = Array.isArray(payload.buddys)
              ? payload.buddys
              : [payload.buddyId ?? payload.buddyName ?? payload.userName].filter((x) => x !== undefined && x !== null);
            for (const item of rawBuddies) {
              let targetName = "";
              if (typeof item === "string" && isNaN(Number(item))) {
                targetName = item.trim();
              } else {
                const numId = Number(item);
                const acc = getAccountById(numId, options.dataDir);
                if (acc) {
                  targetName = acc.username;
                } else {
                  const s = serverState.getSessionByUserId(numId);
                  if (s) targetName = s.userName;
                }
              }
              if (targetName) {
                acceptBuddyRequest(session.userName, targetName, options.dataDir);
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "buddyList__rejectBuddyRequest") {
            const rawBuddies = Array.isArray(payload.buddys)
              ? payload.buddys
              : [payload.buddyId ?? payload.buddyName ?? payload.userName].filter((x) => x !== undefined && x !== null);
            for (const item of rawBuddies) {
              let targetName = "";
              if (typeof item === "string" && isNaN(Number(item))) {
                targetName = item.trim();
              } else {
                const numId = Number(item);
                const acc = getAccountById(numId, options.dataDir);
                if (acc) {
                  targetName = acc.username;
                } else {
                  const s = serverState.getSessionByUserId(numId);
                  if (s) targetName = s.userName;
                }
              }
              if (targetName) {
                rejectBuddyRequest(session.userName, targetName, options.dataDir);
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "buddyList__addToBestBuddys" || cmd === "buddyList__addToBestBuddy") {
            const rawBuddies = Array.isArray(payload.buddys)
              ? payload.buddys
              : [payload.buddyId ?? payload.buddyName ?? payload.userName].filter((x) => x !== undefined && x !== null);
            for (const item of rawBuddies) {
              let targetName = "";
              if (typeof item === "string" && isNaN(Number(item))) {
                targetName = item.trim();
              } else {
                const numId = Number(item);
                const acc = getAccountById(numId, options.dataDir);
                if (acc) {
                  targetName = acc.username;
                } else {
                  const s = serverState.getSessionByUserId(numId);
                  if (s) targetName = s.userName;
                }
              }
              if (targetName) {
                setBestBuddy(session.userName, targetName, true, options.dataDir);
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "buddyList__deleteFromBestBuddys" || cmd === "buddyList__deleteFromBestBuddy") {
            const rawBuddies = Array.isArray(payload.buddys)
              ? payload.buddys
              : [payload.buddyId ?? payload.buddyName ?? payload.userName].filter((x) => x !== undefined && x !== null);
            for (const item of rawBuddies) {
              let targetName = "";
              if (typeof item === "string" && isNaN(Number(item))) {
                targetName = item.trim();
              } else {
                const numId = Number(item);
                const acc = getAccountById(numId, options.dataDir);
                if (acc) {
                  targetName = acc.username;
                } else {
                  const s = serverState.getSessionByUserId(numId);
                  if (s) targetName = s.userName;
                }
              }
              if (targetName) {
                setBestBuddy(session.userName, targetName, false, options.dataDir);
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "buddyList__blockBuddys" || cmd === "buddyList__blockBuddy") {
            const rawBuddies = Array.isArray(payload.buddys)
              ? payload.buddys
              : [payload.buddyId ?? payload.buddyName ?? payload.userName].filter((x) => x !== undefined && x !== null);
            for (const item of rawBuddies) {
              let targetName = "";
              if (typeof item === "string" && isNaN(Number(item))) {
                targetName = item.trim();
              } else {
                const numId = Number(item);
                const acc = getAccountById(numId, options.dataDir);
                if (acc) {
                  targetName = acc.username;
                } else {
                  const s = serverState.getSessionByUserId(numId);
                  if (s) targetName = s.userName;
                }
              }
              if (targetName) {
                blockBuddy(session.userName, targetName, options.dataDir);
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "buddyList__deleteBuddy" || cmd === "buddyList__deleteBuddys") {
            const rawBuddies = Array.isArray(payload.buddys)
              ? payload.buddys
              : [payload.buddyId ?? payload.buddyName ?? payload.userName].filter((x) => x !== undefined && x !== null);
            for (const item of rawBuddies) {
              let targetName = "";
              if (typeof item === "string" && isNaN(Number(item))) {
                targetName = item.trim();
              } else {
                const numId = Number(item);
                const acc = getAccountById(numId, options.dataDir);
                if (acc) {
                  targetName = acc.username;
                } else {
                  const s = serverState.getSessionByUserId(numId);
                  if (s) targetName = s.userName;
                }
              }
              if (targetName) {
                deleteBuddy(session.userName, targetName, options.dataDir);
              }
            }
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "trade__create") {
            const chatOnly = Boolean(payload.chatOnly);
            const targetUserId = Number(payload.secandUserId);
            const result = chatOnly
              ? serverState.createChatInteraction(session, targetUserId)
              : serverState.createTradeInteraction(session, targetUserId);
            dispatch(result.dispatches);
            return;
          }
          if (cmd === "trade__aproveStart") {
            const chatOnly = Boolean(payload.chatOnly);
            const initiatorUserId = Number(payload.firstUserId);
            const result = chatOnly
              ? serverState.acceptChatInteraction(session, initiatorUserId)
              : serverState.acceptTradeInteraction(session, initiatorUserId);
            dispatch(result.dispatches);
            return;
          }
          if (cmd === "trade__exit") {
            dispatch(serverState.exitInteraction(session).dispatches);
            return;
          }
          if (cmd === "trade__changeItems") {
            dispatch(serverState.changeTradeItems(session, payload).dispatches);
            return;
          }
          if (cmd === "trade__acceptTrade") {
            dispatch(serverState.acceptTrade(session, payload).dispatches);
            return;
          }
          if (cmd === "trade__rejectTrade") {
            dispatch(serverState.rejectTrade(session, payload).dispatches);
            return;
          }
          if (cmd === "trade__getInventoryItems") {
            const targetId = Number(payload.userId) || session.userId;
            const targetSession = serverState.getSessionByUserId(targetId) ?? session;
            send(cmd, buildExtensionResponse(cmd, { userId: targetId, items: targetSession.playerData.inventory ?? [] }));
            return;
          }
          if (cmd === "rooms__getStoreData") {
            // Room store data response. When no authentic store catalog is installed,
            // return protocol-safe empty lists.
            send(cmd, buildExtensionResponse(cmd, {
              categories: serverState.storeCategories,
              items: serverState.storeCatalog,
            }));
            return;
          }
          if (cmd === "rooms__getRoomStreaming") {
            send(cmd, buildExtensionResponse(cmd, { streamFile: "Stream.swf", delay: 1 }));
            return;
          }
          if (cmd === "multiGames__setScore") {
            const score = Number((payload as Record<string, unknown>)?.score ?? 0);
            const gameDef = getStaticGameRoom(session.roomId);
            const sTc = gameDef?.sTc ?? 10;
            if (!session.gameSession && gameDef) {
              session.gameSession = { gameRoomId: session.roomId, startedAt: Date.now(), scoreSubmitted: false };
            }
            if (session.gameSession && !session.gameSession.scoreSubmitted) {
              session.gameSession.scoreSubmitted = true;
              session.playerData.coins += Math.floor(score / sTc);
              serverState.persistPlayerState(session);
              dispatch(serverState.updateUserVariables(session, { mo_1: session.playerData.coins }, false));
              serverState.recordGameScore(gameDef?.baseSwf ?? gameDef?.rN ?? "LifeGuard", session, score);
            }
            return;
          }
          if (cmd === "multiGames__topTen") {
            const gameDef = getStaticGameRoom(session.roomId);
            const rawKey = (payload as Record<string, unknown>)?.gameClassName;
            const gameKey = typeof rawKey === "string" && rawKey !== "topTen" ? rawKey : (gameDef?.baseSwf ?? gameDef?.rN ?? "LifeGuard");
            const topTen = serverState.getTopTen(gameKey);
            send(cmd, buildExtensionResponse(cmd, {
              type: "topTen",
              key: "topTen",
              result: topTen.result,
              winnerColor: topTen.winnerColor,
              winnerItems: topTen.winnerItems,
            }));
            return;
          }
          if (cmd === "rooms__changeRoom" || cmd === "rooms__jumpToRoom" || cmd === "room__changeRoomPass") {
            const resolution = resolveTargetRoomIdDetailed(payload, session.roomId);
            if (resolution.roomId === null) return;
            const availability = resolveRoomAvailability(buildId, resolution.roomId, { dataDir: options.dataDir });
            if (!availability.available) {
              send(cmd, buildExtensionResponse(cmd, {
                status: false,
                isAllowPlayGame: -1,
                errorId: 11,
                reason: availability.reason,
                roomId: resolution.roomId,
              }));
              return;
            }
            if (!sentRoomIds.has(resolution.roomId)) {
              const gameDef = getStaticGameRoom(resolution.roomId);
              sentRoomIds.add(resolution.roomId);
              send("roomAdd", buildSystemResponse("roomAdd", {
                id: resolution.roomId,
                name: gameDef ? gameDef.rN : `room_${resolution.roomId}`,
                isGame: false,
                isLimbo: Boolean(gameDef),
                userCount: serverState.rooms.get(resolution.roomId)?.sessions.size ?? 0,
              }));
            }
            const fromRoomId = cmd === "rooms__jumpToRoom" ? undefined : session.roomId;
            const joinResult = serverState.joinRoom(session, resolution.roomId, fromRoomId);
            send("joinOK", joinResult.joinOkBytes);
            dispatch(joinResult.broadcasts);
            return;
          }
          if (cmd === "pets__getRoomPets") {
            send(cmd, buildExtensionResponse(cmd, { pets: [] }));
            return;
          }
          if (cmd === "pets__canBuyPet") {
            send(cmd, buildExtensionResponse(cmd, { status: true }));
            return;
          }
          if (cmd === "user__move") {
            const p = payload as { x?: number; y?: number; AD?: number };
            if (typeof p.x === "number" && typeof p.y === "number") {
              session.x = p.x;
              session.y = p.y;
              if (typeof p.AD === "number") session.AD = p.AD;
              dispatch(serverState.broadcastRoomAction(session, "user__move", {
                uid: session.userId,
                x: session.x,
                y: session.y,
                AD: session.AD,
              }));
            }
            return;
          }
          if (cmd === "rooms__sendSpecialMove" || cmd === "rooms__sendDanceMoves" || cmd === "rooms__sendPublicAction") {
            dispatch(serverState.broadcastRoomAction(session, cmd, payload));
            return;
          }
        }
      } else {
        fail(`unexpected frame in phase ${session.phase}: ${summary}`);
      }
    };

    socket.on("data", (chunk) => {
      try {
        for (const bytes of framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
          handle(bytes);
        }
      } catch (error) {
        fail((error as Error).message);
      }
    });

    socket.on("close", () => {
      dispatch(serverState.handleDisconnect(socket));
    });

    socket.on("error", (error) => emit("socket-error", { error: error.message }));
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const actualPort = (server.address() as { port: number }).port;
      report({ time: new Date().toISOString(), event: "listening", port: actualPort });
      resolveServer({ server, port: actualPort, serverState });
    });
  });
}

export async function startSmartFoxRuntime(options: {
  tcpPort?: number;
  wsPort?: number;
  buildId?: string;
  dataDir?: string;
  onEvent?: (event: SmartFoxEvent) => void;
} = {}): Promise<SmartFoxRuntimeHandle> {
  const tcpPort = options.tcpPort ?? 8001;
  const wsPort = options.wsPort ?? 5174;

  const { server: tcpServer, port: actualTcpPort, serverState } = await startSmartFoxTcpServer({
    port: tcpPort,
    buildId: options.buildId,
    dataDir: options.dataDir,
    onEvent: options.onEvent,
  });

  const wsServer = await new Promise<WebSocketServer>((resolveWs, rejectWs) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: wsPort });
    wss.once("error", (err) => {
      tcpServer.close();
      rejectWs(err);
    });
    wss.once("listening", () => {
      wss.off("error", rejectWs);
      resolveWs(wss);
    });
  });

  const activeTcpSockets = new Set<Socket>();

  wsServer.on("connection", (ws, request) => {
    const origin = request.headers.origin ?? "";
    if (!origin.startsWith("http://127.0.0.1:") && !origin.startsWith("http://localhost:")) {
      ws.close(1008, "unexpected origin");
      return;
    }
    const tcp = new Socket();
    activeTcpSockets.add(tcp);
    tcp.connect(actualTcpPort, "127.0.0.1");
    tcp.on("error", () => ws.close(1011));
    tcp.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, "binary only");
        return;
      }
      tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    ws.on("close", () => {
      activeTcpSockets.delete(tcp);
      tcp.destroy();
    });
  });

  let closed = false;
  return {
    tcpPort: actualTcpPort,
    wsPort,
    serverState,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      for (const client of wsServer.clients) client.terminate();
      for (const sock of activeTcpSockets) sock.destroy();
      activeTcpSockets.clear();
      return new Promise((resolveClose) => {
        wsServer.close(() => {
          tcpServer.close(() => resolveClose());
        });
      });
    },
  };
}
