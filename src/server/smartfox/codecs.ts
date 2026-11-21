export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };
export type DecodedFrame = {
  kind: "SYS" | "XT" | "RAW" | "JSON" | "XML" | "UNKNOWN";
  summary: string;
  object: unknown;
  action?: string;
  command?: string;
  roomId?: number;
  payload?: Record<string, unknown>;
};

function entities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity[0] !== "#") return names[entity] ?? whole;
    const code = entity[1].toLowerCase() === "x"
      ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code) : whole;
  });
}

function tagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start; index < xml.length; index++) {
    const character = xml[index];
    if (quote) { if (character === quote) quote = ""; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  throw new Error("unterminated XML tag");
}

/** Small non-validating XML tree reader: enough for SmartFox envelopes and room lists. */
export function parseXml(xml: string): XmlNode {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const next = xml.indexOf("<", cursor);
    if (next < 0) {
      if (stack.length) stack.at(-1)!.text += entities(xml.slice(cursor));
      else if (xml.slice(cursor).trim()) throw new Error("text outside XML root");
      break;
    }
    if (next > cursor) {
      if (stack.length) stack.at(-1)!.text += entities(xml.slice(cursor, next));
      else if (xml.slice(cursor, next).trim()) throw new Error("text outside XML root");
    }
    if (xml.startsWith("<![CDATA[", next)) {
      const end = xml.indexOf("]]>", next + 9);
      if (end < 0 || !stack.length) throw new Error("invalid XML CDATA");
      stack.at(-1)!.text += xml.slice(next + 9, end);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<!--", next)) {
      const end = xml.indexOf("-->", next + 4);
      if (end < 0) throw new Error("unterminated XML comment");
      cursor = end + 3;
      continue;
    }
    const end = tagEnd(xml, next + 1);
    const inside = xml.slice(next + 1, end).trim();
    cursor = end + 1;
    if (inside.startsWith("?") || inside.startsWith("!")) continue;
    if (inside.startsWith("/")) {
      const name = inside.slice(1).trim();
      if (stack.pop()?.name !== name) throw new Error(`mismatched XML closing tag: ${name}`);
      continue;
    }
    const selfClosing = inside.endsWith("/");
    const tag = selfClosing ? inside.slice(0, -1).trimEnd() : inside;
    const match = /^([^\s/>]+)([\s\S]*)$/.exec(tag);
    if (!match) throw new Error("invalid XML tag");
    const name = match[1];
    const attributes = match[2];
    const attrs: Record<string, string> = {};
    const attributePattern = /([^\s=]+)\s*=\s*(['"])(.*?)\2/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(attributes))) attrs[attribute[1]] = entities(attribute[3]);
    if (attributes.replace(attributePattern, "").trim()) throw new Error(`invalid attributes in ${name}`);
    const node: XmlNode = { name, attrs, children: [], text: "" };
    if (stack.length) stack.at(-1)!.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || roots.length !== 1) throw new Error("incomplete XML document");
  return roots[0];
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((item) => item.name === name);
}

function numericRoom(value: unknown): number | undefined {
  const room = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(room) ? room : undefined;
}

export function decodeFrame(input: Buffer | string): DecodedFrame {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  if (text.startsWith("<")) {
    const object = parseXml(text);
    const body = child(object, "body");
    const action = body?.attrs.action;
    const roomId = numericRoom(body?.attrs.r);
    if (object.name === "msg" && object.attrs.t === "sys" && action) {
      return { kind: "SYS", summary: `SYS action=${action} room=${roomId ?? "?"}`, object, action, roomId };
    }
    if (object.name === "msg" && object.attrs.t === "xt") {
      return { kind: "XT", summary: `XT action=${action ?? "?"}`, object, action, roomId };
    }
    return { kind: "XML", summary: `XML root=${object.name}`, object };
  }
  if (text.startsWith("{")) {
    const object: unknown = JSON.parse(text);
    if (!object || typeof object !== "object") throw new Error("invalid JSON envelope");
    const envelope = object as Record<string, unknown>;
    const body = envelope.b && typeof envelope.b === "object" ? envelope.b as Record<string, unknown> : {};
    const response = body.o && typeof body.o === "object" ? body.o as Record<string, unknown> : {};
    const command = typeof response._cmd === "string" ? response._cmd
      : typeof body.c === "string" ? body.c : undefined;
    const roomId = numericRoom(body.r);
    if (envelope.t === "xt") {
      return { kind: "XT", summary: `XT command=${command ?? "?"}${roomId === undefined ? "" : ` room=${roomId}`}`,
        object, command, roomId, payload: response };
    }
    return { kind: "JSON", summary: `JSON type=${String(envelope.t ?? "?")}`, object };
  }
  if (text.startsWith("%")) {
    const segments = text.split("%");
    return { kind: "RAW", summary: `RAW ${segments.filter(Boolean).slice(0, 3).join(" ")}`, object: segments };
  }
  return { kind: "UNKNOWN", summary: `UNKNOWN bytes=${Buffer.byteLength(text, "utf8")}`, object: text };
}
