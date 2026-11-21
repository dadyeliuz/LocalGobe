import { inflateSync } from "node:zlib";

export interface MapPopupContractResult {
  compatible: boolean;
  reason: string;
  recognized: boolean;
  structurallyCompatible: boolean;
  rootMlPopupFound: boolean;
  mlPopupSpriteFound: boolean;
  hasBtnClose: boolean;
  hasMcMap: boolean;
  mcMapSpriteFound: boolean;
  roomButtons: string[];
  roomButtonCount: number;
}

class SwfBitReader {
  private data: Buffer;
  private pos = 0;
  private buf = 0;
  private bitsLeft = 0;

  constructor(data: Buffer, startPos = 0) {
    this.data = data;
    this.pos = startPos;
  }

  readBit(): number {
    if (this.bitsLeft === 0) {
      if (this.pos >= this.data.length) return 0;
      this.buf = this.data[this.pos++];
      this.bitsLeft = 8;
    }
    this.bitsLeft--;
    return (this.buf >> this.bitsLeft) & 1;
  }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | this.readBit();
    }
    return val;
  }

  readSBits(n: number): number {
    let v = this.readBits(n);
    if (n > 0 && (v & (1 << (n - 1)))) {
      v -= 1 << n;
    }
    return v;
  }

  align(): void {
    this.buf = 0;
    this.bitsLeft = 0;
  }

  readUInt8(): number {
    this.align();
    return this.pos < this.data.length ? this.data[this.pos++] : 0;
  }

  readUInt16LE(): number {
    this.align();
    if (this.pos + 2 > this.data.length) return 0;
    const v = this.data.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readString(): string {
    this.align();
    const start = this.pos;
    const end = this.data.indexOf(0, start);
    if (end === -1) {
      this.pos = this.data.length;
      return this.data.subarray(start).toString("latin1");
    }
    this.pos = end + 1;
    return this.data.subarray(start, end).toString("latin1");
  }

  skipMatrix(): void {
    const hasScale = this.readBit();
    if (hasScale) {
      const nbits = this.readBits(5);
      this.readSBits(nbits);
      this.readSBits(nbits);
    }
    const hasRotate = this.readBit();
    if (hasRotate) {
      const nbits = this.readBits(5);
      this.readSBits(nbits);
      this.readSBits(nbits);
    }
    const nbits = this.readBits(5);
    this.readSBits(nbits);
    this.readSBits(nbits);
    this.align();
  }

  skipCxform(hasAlpha: boolean): void {
    const hasAdd = this.readBit();
    const hasMult = this.readBit();
    const nbits = this.readBits(4);
    const channels = hasAlpha ? 4 : 3;
    if (hasMult) {
      for (let i = 0; i < channels; i++) this.readSBits(nbits);
    }
    if (hasAdd) {
      for (let i = 0; i < channels; i++) this.readSBits(nbits);
    }
    this.align();
  }
}

interface PlaceObjectInstance {
  depth: number;
  characterId: number | null;
  name: string | null;
}

function parsePlaceObject(code: number, tagBody: Buffer): PlaceObjectInstance {
  const br = new SwfBitReader(tagBody);
  const flags1 = br.readUInt8();
  const flags2 = code === 70 ? br.readUInt8() : 0;

  const hasCharacter = Boolean(flags1 & 0x02);
  const hasMatrix = Boolean(flags1 & 0x04);
  const hasColorTransform = Boolean(flags1 & 0x08);
  const hasRatio = Boolean(flags1 & 0x10);
  const hasName = Boolean(flags1 & 0x20);

  const depth = br.readUInt16LE();
  let characterId: number | null = null;

  // PlaceObject3 has optional className
  if (code === 70 && (flags2 & 0x01)) {
    br.readString(); // className
  }
  if (hasCharacter) {
    characterId = br.readUInt16LE();
  }
  if (hasMatrix) {
    br.skipMatrix();
  }
  if (hasColorTransform) {
    br.skipCxform(code === 26 || code === 70);
  }
  if (hasRatio) {
    br.readUInt16LE();
  }
  let name: string | null = null;
  if (hasName) {
    name = br.readString();
  }
  return { depth, characterId, name };
}

/**
 * Parses SWF binary tags to structurally verify the 2016 MapPopup contract.
 *
 * Requirements:
 * 1. Root timeline has a PlaceObject2/3 instance named "mlPopup_3"
 * 2. mlPopup_3 is a DefineSprite containing:
 *    - Child instance named "btnClose"
 *    - Child instance named "mcMap"
 * 3. mcMap is a DefineSprite containing at least one child instance named "btnRoom_<roomId>"
 *
 * Does NOT accept SymbolClass or string occurrence alone as instance proof.
 */
