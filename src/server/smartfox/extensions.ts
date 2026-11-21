import { createHash } from "node:crypto";
import { frameText } from "./framing.ts";

export const DEFAULT_EXTENSION = "worlds4uEx";

/** RequestHelper.getMD5('mogo123' + d + '123mogo') in Candidate A. */
export function signExtensionData(encoded: string): string {
  return createHash("md5").update(`1qscvhui9mogo123${encoded}123mogo1qscvhui9`, "utf8").digest("hex");
}

export function encodeExtensionPayload(payload: unknown): { d: string; m: string } {
  const json = JSON.stringify(payload);
  if (json === undefined) throw new Error("extension payload is not JSON serializable");
  const d = Buffer.from(json, "utf8").toString("base64");
  return { d, m: signExtensionData(d) };
}

export function buildExtensionRequest(command: string, payload: unknown, extension = DEFAULT_EXTENSION, roomId = -1): Buffer {
  if (!command || !extension) throw new Error("extension and command are required");
  if (!Number.isSafeInteger(roomId)) throw new Error("room ID must be an integer");
  const p = encodeExtensionPayload(payload);
  return frameText(JSON.stringify({ t: "xt", b: { r: roomId, x: extension, c: command, p } }));
}

/** Candidate A's JSON ExtHandler reads b.o._cmd; no response MD5 is checked. */
export function buildExtensionResponse(command: string, payload: Record<string, unknown> = {}): Buffer {
  if (!command) throw new Error("extension command is required");
  return frameText(JSON.stringify({ t: "xt", b: { o: { ...payload, _cmd: command } } }));
}
