/** Authoritative shared server state for Mogobe SmartFox runtime. */
import type { Socket } from "node:net";
import { buildExtensionResponse } from "./extensions.ts";
import { buildSystemResponse, type UserDescription } from "./system.ts";
import { resolveRoomBackgroundMusic, getStaticGameRoom, STATIC_GAME_ROOMS } from "./room-resolver.ts";
import { resolveRoomSpawnLocation } from "./room-coordinates.ts";
import { getAccount, updateAccountPlayerState, updateTwoAccountsTrade, getAccountRelationships, type StoredInventoryItem } from "../../storage/accounts-store.ts";
import { recordScore, getTopTen, type LeaderboardEntry } from "../../storage/leaderboards-store.ts";

export type InventoryItem = {
  id: number;
  typeId: number;
  sts: number;
  sCat: number;
  src: number;
  inStock: boolean;
  s: number;
  pCat?: number;
  mType?: number;
  trd?: number;
  locked?: boolean;
};

export type StoreCategory = {
  typeId: number;
  name: string;
};

export type StoreItem = {
  id: number;
  typeId: number;
  sCat: number;
  pCat: number;
  price: number;
  inStock: boolean;
  locked: boolean;
  sts: number;
  src: number;
  s: number;
  trd: number;
  mType: number;
};

export {
  CANONICAL_ROOM_ALIASES as CANONICAL_ROOM_NAME_TO_ID,
  resolveTargetRoomId,
  resolveTargetRoomIdDetailed,
} from "./room-navigation.ts";
export {
  resolveRoomAvailability,
  STATIC_GAME_ROOMS,
  getStaticGameRoom,
  resolveRoomBackgroundMusic,
  type StaticGameRoomDefinition,
  type RoomTaxonomy,
  type RoomAvailabilityResult,
  type RoomAvailabilityStatus,
  type RoomAvailabilityReason,
  type RoomAvailabilityOptions,
  type RoomMusicResolution,
  type RoomMusicStatus,
} from "./room-resolver.ts";

export function normalizeEffectForClient(text: string, is2016: boolean): string {
  if (!text.startsWith("effect__")) return text;
  const parts = text.split("__");
  if (parts.length < 2) return text;
  const rawEffect = parts[1];

  let mappedEffect = rawEffect;
  if (is2016) {
    if (rawEffect === "Ico_rain") mappedEffect = "Rain";
    else if (rawEffect === "Ico_snow") mappedEffect = "Snow";
    else if (rawEffect === "Ico_heart" || rawEffect === "Ico_hearts") mappedEffect = "Hearts";
    else if (rawEffect === "Ico_bubbles") mappedEffect = "Bubbles";
  } else {
    if (rawEffect === "Rain") mappedEffect = "Ico_rain";
    else if (rawEffect === "Snow") mappedEffect = "Ico_snow";
    else if (rawEffect === "Hearts") mappedEffect = "Ico_heart";
    else if (rawEffect === "Bubbles") mappedEffect = "Ico_bubbles";
  }

  if (mappedEffect === rawEffect) return text;
  parts[1] = mappedEffect;
  return parts.join("__");
}

export type Buddy = {
  buddyId: number;
  buddyName: string;
  status: number;
  serverName: string;
};

export type WallMessage = {
  id: number;
  fuId: number;
  fuN: string;
  tmId: number;
  tyId: number;
  c: string;
  n: boolean;
  sd: string;
};

export type PlayerData = {
  coins: number;
  color: number;
  inventory: InventoryItem[];
  buddies: Buddy[];
  wallMessages: WallMessage[];
  nextWallId: number;
  nextBuddyId: number;
  nextItemInstanceId: number;
  hasPersistentAccount?: boolean;
};

export type GameSessionState = {
  gameRoomId: number;
  startedAt: number;
  scoreSubmitted: boolean;
};

export type PlayerSession = {
  socket: Socket;
  userId: number;
  userName: string;
  color: number;
  x: number;
  y: number;
  AD: string | number;
  roomId: number;
  phase: number;
  playerData: PlayerData;
  gameSession?: GameSessionState;
  is2016?: boolean;
  inTrade?: number;
  inChat?: number;
};

export type RoomState = {
  id: number;
  name: string;
  type: string;
  sessions: Map<number, PlayerSession>;
};

export type OutgoingDispatch = {
  socket: Socket;
  label: string;
  bytes: Buffer;
};

export type InteractionType = "CHAT" | "TRADE";
export type InteractionStatus = "PENDING" | "ACTIVE" | "CLOSED";

export interface ActiveInteraction {
  id: string;
  type: InteractionType;
  initiatorUserId: number;
  targetUserId: number;
  initiatorName: string;
  targetName: string;
  status: InteractionStatus;
  createdAt: number;
  roomId: number;
  initiatorItems?: InventoryItem[];
  targetItems?: InventoryItem[];
  initiatorAccepted?: boolean;
  targetAccepted?: boolean;
  initiatorCoins?: number;
  targetCoins?: number;
}

export class ServerState {
  readonly sessionsBySocket = new Map<Socket, PlayerSession>();
  readonly sessionsByUserId = new Map<number, PlayerSession>();
  readonly activeUsersByName = new Map<string, PlayerSession>();
  readonly playersByName = new Map<string, PlayerData>();
  readonly rooms = new Map<number, RoomState>();
  readonly interactions = new Map<string, ActiveInteraction>();
  readonly storeCatalog: StoreItem[] = [];
  readonly storeCategories: StoreCategory[] = [];
  private nextUserId = 1;
  isItemCompatActive?: () => boolean;
  isRoomCompatActive?: () => boolean;
  profile = "20130526";
  workspaceRoot?: string;
  onPersistPlayerState?: (
    userName: string,
    state: { color?: number; coins?: number; inventory?: InventoryItem[] },
  ) => void;
  onRecordScore?: (
    gameKey: string,
    session: PlayerSession,
    score: number,
  ) => { isNewHighScore: boolean; rank: number };
  onGetTopTen?: (gameKey: string) => {
    result: Array<{ userName: string; score: number }>;
    winnerColor: number;
    winnerItems: Array<{ typeId: number }>;
  };

  constructor(
    defaultRoomId = 20,
    defaultRoomName = "room_20",
    defaultRoomType = "WR",
    options?: {
      isItemCompatActive?: () => boolean;
      isRoomCompatActive?: () => boolean;
      profile?: string;
      workspaceRoot?: string;
      onPersistPlayerState?: (
        userName: string,
        state: { color?: number; coins?: number; inventory?: InventoryItem[] },
      ) => void;
      onRecordScore?: (
        gameKey: string,
        session: PlayerSession,
        score: number,
      ) => { isNewHighScore: boolean; rank: number };
      onGetTopTen?: (gameKey: string) => {
        result: Array<{ userName: string; score: number }>;
        winnerColor: number;
        winnerItems: Array<{ typeId: number }>;
      };
      storeCatalog?: StoreItem[];
      storeCategories?: StoreCategory[];
    },
  ) {
    this.isItemCompatActive = options?.isItemCompatActive;
    this.isRoomCompatActive = options?.isRoomCompatActive;
    if (options?.profile) this.profile = options.profile;
    this.workspaceRoot = options?.workspaceRoot;
    this.onPersistPlayerState = options?.onPersistPlayerState;
    this.onRecordScore = options?.onRecordScore;
    this.onGetTopTen = options?.onGetTopTen;
    if (options?.storeCatalog) this.storeCatalog.push(...options.storeCatalog);
    if (options?.storeCategories) this.storeCategories.push(...options.storeCategories);
    this.rooms.set(defaultRoomId, {
      id: defaultRoomId,
      name: defaultRoomName,
      type: defaultRoomType,
      sessions: new Map(),
    });
  }