export function verifyMapPopupStructuralContract(swfBytes: Buffer): MapPopupContractResult {
  const baseResult: MapPopupContractResult = {
    compatible: false,
    reason: "Invalid or empty SWF",
    recognized: false,
    structurallyCompatible: false,
    rootMlPopupFound: false,
    mlPopupSpriteFound: false,
    hasBtnClose: false,
    hasMcMap: false,
    mcMapSpriteFound: false,
    roomButtons: [],
    roomButtonCount: 0,
  };

  if (swfBytes.length < 8) {
    baseResult.reason = "File is too small to be a SWF";
    return baseResult;
  }

  let data = swfBytes;
  const sig = swfBytes.toString("latin1", 0, 3);
  if (sig === "CWS") {
    try {
      data = Buffer.concat([swfBytes.subarray(0, 8), inflateSync(swfBytes.subarray(8))]);
    } catch {
      baseResult.reason = "Failed to decompress CWS ZLIB stream";
      return baseResult;
    }
  } else if (sig !== "FWS") {
    baseResult.reason = `Unsupported SWF signature '${sig}'`;
    return baseResult;
  }

  // File is a recognized SWF container
  baseResult.recognized = true;

  if (data.length < 13) {
    baseResult.reason = "Truncated SWF header";
    return baseResult;
  }

  const nbits = data[8] >> 3;
  const rectBytes = Math.ceil((5 + nbits * 4) / 8);
  let pos = 8 + rectBytes + 4; // header (8) + RECT + fps (2) + frameCount (2)

  const rootPlaces: PlaceObjectInstance[] = [];
  const sprites = new Map<number, PlaceObjectInstance[]>();

  while (pos + 2 <= data.length) {
    const tagHdr = data.readUInt16LE(pos);
    pos += 2;
    const code = tagHdr >> 6;
    let len = tagHdr & 0x3f;
    if (len === 0x3f) {
      if (pos + 4 > data.length) break;
      len = data.readUInt32LE(pos);
      pos += 4;
    }
    if (pos + len > data.length) break;
    const body = data.subarray(pos, pos + len);
    pos += len;

    if (code === 26 || code === 70) {
      rootPlaces.push(parsePlaceObject(code, body));
    } else if (code === 39) {
      // DefineSprite
      if (body.length < 4) continue;
      const spriteId = body.readUInt16LE(0);
      let subPos = 4;
      const subPlaces: PlaceObjectInstance[] = [];

      while (subPos + 2 <= body.length) {
        const subHdr = body.readUInt16LE(subPos);
        subPos += 2;
        const subCode = subHdr >> 6;
        let subLen = subHdr & 0x3f;
        if (subLen === 0x3f) {
          if (subPos + 4 > body.length) break;
          subLen = body.readUInt32LE(subPos);
          subPos += 4;
        }
        if (subPos + subLen > body.length) break;
        const subBody = body.subarray(subPos, subPos + subLen);
        subPos += subLen;

        if (subCode === 26 || subCode === 70) {
          subPlaces.push(parsePlaceObject(subCode, subBody));
        } else if (subCode === 0) {
          break;
        }
      }
      sprites.set(spriteId, subPlaces);
    } else if (code === 0) {
      break;
    }
  }

  // 1. Root timeline must place an instance named "mlPopup_3"
  let mlPopupCharId: number | null = null;
  for (const p of rootPlaces) {
    if (p.name === "mlPopup_3") {
      mlPopupCharId = p.characterId;
      baseResult.rootMlPopupFound = true;
      break;
    }
  }

  if (!baseResult.rootMlPopupFound || mlPopupCharId === null) {
    baseResult.reason = "Missing root timeline PlaceObject instance named 'mlPopup_3'";
    return baseResult;
  }

  // 2. Lookup mlPopup_3 sprite
  const mlChildren = sprites.get(mlPopupCharId);
  if (!mlChildren) {
    baseResult.reason = `Character ID ${mlPopupCharId} (mlPopup_3) is not a DefineSprite`;
    return baseResult;
  }
  baseResult.mlPopupSpriteFound = true;

  // 3. Inside mlPopup_3: must have "btnClose" and "mcMap"
  let mcMapCharId: number | null = null;
  for (const c of mlChildren) {
    if (c.name === "btnClose") {
      baseResult.hasBtnClose = true;
    } else if (c.name === "mcMap") {
      baseResult.hasMcMap = true;
      mcMapCharId = c.characterId;
    }
  }

  if (!baseResult.hasBtnClose) {
    baseResult.reason = "Missing 'btnClose' child instance in mlPopup_3 sprite";
    return baseResult;
  }
  if (!baseResult.hasMcMap || mcMapCharId === null) {
    baseResult.reason = "Missing 'mcMap' child instance in mlPopup_3 sprite";
    return baseResult;
  }

  // 4. Lookup mcMap sprite
  const mapChildren = sprites.get(mcMapCharId);
  if (!mapChildren) {
    baseResult.reason = `Character ID ${mcMapCharId} (mcMap) is not a DefineSprite`;
    return baseResult;
  }
  baseResult.mcMapSpriteFound = true;

  // 5. Inside mcMap: must have at least one child instance named "btnRoom_<roomId>"
  const rooms: string[] = [];
  for (const c of mapChildren) {
    if (c.name && /^btnRoom_\d+$/i.test(c.name)) {
      rooms.push(c.name);
    }
  }

  baseResult.roomButtons = Array.from(new Set(rooms)).sort();
  baseResult.roomButtonCount = baseResult.roomButtons.length;

  if (baseResult.roomButtonCount === 0) {
    baseResult.reason = "Missing 'btnRoom_<roomId>' room button instances in mcMap sprite";
    return baseResult;
  }

  baseResult.compatible = true;
  baseResult.structurallyCompatible = true;
  baseResult.reason = `Satisfies 2016 MapPopup contract (${baseResult.roomButtonCount} room buttons in mcMap)`;
  return baseResult;
}

/**
 * Public wrapper ensuring compatibility is determined structurally.
 */
export function verifyMapPopupCompatibility(swfBytes: Buffer): {
  compatible: boolean;
  reason: string;
  result?: MapPopupContractResult;
} {
  const result = verifyMapPopupStructuralContract(swfBytes);
  return {
    compatible: result.compatible,
    reason: result.reason,
    result,
  };
}
