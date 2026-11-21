import { frameText } from "./framing.ts";

export function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

/** Exact generic system request wrapper used by Candidate A. */
export function buildSystem(action: string, roomId = -1, body = ""): Buffer {
  if (!action || /[\s'"<>]/.test(action)) throw new Error("invalid system action");
  if (!Number.isSafeInteger(roomId)) throw new Error("room ID must be an integer");
  return frameText(`<msg t='sys'><body action='${escapeXmlAttribute(action)}' r='${roomId}' >${body}</body></msg>`);
}

export type RoomResponse = { id: number; name: string; maxUsers?: number; userCount?: number };

export type UserDescription = {
  id: number;
  name: string;
  mod?: number;
  isSpectator?: boolean;
  playerId?: number;
  userVariables?: Record<string, unknown>;
};

function formatVars(variables: unknown, useCdata = false): string {
  if (variables === undefined || variables === null) return "";
  if (typeof variables !== "object" || Array.isArray(variables)) {
    throw new Error("userVariables must be an object");
  }
  const entries = Object.entries(variables as Record<string, unknown>).map(([key, value]) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`invalid variable ${key}`);
    }
    const type = typeof value === "boolean" ? "b" : typeof value === "number" ? "n" : "s";
    const formattedVal = type === "s" && useCdata
      ? `<![CDATA[${value}]]>`
      : escapeXmlAttribute(typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    return `<var n='${escapeXmlAttribute(key)}' t='${type}'>${formattedVal}</var>`;
  });
  return entries.length ? `<vars>${entries.join("")}</vars>` : "";
}

function formatUserTag(user: UserDescription): string {
  const varsTag = formatVars(user.userVariables);
  const mod = user.mod ?? 0;
  const isSpectator = user.isSpectator ? 1 : 0;
  const playerId = user.playerId ?? -1;
  return `<u i='${user.id}' m='${mod}' s='${isSpectator}' p='${playerId}'><n>${escapeXmlAttribute(user.name)}</n>${varsTag}</u>`;
}