  allocateUserId(): number {
    return this.nextUserId++;
  }

  persistPlayerState(session: PlayerSession): void {
    if (!session.playerData.hasPersistentAccount) return;
    const payload = {
      color: session.playerData.color,
      coins: session.playerData.coins,
      inventory: session.playerData.inventory,
    };
    if (this.onPersistPlayerState) {
      this.onPersistPlayerState(session.userName, payload);
    } else {
      updateAccountPlayerState(session.userName, payload, this.workspaceRoot);
    }
  }

  persistTwoAccountsTrade(sessionA: PlayerSession, sessionB: PlayerSession): void {
    if (this.onPersistPlayerState) {
      if (sessionA.playerData.hasPersistentAccount) {
        this.onPersistPlayerState(sessionA.userName, {
          color: sessionA.playerData.color,
          coins: sessionA.playerData.coins,
          inventory: sessionA.playerData.inventory,
        });
      }
      if (sessionB.playerData.hasPersistentAccount) {
        this.onPersistPlayerState(sessionB.userName, {
          color: sessionB.playerData.color,
          coins: sessionB.playerData.coins,
          inventory: sessionB.playerData.inventory,
        });
      }
    } else {
      updateTwoAccountsTrade(
        sessionA.userName,
        {
          coins: sessionA.playerData.coins,
          inventory: sessionA.playerData.inventory,
        },
        sessionB.userName,
        {
          coins: sessionB.playerData.coins,
          inventory: sessionB.playerData.inventory,
        },
        this.workspaceRoot,
      );
    }
  }

  creditCoins(session: PlayerSession, amount: number): number {
    session.playerData.coins += Math.max(0, amount);
    this.persistPlayerState(session);
    return session.playerData.coins;
  }

  debitCoins(session: PlayerSession, amount: number): boolean {
    if (amount < 0 || session.playerData.coins < amount) return false;
    session.playerData.coins -= amount;
    this.persistPlayerState(session);
    return true;
  }

  recordGameScore(
    gameKey: string,
    session: PlayerSession,
    score: number,
  ): { isNewHighScore: boolean; rank: number } {
    if (this.onRecordScore) {
      return this.onRecordScore(gameKey, session, score);
    }
    const inUseItems = session.playerData.inventory
      .filter((i) => i.sts === 1)
      .map((i) => ({ typeId: i.typeId }));
    return recordScore(
      gameKey,
      {
        userId: session.userId,
        userName: session.userName,
        score,
        color: session.playerData.color,
        items: inUseItems,
      },
      this.workspaceRoot,
    );
  }

  getTopTen(gameKey: string): {
    result: Array<{ userName: string; score: number }>;
    winnerColor: number;
    winnerItems: Array<{ typeId: number }>;
  } {
    if (this.onGetTopTen) {
      return this.onGetTopTen(gameKey);
    }
    return getTopTen(gameKey, this.workspaceRoot);
  }

  addOwnedItem(session: PlayerSession, item: InventoryItem): void {
    session.playerData.inventory.push(item);
    this.persistPlayerState(session);
  }

  removeOwnedItem(session: PlayerSession, itemId: number): boolean {
    const idx = session.playerData.inventory.findIndex((i) => i.id === itemId || i.typeId === itemId);
    if (idx === -1) return false;
    session.playerData.inventory.splice(idx, 1);
    this.persistPlayerState(session);
    return true;
  }

  setEquippedState(session: PlayerSession, itemId: number, equipped: boolean): boolean {
    const item = session.playerData.inventory.find((i) => i.id === itemId || i.typeId === itemId);
    if (!item) return false;
    if (equipped) {
      for (const other of session.playerData.inventory) {
        if (other.id !== item.id && (other.pCat ?? 3) === (item.pCat ?? 3)) {
          other.sts = 0;
        }
      }
      item.sts = 1;
    } else {
      item.sts = 0;
    }
    this.persistPlayerState(session);
    return true;
  }

  getOrCreatePlayerData(
    userName: string,
    initialProps?: number | {
      color?: number;
      coins?: number;
      inventory?: InventoryItem[];
      hasPersistentAccount?: boolean;
    },
  ): PlayerData {
    const key = userName.trim().toLowerCase();
    let data = this.playersByName.get(key);
    if (!data) {
      let props = typeof initialProps === "number" ? { color: initialProps } : initialProps;
      if (!props || props.hasPersistentAccount === undefined) {
        const acc = getAccount(key, this.workspaceRoot);
        if (acc) {
          props = {
            ...props,
            color: props?.color ?? acc.color,
            coins: props?.coins ?? acc.coins ?? 500,
            inventory: props?.inventory ?? acc.inventory ?? [],
            hasPersistentAccount: true,
          };
        }
      }
      const initialInventory = props?.inventory ? [...props.inventory] : [];
      let maxInstanceSeq = 50000;
      for (const it of initialInventory) {
        const seq = (it.id ?? 0) % 100000;
        if (seq >= maxInstanceSeq) {
          maxInstanceSeq = seq + 1;
        }
      }

      data = {
        coins: props?.coins ?? 500,
        color: props?.color ?? 13,
        inventory: initialInventory,
        buddies: [],
        wallMessages: [
          { id: 1, fuId: 2, fuN: "LocalFriend", tmId: 1, tyId: 1, c: "Welcome to LocalGobe!", n: false, sd: "2013-05-26" },
        ],
        nextWallId: 2,
        nextBuddyId: 3,
        nextItemInstanceId: maxInstanceSeq,
        hasPersistentAccount: props?.hasPersistentAccount ?? false,
      };
      this.playersByName.set(key, data);
    }
    return data;
  }

  createSession(socket: Socket, defaultUserName = "user"): PlayerSession {
    const session: PlayerSession = {
      socket,
      userId: 0,
      userName: defaultUserName,
      color: 13,
      x: 376,
      y: 372,
      AD: 0,
      roomId: 20,
      phase: 0,
      playerData: this.getOrCreatePlayerData(defaultUserName),
      inTrade: 0,
      inChat: 0,
    };
    this.sessionsBySocket.set(socket, session);
    return session;
  }

  getSession(socket: Socket): PlayerSession | undefined {
    return this.sessionsBySocket.get(socket);
  }

  getSessionByUserId(userId: number): PlayerSession | undefined {
    return this.sessionsByUserId.get(userId);
  }

  handleLogin(
    session: PlayerSession,
    userName: string,
    customColor?: number,
    initialProps?: { coins?: number; inventory?: InventoryItem[]; hasPersistentAccount?: boolean },
  ): { userId: number; userName: string; kickedPreviousSession: boolean; kicks: OutgoingDispatch[] } {
    const key = userName.trim().toLowerCase();
    const existing = this.activeUsersByName.get(key);
    const kicks: OutgoingDispatch[] = [];
    let kickedPreviousSession = false;

    if (existing && existing !== session) {
      kickedPreviousSession = true;
      // 1. Send dmnMsg user__logInTwice to previous session
      kicks.push({
        socket: existing.socket,
        label: "dmnMsg-loginTwice",
        bytes: buildSystemResponse("dmnMsg", { text: "user__logInTwice" }),
      });
      // 2. Remove existing from its room and broadcast userGone to peers
      const leaveDispatches = this.leaveRoom(existing);
      kicks.push(...leaveDispatches);
      // 3. Unregister & close previous socket after flush
      const oldSocket = existing.socket;
      setImmediate(() => {
        try {
          oldSocket.destroy();
        } catch {}
      });
      this.sessionsBySocket.delete(existing.socket);
      this.sessionsByUserId.delete(existing.userId);
      this.activeUsersByName.delete(key);
    }

    const userId = this.allocateUserId();
    session.userId = userId;
    session.userName = userName;
    session.playerData = this.getOrCreatePlayerData(userName, {
      color: customColor ?? 13,
      coins: initialProps?.coins,
      inventory: initialProps?.inventory,
      hasPersistentAccount: initialProps?.hasPersistentAccount,
    });
    if (customColor !== undefined && customColor > 0) {
      session.color = customColor;
      session.playerData.color = customColor;
    } else {
      session.color = session.playerData.color;
    }

    // Authentic runtime behavior: no synthetic or invented inventory is injected into sessions.

    this.sessionsByUserId.set(userId, session);
    this.activeUsersByName.set(key, session);

    return { userId, userName, kickedPreviousSession, kicks };
  }

  getConfirmedFriendsCount(session: PlayerSession): number {
    const relationships = getAccountRelationships(session.userName, this.workspaceRoot);
    const relKeys = Object.keys(relationships);
    if (relKeys.length > 0) {
      return Object.values(relationships).filter((r) => r.status === 2 || r.status === 4).length;
    }
    return session.playerData.buddies.filter((b) => b.status === 2 || b.status === 4).length;
  }

  getUserVariables(session: PlayerSession): Record<string, string | number | boolean> {
    const inUseItems = session.playerData.inventory.filter((i) => i.sts === 1);
    const itemsPayload =
      inUseItems.length > 0
        ? inUseItems
        : [{ id: 0, typeId: 0, sts: 0, sCat: 0, src: 0, inStock: false, s: 0 }];
    return {
      x: session.x,
      y: session.y,
      AD: session.AD,
      color: session.color,
      age: "0",
      friends: String(this.getConfirmedFriendsCount(session)),
      score: 100,
      items: JSON.stringify(itemsPayload),
      mo_1: session.playerData.coins,
      mo_2: 0,
      inTrade: session.inTrade ?? 0,
      waitGamer: 0,
      inChat: session.inChat ?? 0,
    };
  }

  getOrCreateRoom(roomId: number): RoomState {
    let room = this.rooms.get(roomId);
    if (!room) {
      const gameDef = getStaticGameRoom(roomId);
      room = {
        id: roomId,
        name: gameDef ? gameDef.rN : `room_${roomId}`,
        type: gameDef ? gameDef.rT : "WR",
        sessions: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  joinRoom(session: PlayerSession, targetRoomId: number, fromRoomId?: number): {
    joinOkBytes: Buffer;
    broadcasts: OutgoingDispatch[];
  } {
    const broadcasts: OutgoingDispatch[] = [];
    if (session.roomId !== targetRoomId && this.rooms.has(session.roomId)) {
      broadcasts.push(...this.leaveRoom(session));
    }

    const room = this.getOrCreateRoom(targetRoomId);
    session.roomId = targetRoomId;

    // Reset avatar coordinates to the authentic spawn location for the target room
    const spawn = resolveRoomSpawnLocation(targetRoomId, fromRoomId);
    session.x = spawn.x;
    session.y = spawn.y;
    session.AD = spawn.AD;

    // All existing players currently in the room (excluding joining user to prevent duplicate user entry)
    const allUsers: UserDescription[] = [];
    for (const member of room.sessions.values()) {
      if (member.userId !== session.userId) {
        allUsers.push({
          id: member.userId,
          name: member.userName,
          userVariables: this.getUserVariables(member),
        });
      }
    }
    allUsers.push({
      id: session.userId,
      name: session.userName,
      userVariables: this.getUserVariables(session),
    });

    // Resolve room background music via authoritative manual mapping
    const musicResolution = resolveRoomBackgroundMusic(targetRoomId);
    const roomVariables: Record<string, string | number | boolean> = {};

    const gameDef = getStaticGameRoom(targetRoomId);
    if (gameDef && gameDef.rT === "WG") {
      roomVariables.swf = gameDef.swf;
      roomVariables.baseSwf = gameDef.baseSwf;
      roomVariables.rrr = String(gameDef.rrr);
      roomVariables.isGame = true;
      roomVariables.isWaitingGame = true;
      roomVariables.scoreToCoin = gameDef.sTc;
      roomVariables.lobbyRoomId = String(targetRoomId);
      roomVariables.lang = "he";
      roomVariables.lnag = "he";
      session.gameSession = {
        gameRoomId: targetRoomId,
        startedAt: Date.now(),
        scoreSubmitted: false,
      };
    } else {
      session.gameSession = undefined;
      if (musicResolution.status === "MAPPED" && musicResolution.rbs) {
        roomVariables.rbs = musicResolution.rbs;
      }
    }

    const joinOkBytes = buildSystemResponse("joinOK", {
      roomId: targetRoomId,
      users: allUsers,
      roomVariables: Object.keys(roomVariables).length > 0 ? roomVariables : undefined,
    });

    // Notify all existing players in the room about the new player (never notify joining user themselves)
    const uErBytes = buildSystemResponse("uER", {
      roomId: targetRoomId,
      userId: session.userId,
      name: session.userName,
      userVariables: this.getUserVariables(session),
    });

    for (const member of room.sessions.values()) {
      if (member.userId !== session.userId) {
        broadcasts.push({
          socket: member.socket,
          label: "uER",
          bytes: uErBytes,
        });
      }
    }

    room.sessions.set(session.userId, session);
    return { joinOkBytes, broadcasts };
  }

  leaveRoom(session: PlayerSession): OutgoingDispatch[] {
    session.gameSession = undefined;
    if (session.userId <= 0) return [];

    const dispatches: OutgoingDispatch[] = [];
    const interactionCleanup = this.exitInteraction(session).dispatches;
    dispatches.push(...interactionCleanup);

    const room = this.rooms.get(session.roomId);
    if (!room || !room.sessions.has(session.userId)) return dispatches;

    room.sessions.delete(session.userId);
    const userGoneBytes = buildSystemResponse("userGone", {
      roomId: room.id,
      userId: session.userId,
    });

    for (const member of room.sessions.values()) {
      dispatches.push({
        socket: member.socket,
        label: "userGone",
        bytes: userGoneBytes,
      });
    }
    return dispatches;
  }

  updateUserVariables(
    session: PlayerSession,
    updatedVars: Record<string, string | number | boolean>,
    excludeSelf = false,
  ): OutgoingDispatch[] {
    for (const [key, val] of Object.entries(updatedVars)) {
      if (key === "x") session.x = Number(val);
      else if (key === "y") session.y = Number(val);
      else if (key === "AD") session.AD = typeof val === "string" ? val : Number(val);
      else if (key === "color") {
        session.color = Number(val);
      } else if (key === "inTrade") {
        session.inTrade = Number(val);
      } else if (key === "inChat") {
        session.inChat = Number(val);
      }
    }

    const room = this.rooms.get(session.roomId);
    if (!room) return [];

    const updateBytes = buildSystemResponse("uVarsUpdate", {
      roomId: room.id,
      userId: session.userId,
      userVariables: updatedVars,
    });

    const dispatches: OutgoingDispatch[] = [];
    for (const member of room.sessions.values()) {
      if (excludeSelf && member.userId === session.userId) continue;
      dispatches.push({
        socket: member.socket,
        label: "uVarsUpdate",
        bytes: updateBytes,
      });
    }
    return dispatches;
  }

  broadcastPublicChat(session: PlayerSession, text: string): OutgoingDispatch[] {
    const room = this.rooms.get(session.roomId);
    if (!room) return [];

    const dispatches: OutgoingDispatch[] = [];
    for (const member of room.sessions.values()) {
      const deliveredText = normalizeEffectForClient(text, Boolean(member.is2016));
      const msgBytes = buildSystemResponse("pubMsg", {
        roomId: room.id,
        userId: session.userId,
        text: deliveredText,
      });
      dispatches.push({
        socket: member.socket,
        label: "pubMsg",
        bytes: msgBytes,
      });
    }
    return dispatches;
  }

  getInteractionForUser(userId: number): ActiveInteraction | undefined {
    for (const interaction of this.interactions.values()) {
      if (
        interaction.status !== "CLOSED" &&
        (interaction.initiatorUserId === userId || interaction.targetUserId === userId)
      ) {
        return interaction;
      }
    }
    return undefined;
  }

  createChatInteraction(
    session: PlayerSession,
    targetUserId: number,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const target = this.sessionsByUserId.get(targetUserId);
    if (!target) {
      return {
        success: false,
        error: "TARGET_NOT_FOUND",
        dispatches: [
          {
            socket: session.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: session.userId,
              secandUserId: targetUserId,
              firstName: session.userName,
              secandName: "Player",
              chatOnly: true,
            }),
          },
        ],
      };
    }

    if (target.userId === session.userId) {
      return { success: false, error: "SELF_INVITE", dispatches: [] };
    }

    const initiatorBusy = this.getInteractionForUser(session.userId);
    if (initiatorBusy) {
      return { success: false, error: "INITIATOR_BUSY", dispatches: [] };
    }

    const targetBusy = this.getInteractionForUser(target.userId);
    if (targetBusy) {
      return {
        success: false,
        error: "TARGET_BUSY",
        dispatches: [
          {
            socket: session.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: session.userId,
              secandUserId: target.userId,
              firstName: session.userName,
              secandName: target.userName,
              chatOnly: true,
            }),
          },
        ],
      };
    }