/** Optional parser-shaped helpers. Unknown actions still use the generic builder. */
const responseHelpers: Record<string, (input: Record<string, unknown>) => { roomId: number; body: string }> = {
  logOK(input) {
    const id = integer(input.id, "id");
    const name = string(input.name, "name");
    const mod = input.mod === undefined ? 0 : integer(input.mod, "mod");
    return { roomId: 0, body: `<login id='${id}' mod='${mod}' n='${escapeXmlAttribute(name)}'/>` };
  },
  rmList(input) {
    if (!Array.isArray(input.rooms)) throw new Error("rmList requires rooms array");
    const rooms = input.rooms.map((item) => {
      if (!item || typeof item !== "object") throw new Error("invalid room");
      const room = item as Record<string, unknown>;
      const id = integer(room.id, "room.id");
      const name = string(room.name, "room.name");
      const maxUsers = room.maxUsers === undefined ? 10 : integer(room.maxUsers, "room.maxUsers");
      const userCount = room.userCount === undefined ? 0 : integer(room.userCount, "room.userCount");
      const isGame = room.isGame ? "1" : "0";
      const isLimbo = room.isLimbo ? "1" : "0";
      return `<rm id='${id}' maxu='${maxUsers}' maxs='0' temp='0' game='${isGame}' priv='0' lmb='${isLimbo}' ucnt='${userCount}' scnt='0'><n>${escapeXmlAttribute(name)}</n></rm>`;
    }).join("");
    return { roomId: -1, body: `<rmList>${rooms}</rmList>` };
  },
  roomAdd(input) {
    const id = integer(input.id, "id");
    const name = string(input.name, "name");
    const maxUsers = input.maxUsers === undefined ? 10 : integer(input.maxUsers, "maxUsers");
    const userCount = input.userCount === undefined ? 0 : integer(input.userCount, "userCount");
    const isGame = input.isGame ? "1" : "0";
    const isLimbo = input.isLimbo ? "1" : "0";
    return {
      roomId: 0,
      body: `<rm id='${id}' max='${maxUsers}' maxu='${maxUsers}' spec='0' maxs='0' temp='0' game='${isGame}' priv='0' limbo='${isLimbo}' lmb='${isLimbo}' ucnt='${userCount}' scnt='0'><name>${escapeXmlAttribute(name)}</name><n>${escapeXmlAttribute(name)}</n></rm>`,
    };
  },
  joinOK(input) {
    const roomId = integer(input.roomId, "roomId");
    const roomVars = formatVars(input.roomVariables, true);
    if (Array.isArray(input.users)) {
      const userTags = (input.users as UserDescription[]).map((u) => {
        const id = integer(u.id, "user.id");
        const name = string(u.name, "user.name");
        return formatUserTag({ ...u, id, name });
      }).join("");
      return { roomId, body: `<pid id='-1'/>${roomVars}<uLs>${userTags}</uLs>` };
    }
    const userId = integer(input.userId, "userId");
    const name = string(input.name, "name");
    const userTag = formatUserTag({
      id: userId,
      name,
      userVariables: input.userVariables as Record<string, unknown> | undefined,
    });
    return { roomId, body: `<pid id='-1'/>${roomVars}<uLs>${userTag}</uLs>` };
  },
  uER(input) {
    const roomId = integer(input.roomId, "roomId");
    const userId = integer(input.userId, "userId");
    const name = string(input.name, "name");
    const mod = input.mod === undefined ? 0 : integer(input.mod, "mod");
    const isSpectator = input.isSpectator ? true : false;
    const playerId = input.playerId === undefined ? -1 : integer(input.playerId, "playerId");
    const userTag = formatUserTag({
      id: userId,
      name,
      mod,
      isSpectator,
      playerId,
      userVariables: input.userVariables as Record<string, unknown> | undefined,
    });
    return { roomId, body: userTag };
  },
  userGone(input) {
    const roomId = integer(input.roomId, "roomId");
    const userId = integer(input.userId, "userId");
    return { roomId, body: `<user id='${userId}'/>` };
  },
  dmnMsg(input) {
    const roomId = input.roomId === undefined ? -1 : integer(input.roomId, "roomId");
    const text = string(input.text, "text");
    return { roomId, body: `<txt>${escapeXmlAttribute(text)}</txt>` };
  },
  uVarsUpdate(input) {
    const roomId = integer(input.roomId, "roomId");
    const userId = integer(input.userId, "userId");
    const variables = input.userVariables;
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new Error("userVariables must be an object");
    }
    const entries = Object.entries(variables as Record<string, unknown>).map(([key, value]) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`invalid user variable ${key}`);
      }
      const type = typeof value === "boolean" ? "b" : typeof value === "number" ? "n" : "s";
      return `<var n='${escapeXmlAttribute(key)}' t='${type}'>${escapeXmlAttribute(typeof value === "boolean" ? (value ? "1" : "0") : String(value))}</var>`;
    });
    return { roomId, body: `<user id='${userId}'/><vars>${entries.join("")}</vars>` };
  },
  pubMsg(input) {
    const roomId = integer(input.roomId, "roomId");
    const userId = integer(input.userId, "userId");
    const text = string(input.text, "text");
    return { roomId, body: `<user id='${userId}'/><txt>${escapeXmlAttribute(text)}</txt>` };
  },
  prvMsg(input) {
    const roomId = integer(input.roomId, "roomId");
    const userId = integer(input.userId, "userId");
    const text = string(input.text, "text");
    return { roomId, body: `<user id='${userId}'/><txt>${escapeXmlAttribute(text)}</txt>` };
  },
  bList(input) {
    const buddies = Array.isArray(input.buddies) ? (input.buddies as Array<Record<string, unknown>>) : [];
    const entries = buddies.map((b) => {
      const id = integer(b.id, "b.id");
      const name = string(b.name, "b.name");
      const isOnline = b.isOnline ? "1" : "0";
      return `<b id='${id}' s='${isOnline}'><n>${escapeXmlAttribute(name)}</n></b>`;
    }).join("");
    return { roomId: -1, body: `<bList>${entries}</bList>` };
  },
};

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function buildSystemResponse(action: string, input: Record<string, unknown> = {}, roomId?: number, body?: string): Buffer {
  if (body !== undefined) return buildSystem(action, roomId ?? -1, body);
  const helper = responseHelpers[action];
  if (!helper) {
    if (Object.keys(input).length) throw new Error(`no helper for ${action}; provide an explicit XML body`);
    return buildSystem(action, roomId ?? 0);
  }
  const result = helper(input);
  return buildSystem(action, roomId ?? result.roomId, result.body);
}