    const id = `chat_${session.userId}_${target.userId}_${Date.now()}`;
    const interaction: ActiveInteraction = {
      id,
      type: "CHAT",
      initiatorUserId: session.userId,
      targetUserId: target.userId,
      initiatorName: session.userName,
      targetName: target.userName,
      status: "PENDING",
      createdAt: Date.now(),
      roomId: session.roomId,
    };
    this.interactions.set(id, interaction);

    const payload = {
      firstUserId: session.userId,
      secandUserId: target.userId,
      firstName: session.userName,
      secandName: target.userName,
      chatOnly: true,
    };

    return {
      success: true,
      dispatches: [
        {
          socket: target.socket,
          label: "trade__create",
          bytes: buildExtensionResponse("trade__create", payload),
        },
      ],
    };
  }

  createTradeInteraction(
    session: PlayerSession,
    targetUserId: number,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const target = this.sessionsByUserId.get(targetUserId);
    if (!target) {
      return {
        success: false,
        error: "TARGET_NOT_FOUND",
        dispatches: [
          {
            socket: session.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: session.userId,
              secandUserId: targetUserId,
              firstName: session.userName,
              secandName: "",
              chatOnly: false,
            }),
          },
        ],
      };
    }

    if (target.userId === session.userId) {
      return { success: false, error: "SELF_INVITE", dispatches: [] };
    }

    const initiatorBusy = this.getInteractionForUser(session.userId);
    if (initiatorBusy) {
      return { success: false, error: "INITIATOR_BUSY", dispatches: [] };
    }

    const targetBusy = this.getInteractionForUser(target.userId);
    if (targetBusy) {
      return {
        success: false,
        error: "TARGET_BUSY",
        dispatches: [
          {
            socket: session.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: session.userId,
              secandUserId: target.userId,
              firstName: session.userName,
              secandName: target.userName,
              chatOnly: false,
            }),
          },
        ],
      };
    }

    const id = `trade_${session.userId}_${target.userId}_${Date.now()}`;
    const interaction: ActiveInteraction = {
      id,
      type: "TRADE",
      initiatorUserId: session.userId,
      targetUserId: target.userId,
      initiatorName: session.userName,
      targetName: target.userName,
      status: "PENDING",
      createdAt: Date.now(),
      roomId: session.roomId,
      initiatorItems: [],
      targetItems: [],
      initiatorAccepted: false,
      targetAccepted: false,
      initiatorCoins: 0,
      targetCoins: 0,
    };
    this.interactions.set(id, interaction);

    const payload = {
      firstUserId: session.userId,
      secandUserId: target.userId,
      firstName: session.userName,
      secandName: target.userName,
      chatOnly: false,
    };

    return {
      success: true,
      dispatches: [
        {
          socket: target.socket,
          label: "trade__create",
          bytes: buildExtensionResponse("trade__create", payload),
        },
      ],
    };
  }

  acceptChatInteraction(
    session: PlayerSession,
    initiatorUserId: number,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const interaction = this.getInteractionForUser(session.userId);
    if (
      !interaction ||
      interaction.type !== "CHAT" ||
      interaction.status !== "PENDING" ||
      interaction.targetUserId !== session.userId ||
      interaction.initiatorUserId !== initiatorUserId
    ) {
      return { success: false, error: "NO_PENDING_INTERACTION", dispatches: [] };
    }

    const initiator = this.sessionsByUserId.get(interaction.initiatorUserId);
    if (!initiator) {
      this.interactions.delete(interaction.id);
      return { success: false, error: "INITIATOR_OFFLINE", dispatches: [] };
    }

    interaction.status = "ACTIVE";

    // Set user variable inChat: 1 for both participants in their active rooms
    const uVarsA = this.updateUserVariables(initiator, { inChat: 1 }, false);
    const uVarsB = this.updateUserVariables(session, { inChat: 1 }, false);

    const payload = {
      firstUserId: interaction.initiatorUserId,
      secandUserId: interaction.targetUserId,
      firstName: interaction.initiatorName,
      secandName: interaction.targetName,
      chatOnly: true,
    };

    const dispatches: OutgoingDispatch[] = [
      {
        socket: initiator.socket,
        label: "trade__aproveStart",
        bytes: buildExtensionResponse("trade__aproveStart", payload),
      },
      ...uVarsA,
      ...uVarsB,
    ];

    return { success: true, dispatches };
  }

  acceptTradeInteraction(
    session: PlayerSession,
    initiatorUserId: number,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const interaction = this.getInteractionForUser(session.userId);
    if (
      !interaction ||
      interaction.type !== "TRADE" ||
      interaction.status !== "PENDING" ||
      interaction.targetUserId !== session.userId ||
      interaction.initiatorUserId !== initiatorUserId
    ) {
      return { success: false, error: "NO_PENDING_INTERACTION", dispatches: [] };
    }

    const initiator = this.sessionsByUserId.get(interaction.initiatorUserId);
    if (!initiator) {
      this.interactions.delete(interaction.id);
      return { success: false, error: "INITIATOR_OFFLINE", dispatches: [] };
    }

    interaction.status = "ACTIVE";
    interaction.initiatorItems = [];
    interaction.targetItems = [];
    interaction.initiatorAccepted = false;
    interaction.targetAccepted = false;
    interaction.initiatorCoins = 0;
    interaction.targetCoins = 0;

    // Set user variable inTrade: 1 for both participants in their active rooms
    const uVarsA = this.updateUserVariables(initiator, { inTrade: 1 }, false);
    const uVarsB = this.updateUserVariables(session, { inTrade: 1 }, false);

    const payload = {
      firstUserId: interaction.initiatorUserId,
      secandUserId: interaction.targetUserId,
      firstName: interaction.initiatorName,
      secandName: interaction.targetName,
      chatOnly: false,
    };

    const dispatches: OutgoingDispatch[] = [
      {
        socket: initiator.socket,
        label: "trade__aproveStart",
        bytes: buildExtensionResponse("trade__aproveStart", payload),
      },
      ...uVarsA,
      ...uVarsB,
    ];

    return { success: true, dispatches };
  }

  exitInteraction(session: PlayerSession): {
    success: boolean;
    dispatches: OutgoingDispatch[];
  } {
    const interaction = this.getInteractionForUser(session.userId);
    if (!interaction) return { success: false, dispatches: [] };

    const wasActive = interaction.status === "ACTIVE";
    const isChat = interaction.type === "CHAT";
    interaction.status = "CLOSED";
    this.interactions.delete(interaction.id);

    const otherUserId =
      interaction.initiatorUserId === session.userId
        ? interaction.targetUserId
        : interaction.initiatorUserId;
    const otherSession = this.sessionsByUserId.get(otherUserId);

    const dispatches: OutgoingDispatch[] = [];

    if (otherSession) {
      dispatches.push({
        socket: otherSession.socket,
        label: "trade__exit",
        bytes: buildExtensionResponse("trade__exit", {
          firstUserId: interaction.initiatorUserId,
          secandUserId: interaction.targetUserId,
          firstName: interaction.initiatorName,
          secandName: interaction.targetName,
          chatOnly: isChat,
        }),
      });
    }

    if (wasActive) {
      if (isChat) {
        // Reset user variable inChat: 0 for both participants
        const uVarsA = this.updateUserVariables(session, { inChat: 0 }, false);
        const uVarsB = otherSession ? this.updateUserVariables(otherSession, { inChat: 0 }, false) : [];
        dispatches.push(...uVarsA, ...uVarsB);
      } else {
        // Reset user variable inTrade: 0 for both participants
        const uVarsA = this.updateUserVariables(session, { inTrade: 0 }, false);
        const uVarsB = otherSession ? this.updateUserVariables(otherSession, { inTrade: 0 }, false) : [];
        dispatches.push(...uVarsA, ...uVarsB);
      }
    } else {
      session.inChat = 0;
      session.inTrade = 0;
      if (otherSession) {
        otherSession.inChat = 0;
        otherSession.inTrade = 0;
      }
    }

    return { success: true, dispatches };
  }

  exitChatInteraction(session: PlayerSession): {
    success: boolean;
    dispatches: OutgoingDispatch[];
  } {
    return this.exitInteraction(session);
  }

  changeTradeItems(
    session: PlayerSession,
    payload: Record<string, unknown>,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const interaction = this.getInteractionForUser(session.userId);
    if (!interaction || interaction.type !== "TRADE" || interaction.status !== "ACTIVE") {
      return { success: false, error: "NO_ACTIVE_TRADE", dispatches: [] };
    }

    const isInitiator = interaction.initiatorUserId === session.userId;
    const isTarget = interaction.targetUserId === session.userId;
    if (!isInitiator && !isTarget) {
      return { success: false, error: "NOT_IN_TRADE", dispatches: [] };
    }

    const otherUserId = isInitiator ? interaction.targetUserId : interaction.initiatorUserId;
    const otherSession = this.sessionsByUserId.get(otherUserId);
    if (!otherSession) {
      return this.terminateTradeOtherOffline(interaction, session);
    }

    const action = String(payload.action ?? "");
    const offeredItems = isInitiator
      ? (interaction.initiatorItems ??= [])
      : (interaction.targetItems ??= []);

    if (action === "addItem") {
      const rawItem = (payload.item as Record<string, unknown>) ?? {};
      const itemId = Number(rawItem.id);
      if (!itemId) {
        return { success: false, error: "INVALID_ITEM_ID", dispatches: [] };
      }

      // Authoritative validation: session must own this item in playerData.inventory
      const inventoryItem = session.playerData.inventory.find((i) => i.id === itemId);
      if (!inventoryItem) {
        return { success: false, error: "ITEM_NOT_OWNED", dispatches: [] };
      }

      // Item tradability check (trd !== 0)
      if (inventoryItem.trd === 0 || (rawItem.trd !== undefined && Number(rawItem.trd) === 0)) {
        return { success: false, error: "ITEM_NOT_TRADABLE", dispatches: [] };
      }

      // Check item not already added to current offer
      if (offeredItems.some((i) => i.id === itemId)) {
        return { success: false, error: "ITEM_ALREADY_OFFERED", dispatches: [] };
      }

      // Check trade slot capacity (Mogobe trade grid has 2 slots per user)
      if (offeredItems.length >= 2) {
        return { success: false, error: "TRADE_SLOTS_FULL", dispatches: [] };
      }

      offeredItems.push(inventoryItem);

      // Invalidate accept state on both sides upon item mutation
      interaction.initiatorAccepted = false;
      interaction.targetAccepted = false;

      const responsePayload = {
        action: "addItem",
        item: rawItem,
        firstName: interaction.initiatorName,
        secandName: interaction.targetName,
        firstUserId: interaction.initiatorUserId,
        secandUserId: interaction.targetUserId,
      };

      return {
        success: true,
        dispatches: [
          {
            socket: otherSession.socket,
            label: "trade__changeItems",
            bytes: buildExtensionResponse("trade__changeItems", responsePayload),
          },
        ],
      };
    }

    if (action === "removeItem") {
      const rawItem = (payload.item as Record<string, unknown>) ?? {};
      const itemId = Number(rawItem.id);
      if (!itemId) {
        return { success: false, error: "INVALID_ITEM_ID", dispatches: [] };
      }

      const idx = offeredItems.findIndex((i) => i.id === itemId);
      if (idx !== -1) {
        offeredItems.splice(idx, 1);
      }

      // Invalidate accept state on both sides upon item mutation
      interaction.initiatorAccepted = false;
      interaction.targetAccepted = false;

      const responsePayload = {
        action: "removeItem",
        item: rawItem,
        firstName: interaction.initiatorName,
        secandName: interaction.targetName,
        firstUserId: interaction.initiatorUserId,
        secandUserId: interaction.targetUserId,
      };

      return {
        success: true,
        dispatches: [
          {
            socket: otherSession.socket,
            label: "trade__changeItems",
            bytes: buildExtensionResponse("trade__changeItems", responsePayload),
          },
        ],
      };
    }

    if (action === "amountChange") {
      const coins = Number(payload.coins) || 0;
      if (coins < 0 || coins > session.playerData.coins) {
        return { success: false, error: "INVALID_COIN_AMOUNT", dispatches: [] };
      }

      if (isInitiator) {
        interaction.initiatorCoins = coins;
      } else {
        interaction.targetCoins = coins;
      }

      interaction.initiatorAccepted = false;
      interaction.targetAccepted = false;

      const responsePayload = {
        action: "amountChange",
        coins,
        firstName: interaction.initiatorName,
        secandName: interaction.targetName,
        firstUserId: interaction.initiatorUserId,
        secandUserId: interaction.targetUserId,
      };

      return {
        success: true,
        dispatches: [
          {
            socket: otherSession.socket,
            label: "trade__changeItems",
            bytes: buildExtensionResponse("trade__changeItems", responsePayload),
          },
        ],
      };
    }

    return { success: false, error: "UNKNOWN_ACTION", dispatches: [] };
  }

  acceptTrade(
    session: PlayerSession,
    _payload: Record<string, unknown>,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const interaction = this.getInteractionForUser(session.userId);
    if (!interaction || interaction.type !== "TRADE" || interaction.status !== "ACTIVE") {
      return { success: false, error: "NO_ACTIVE_TRADE", dispatches: [] };
    }

    const isInitiator = interaction.initiatorUserId === session.userId;
    const isTarget = interaction.targetUserId === session.userId;
    if (!isInitiator && !isTarget) {
      return { success: false, error: "NOT_IN_TRADE", dispatches: [] };
    }

    const otherUserId = isInitiator ? interaction.targetUserId : interaction.initiatorUserId;
    const otherSession = this.sessionsByUserId.get(otherUserId);
    if (!otherSession) {
      return this.terminateTradeOtherOffline(interaction, session);
    }

    if (isInitiator) {
      interaction.initiatorAccepted = true;
    } else {
      interaction.targetAccepted = true;
    }

    if (interaction.initiatorAccepted && interaction.targetAccepted) {
      // Authoritative final execution
      const initiator = this.sessionsByUserId.get(interaction.initiatorUserId);
      const target = this.sessionsByUserId.get(interaction.targetUserId);

      if (!initiator || !target) {
        interaction.status = "CLOSED";
        this.interactions.delete(interaction.id);
        const dispatches: OutgoingDispatch[] = [];
        if (initiator) {
          dispatches.push({
            socket: initiator.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: interaction.initiatorUserId,
              secandUserId: interaction.targetUserId,
              firstName: interaction.initiatorName,
              secandName: interaction.targetName,
              chatOnly: false,
            }),
          });
          dispatches.push(...this.updateUserVariables(initiator, { inTrade: 0 }, false));
        }
        if (target) {
          dispatches.push({
            socket: target.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: interaction.initiatorUserId,
              secandUserId: interaction.targetUserId,
              firstName: interaction.initiatorName,
              secandName: interaction.targetName,
              chatOnly: false,
            }),
          });
          dispatches.push(...this.updateUserVariables(target, { inTrade: 0 }, false));
        }
        return { success: false, error: "PARTICIPANT_OFFLINE", dispatches };
      }

      const initiatorOffered = interaction.initiatorItems ?? [];
      const targetOffered = interaction.targetItems ?? [];
      const initiatorCoins = interaction.initiatorCoins ?? 0;
      const targetCoins = interaction.targetCoins ?? 0;

      // Ownership and tradability re-validation for initiator items
      for (const offered of initiatorOffered) {
        const item = initiator.playerData.inventory.find((i) => i.id === offered.id);
        if (!item || item.trd === 0) {
          return this.failTrade(interaction, initiator, target, "INITIATOR_ITEM_INVALID");
        }
      }

      // Ownership and tradability re-validation for target items
      for (const offered of targetOffered) {
        const item = target.playerData.inventory.find((i) => i.id === offered.id);
        if (!item || item.trd === 0) {
          return this.failTrade(interaction, initiator, target, "TARGET_ITEM_INVALID");
        }
      }

      // Coin re-validation
      if (initiatorCoins > 0 && initiator.playerData.coins < initiatorCoins) {
        return this.failTrade(interaction, initiator, target, "INITIATOR_INSUFFICIENT_COINS");
      }
      if (targetCoins > 0 && target.playerData.coins < targetCoins) {
        return this.failTrade(interaction, initiator, target, "TARGET_INSUFFICIENT_COINS");
      }

      // Check for duplicate instances within offered lists
      const initIds = new Set(initiatorOffered.map((i) => i.id));
      if (initIds.size !== initiatorOffered.length) {
        return this.failTrade(interaction, initiator, target, "DUPLICATE_OFFERED_ITEM");
      }
      const targetIds = new Set(targetOffered.map((i) => i.id));
      if (targetIds.size !== targetOffered.length) {
        return this.failTrade(interaction, initiator, target, "DUPLICATE_OFFERED_ITEM");
      }

      // Atomic transfer of items
      // 1. Initiator -> Target
      for (const offered of initiatorOffered) {
        const idx = initiator.playerData.inventory.findIndex((i) => i.id === offered.id);
        if (idx !== -1) {
          const [removed] = initiator.playerData.inventory.splice(idx, 1);
          // LOCALGOBE_COMPAT_POLICY: transferred item lands unequipped (sts: 0) in recipient inventory
          removed.sts = 0;
          target.playerData.inventory.push(removed);
        }
      }

      // 2. Target -> Initiator
      for (const offered of targetOffered) {
        const idx = target.playerData.inventory.findIndex((i) => i.id === offered.id);
        if (idx !== -1) {
          const [removed] = target.playerData.inventory.splice(idx, 1);
          // LOCALGOBE_COMPAT_POLICY: transferred item lands unequipped (sts: 0) in recipient inventory
          removed.sts = 0;
          initiator.playerData.inventory.push(removed);
        }
      }

      // 3. Coin exchange
      if (initiatorCoins > 0 || targetCoins > 0) {
        initiator.playerData.coins += (targetCoins - initiatorCoins);
        target.playerData.coins += (initiatorCoins - targetCoins);
      }

      // 4. Atomic disk persistence across both accounts
      this.persistTwoAccountsTrade(initiator, target);

      // 5. Close interaction
      interaction.status = "CLOSED";
      this.interactions.delete(interaction.id);

      // 6. Broadcast isolated inTrade: 0 for both participants BEFORE items/mo_1
      const uVarsTradeA = this.updateUserVariables(initiator, { inTrade: 0 }, false);
      const uVarsTradeB = this.updateUserVariables(target, { inTrade: 0 }, false);

      // 7. Broadcast active equipped items and coins for both participants
      const inUseInitiator = initiator.playerData.inventory.filter((i) => i.sts === 1);
      const initPayload = inUseInitiator.length > 0 ? inUseInitiator : [{ id: 0, typeId: 0, sts: 0, sCat: 0, src: 0, inStock: false, s: 0 }];
      const uVarsItemsA = this.updateUserVariables(initiator, {
        items: JSON.stringify(initPayload),
        mo_1: initiator.playerData.coins,
      }, false);

      const inUseTarget = target.playerData.inventory.filter((i) => i.sts === 1);
      const targetPayload = inUseTarget.length > 0 ? inUseTarget : [{ id: 0, typeId: 0, sts: 0, sCat: 0, src: 0, inStock: false, s: 0 }];
      const uVarsItemsB = this.updateUserVariables(target, {
        items: JSON.stringify(targetPayload),
        mo_1: target.playerData.coins,
      }, false);

      // 8. Dispatch trade__execute to BOTH participants
      const executePayload = {
        status: true,
        firstUserId: interaction.initiatorUserId,
        secandUserId: interaction.targetUserId,
        firstName: interaction.initiatorName,
        secandName: interaction.targetName,
      };

      const dispatches: OutgoingDispatch[] = [
        {
          socket: initiator.socket,
          label: "trade__execute",
          bytes: buildExtensionResponse("trade__execute", executePayload),
        },
        {
          socket: target.socket,
          label: "trade__execute",
          bytes: buildExtensionResponse("trade__execute", executePayload),
        },
        ...uVarsTradeA,
        ...uVarsTradeB,
        ...uVarsItemsA,
        ...uVarsItemsB,
      ];

      return { success: true, dispatches };
    }

    // REMOTE_ONLY: Notify other participant of the approval
    const responsePayload = {
      startTrade: true,
      firstName: interaction.initiatorName,
      secandName: interaction.targetName,
      firstUserId: interaction.initiatorUserId,
      secandUserId: interaction.targetUserId,
    };

    return {
      success: true,
      dispatches: [
        {
          socket: otherSession.socket,
          label: "trade__acceptTrade",
          bytes: buildExtensionResponse("trade__acceptTrade", responsePayload),
        },
      ],
    };
  }

  private terminateTradeOtherOffline(
    interaction: ActiveInteraction,
    session: PlayerSession,
  ): { success: boolean; error: string; dispatches: OutgoingDispatch[] } {
    interaction.status = "CLOSED";
    this.interactions.delete(interaction.id);
    const uVarsClear = this.updateUserVariables(session, { inTrade: 0 }, false);
    return {
      success: false,
      error: "OTHER_OFFLINE",
      dispatches: [
        {
          socket: session.socket,
          label: "trade__exit",
          bytes: buildExtensionResponse("trade__exit", {
            firstUserId: interaction.initiatorUserId,
            secandUserId: interaction.targetUserId,
            firstName: interaction.initiatorName,
            secandName: interaction.targetName,
            chatOnly: false,
          }),
        },
        ...uVarsClear,
      ],
    };
  }

  private failTrade(
    interaction: ActiveInteraction,
    initiator: PlayerSession,
    target: PlayerSession,
    reason: string,
  ): { success: boolean; error?: string; dispatches: OutgoingDispatch[] } {
    interaction.status = "CLOSED";
    this.interactions.delete(interaction.id);

    const failPayload = {
      status: false,
      reason,
      firstUserId: interaction.initiatorUserId,
      secandUserId: interaction.targetUserId,
    };

    const exitPayload = {
      firstUserId: interaction.initiatorUserId,
      secandUserId: interaction.targetUserId,
      firstName: interaction.initiatorName,
      secandName: interaction.targetName,
      chatOnly: false,
    };

    const uVarsA = this.updateUserVariables(initiator, { inTrade: 0 }, false);
    const uVarsB = this.updateUserVariables(target, { inTrade: 0 }, false);

    const dispatches: OutgoingDispatch[] = [
      {
        socket: initiator.socket,
        label: "trade__fail",
        bytes: buildExtensionResponse("trade__fail", failPayload),
      },
      {
        socket: target.socket,
        label: "trade__fail",
        bytes: buildExtensionResponse("trade__fail", failPayload),
      },
      {
        socket: initiator.socket,
        label: "trade__exit",
        bytes: buildExtensionResponse("trade__exit", exitPayload),
      },
      {
        socket: target.socket,
        label: "trade__exit",
        bytes: buildExtensionResponse("trade__exit", exitPayload),
      },
      ...uVarsA,
      ...uVarsB,
    ];

    return { success: false, error: reason, dispatches };
  }

  rejectTrade(
    session: PlayerSession,
    _payload: Record<string, unknown>,
  ): {
    success: boolean;
    error?: string;
    dispatches: OutgoingDispatch[];
  } {
    const interaction = this.getInteractionForUser(session.userId);
    if (!interaction || interaction.type !== "TRADE" || interaction.status !== "ACTIVE") {
      return { success: false, error: "NO_ACTIVE_TRADE", dispatches: [] };
    }

    const isInitiator = interaction.initiatorUserId === session.userId;
    const isTarget = interaction.targetUserId === session.userId;
    if (!isInitiator && !isTarget) {
      return { success: false, error: "NOT_IN_TRADE", dispatches: [] };
    }

    const otherUserId = isInitiator ? interaction.targetUserId : interaction.initiatorUserId;
    const otherSession = this.sessionsByUserId.get(otherUserId);
    if (!otherSession) {
      return this.terminateTradeOtherOffline(interaction, session);
    }

    if (isInitiator) {
      interaction.initiatorAccepted = false;
    } else {
      interaction.targetAccepted = false;
    }

    // REMOTE_ONLY: Notify other participant of the rejection
    const responsePayload = {
      startTrade: true,
      firstName: interaction.initiatorName,
      secandName: interaction.targetName,
      firstUserId: interaction.initiatorUserId,
      secandUserId: interaction.targetUserId,
    };

    return {
      success: true,
      dispatches: [
        {
          socket: otherSession.socket,
          label: "trade__rejectTrade",
          bytes: buildExtensionResponse("trade__rejectTrade", responsePayload),
        },
      ],
    };
  }

  /**
   * LOCALGOBE_RECONSTRUCTED_SERVER_BEHAVIOR:
   * Safety expiry cleanup for abandoned PENDING invites (e.g. client dropped packet or hung).
   */
  cleanupExpiredInteractions(now = Date.now(), maxPendingMs = 30000): OutgoingDispatch[] {
    const dispatches: OutgoingDispatch[] = [];
    for (const [id, interaction] of this.interactions.entries()) {
      if (interaction.status === "PENDING" && now - interaction.createdAt > maxPendingMs) {
        interaction.status = "CLOSED";
        this.interactions.delete(id);
        const initiator = this.sessionsByUserId.get(interaction.initiatorUserId);
        if (initiator) {
          dispatches.push({
            socket: initiator.socket,
            label: "trade__exit",
            bytes: buildExtensionResponse("trade__exit", {
              firstUserId: interaction.initiatorUserId,
              secandUserId: interaction.targetUserId,
              firstName: interaction.initiatorName,
              secandName: interaction.targetName,
              chatOnly: interaction.type === "CHAT",
            }),
          });
        }
      }
    }
    return dispatches;
  }

  sendPrivateChat(session: PlayerSession, targetUserId: number, text: string): OutgoingDispatch[] {
    const isSpringChat = text.startsWith("speak__");
    const interaction = this.getInteractionForUser(session.userId);

    // Strictly authorize speak__ messages against ACTIVE chat or trade interaction
    if (isSpringChat) {
      if (
        !interaction ||
        (interaction.type !== "CHAT" && interaction.type !== "TRADE") ||
        interaction.status !== "ACTIVE" ||
        (interaction.initiatorUserId !== targetUserId && interaction.targetUserId !== targetUserId)
      ) {
        return [];
      }
    }

    const target = this.sessionsByUserId.get(targetUserId);
    if (!target) return [];

    const msgBytes = buildSystemResponse("prvMsg", {
      roomId: session.roomId,
      userId: session.userId,
      text,
    });

    return [
      {
        socket: target.socket,
        label: "prvMsg",
        bytes: msgBytes,
      },
      {
        socket: session.socket,
        label: "prvMsg",
        bytes: msgBytes,
      },
    ];
  }

  broadcastRoomAction(
    session: PlayerSession,
    command: string,
    payload: Record<string, unknown>,
  ): OutgoingDispatch[] {
    const room = this.rooms.get(session.roomId);
    if (!room) return [];

    const dispatches: OutgoingDispatch[] = [];

    if (command === "rooms__sendDanceMoves") {
      const rawMove = payload.move ?? payload.moves ?? payload.d ?? payload;
      const moveStr = Array.isArray(rawMove) ? rawMove.join(",") : String(rawMove || "1");
      session.AD = moveStr.startsWith("__D") ? moveStr : "__D" + moveStr;
      const updateBytes = buildSystemResponse("uVarsUpdate", {
        roomId: room.id,
        userId: session.userId,
        userVariables: { AD: session.AD },
      });
      for (const member of room.sessions.values()) {
        if (member.userId !== session.userId) {
          dispatches.push({
            socket: member.socket,
            label: "uVarsUpdate",
            bytes: updateBytes,
          });
        }
      }
    } else if (command === "rooms__sendSpecialMove") {
      const rawMove = payload.move ?? payload.direction ?? payload.d ?? 1;
      session.AD = typeof rawMove === "number" ? rawMove : Number(rawMove) || 1;
      const updateBytes = buildSystemResponse("uVarsUpdate", {
        roomId: room.id,
        userId: session.userId,
        userVariables: { AD: session.AD },
      });
      for (const member of room.sessions.values()) {
        if (member.userId !== session.userId) {
          dispatches.push({
            socket: member.socket,
            label: "uVarsUpdate",
            bytes: updateBytes,
          });
        }
      }
    } else if (command === "user__move") {
      const updateBytes = buildSystemResponse("uVarsUpdate", {
        roomId: room.id,
        userId: session.userId,
        userVariables: { x: session.x, y: session.y, AD: session.AD },
      });
      const moveBytes = buildExtensionResponse("user__move", {
        uid: session.userId,
        x: session.x,
        y: session.y,
        AD: session.AD,
      });
      for (const member of room.sessions.values()) {
        if (member.userId !== session.userId) {
          dispatches.push({
            socket: member.socket,
            label: "user__move",
            bytes: moveBytes,
          });
          dispatches.push({
            socket: member.socket,
            label: "uVarsUpdate",
            bytes: updateBytes,
          });
        }
      }
      return dispatches;
    }

    const actionBytes = buildExtensionResponse(command, { sender: session.userId, ...payload });
    for (const member of room.sessions.values()) {
      dispatches.push({
        socket: member.socket,
        label: command,
        bytes: actionBytes,
      });
    }
    return dispatches;
  }

  buyItem(
    session: PlayerSession,
    itemId: number,
  ): {
    success: boolean;
    msgId?: number;
    purchasedItem?: InventoryItem;
    dispatches: OutgoingDispatch[];
  } {
    // Client sends { itemId: this.itemToBuy.typeId }
    const catalogItem = this.storeCatalog.find(
      (item) => item.typeId === itemId || item.id === itemId,
    );

    if (!catalogItem) {
      // msgId 2 = generic purchase failure response
      const errBytes = buildExtensionResponse("user__buyItem", { status: false, msgId: 2 });
      return {
        success: false,
        msgId: 2,
        dispatches: [{ socket: session.socket, label: "user__buyItem", bytes: errBytes }],
      };
    }

    if (session.playerData.coins < catalogItem.price) {
      // msgId 1 = insufficient-currency response
      const errBytes = buildExtensionResponse("user__buyItem", { status: false, msgId: 1 });
      return {
        success: false,
        msgId: 1,
        dispatches: [{ socket: session.socket, label: "user__buyItem", bytes: errBytes }],
      };
    }

    // Deduct price
    session.playerData.coins -= catalogItem.price;

    // Allocate deterministic unique instance ID: session.userId * 100000 + nextItemInstanceId++
    const instanceSeq = session.playerData.nextItemInstanceId ?? 50000;
    session.playerData.nextItemInstanceId = instanceSeq + 1;
    const newInstanceId = session.userId * 100000 + instanceSeq;

    const newItem: InventoryItem = {
      id: newInstanceId,
      typeId: catalogItem.typeId,
      sts: 0,
      sCat: catalogItem.sCat,
      pCat: catalogItem.pCat,
      mType: catalogItem.mType,
      src: catalogItem.src,
      inStock: true,
      s: catalogItem.s,
      trd: catalogItem.trd,
      locked: false,
    };
    session.playerData.inventory.push(newItem);
    this.persistPlayerState(session);

    // Broadcast updated balance (mo_1) to all room members including the purchaser
    const uVarsUpdates = this.updateUserVariables(
      session,
      { mo_1: session.playerData.coins },
      false,
    );

    // Build success response: { status: true, itemId: catalogItem.typeId, coins: newBalance }
    const successBytes = buildExtensionResponse("user__buyItem", {
      status: true,
      itemId: catalogItem.typeId,
      coins: session.playerData.coins,
    });

    return {
      success: true,
      purchasedItem: newItem,
      dispatches: [
        ...uVarsUpdates,
        { socket: session.socket, label: "user__buyItem", bytes: successBytes },
      ],
    };
  }

  handleDisconnect(socket: Socket): OutgoingDispatch[] {
    const session = this.sessionsBySocket.get(socket);
    if (!session) return [];

    const dispatches = this.leaveRoom(session);
    this.sessionsBySocket.delete(socket);
    this.sessionsByUserId.delete(session.userId);

    const key = session.userName.trim().toLowerCase();
    if (this.activeUsersByName.get(key) === session) {
      this.activeUsersByName.delete(key);
    }
    return dispatches;
  }
}
