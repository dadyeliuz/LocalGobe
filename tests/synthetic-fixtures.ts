import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/importer/zip-reader.ts";
import { APK_REQUIRED_ASSETS_20160725 } from "../src/builds/20160725-android-1.4.7/apk-assets.ts";

/** Creates a minimal syntactically valid synthetic SWF buffer (never copyrighted). */
export function makeSyntheticSwf(label = "synthetic"): Buffer {
  const payload = Buffer.from(label, "utf8");
  const totalLen = 8 + payload.length;
  const header = Buffer.alloc(8);
  header.write("FWS", 0, "ascii");
  header[3] = 14;
  header.writeUInt32LE(totalLen, 4);
  return Buffer.concat([header, payload]);
}

/** Creates a minimal synthetic MP3 buffer with ID3 header (never copyrighted). */
export function makeSyntheticMp3(label = "audio"): Buffer {
  return Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "binary"), Buffer.from(label, "utf8")]);
}

export type SyntheticZipEntry = {
  name: string;
  data: Buffer;
  compress?: boolean;
  isSymlink?: boolean;
};

/** Builds a valid ZIP/APK archive buffer in memory for testing. */
export function buildSyntheticZip(entries: readonly SyntheticZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const uncompressed = entry.data;
    const compressed = entry.compress ? deflateRawSync(uncompressed) : uncompressed;
    const method = entry.compress ? 8 : 0;
    const entryCrc = crc32(uncompressed);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(entryCrc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(uncompressed.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(entry.isSymlink ? (3 << 8) | 20 : 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(entryCrc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(uncompressed.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(entry.isSymlink ? (0o120777 << 16) >>> 0 : 0, 38);
    cd.writeUInt32LE(offset, 42);

    centralParts.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + compressed.length;
  }

  const cdBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

/** Builds a synthetic Mogobe Android 1.4.7 APK with all whitelisted required entries + non-whitelisted Android junk. */
export function buildSyntheticSupportedApk(extraEntries: readonly SyntheticZipEntry[] = []): Buffer {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<application xmlns="http://ns.adobe.com/air/application/21.0">
  <id>air.mogobe.mogoTab.IL</id>
  <versionNumber>1.4.7</versionNumber>
  <initialWindow><content>MogobeTabIL.swf</content></initialWindow>
</application>`;

  const entries: SyntheticZipEntry[] = [
    // Non-whitelisted Android files that MUST NOT be extracted
    { name: "classes.dex", data: Buffer.from("synthetic-dex"), compress: true },
    { name: "lib/armeabi-v7a/libCore.so", data: Buffer.from("synthetic-so") },
    { name: "res/drawable/icon.png", data: Buffer.from("synthetic-png") },
    // Whitelisted optional popup SWF
    { name: "assets/Swf/Assets/Popups/p_3.swf", data: makeSyntheticSwf("popup-3"), compress: true },
  ];

  for (const spec of APK_REQUIRED_ASSETS_20160725) {
    if (spec.apkPath.endsWith("application.xml")) {
      entries.push({ name: spec.apkPath, data: Buffer.from(xml, "utf8"), compress: true });
    } else {
      entries.push({ name: spec.apkPath, data: makeSyntheticSwf(spec.logicalId), compress: true });
    }
  }

  entries.push(...extraEntries);
  return buildSyntheticZip(entries);
}

/** Creates a minimal synthetic Mogobe language XML buffer (never copyrighted). */
export function makeSyntheticLanguageXml(opts: {
  compatible?: boolean;
  sections?: string[];
  lastUpdate?: string;
  languageId?: number;
} = {}): Buffer {
  let sections: readonly string[];
  if (opts.sections) {
    sections = opts.sections;
  } else if (opts.compatible === false) {
    sections = [];
  } else {
    sections = ["Login", "General", "Errors", "RoomsNames", "worldMap", "Chat"];
  }

  const lastUpdate = opts.lastUpdate ?? "2016-07-25 12:00:00 PM";
  const langId = opts.languageId ?? 1;

  const secXml = sections
    .map(
      (s) =>
        `<Section name="${s}"><M id="1" msg="Synth_${s}_1"/><M id="2" msg="Synth_${s}_2"/></Section>`,
    )
    .join("");

  const xml = opts.compatible === false
    ? `<?xml version="1.0" encoding="utf-8"?><CorruptDocument />`
    : `<?xml version="1.0" encoding="utf-8"?><Lang Language="${langId}" lastUpdate="${lastUpdate}"><Sections>${secXml}</Sections></Lang>`;
  return Buffer.from(xml, "utf8");
}

export interface SyntheticMapPopupOptions {
  includeRootPopup?: boolean;
  includeBtnClose?: boolean;
  includeMcMap?: boolean;
  rooms?: string[];
  stringOnlyPopup?: boolean;
  stringOnlyBtnRoom?: boolean;
}

function buildSwfTag(code: number, body: Buffer): Buffer {
  if (body.length < 63) {
    const hdr = Buffer.alloc(2);
    hdr.writeUInt16LE((code << 6) | body.length, 0);
    return Buffer.concat([hdr, body]);
  } else {
    const hdr = Buffer.alloc(6);
    hdr.writeUInt16LE((code << 6) | 63, 0);
    hdr.writeUInt32LE(body.length, 2);
    return Buffer.concat([hdr, body]);
  }
}

function buildSwfPlaceObject2(depth: number, charId: number, name: string): Buffer {
  const nameBuf = Buffer.concat([Buffer.from(name, "latin1"), Buffer.from([0])]);
  const body = Buffer.alloc(5 + nameBuf.length);
  body.writeUInt8(0x22, 0); // HasCharacter (0x02) | HasName (0x20)
  body.writeUInt16LE(depth, 1);
  body.writeUInt16LE(charId, 3);
  nameBuf.copy(body, 5);
  return buildSwfTag(26, body);
}

function buildSwfSprite(spriteId: number, childTags: Buffer[]): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(spriteId, 0);
  header.writeUInt16LE(1, 2); // 1 frame
  const endTag = Buffer.from([0, 0]);
  const body = Buffer.concat([header, ...childTags, endTag]);
  return buildSwfTag(39, body);
}

/**
 * Creates a minimal valid synthetic SWF for structural MapPopup testing.
 * Uses real SWF tags (DefineSprite, PlaceObject2) rather than raw string injection.
 */
export function makeSyntheticMapPopupSwf(opts: SyntheticMapPopupOptions = {}): Buffer {
  const includeRootPopup = opts.includeRootPopup ?? true;
  const includeBtnClose = opts.includeBtnClose ?? true;
  const includeMcMap = opts.includeMcMap ?? true;
  const rooms = opts.rooms ?? ["btnRoom_20", "btnRoom_110", "btnRoom_70"];
  const stringOnlyPopup = opts.stringOnlyPopup ?? false;
  const stringOnlyBtnRoom = opts.stringOnlyBtnRoom ?? false;

  const tagList: Buffer[] = [];

  // 1. mcMap sprite (ID 100)
  if (includeMcMap) {
    const mapChildTags: Buffer[] = [];
    if (!stringOnlyBtnRoom) {
      let d = 1;
      for (const r of rooms) {
        mapChildTags.push(buildSwfPlaceObject2(d++, 10, r));
      }
    }
    tagList.push(buildSwfSprite(100, mapChildTags));
  }

  // 2. mlPopup_3 sprite (ID 200)
  if (includeRootPopup) {
    const mlChildTags: Buffer[] = [];
    if (includeBtnClose) {
      mlChildTags.push(buildSwfPlaceObject2(1, 11, "btnClose"));
    }
    if (includeMcMap) {
      mlChildTags.push(buildSwfPlaceObject2(2, 100, "mcMap"));
    }
    tagList.push(buildSwfSprite(200, mlChildTags));
  }

  // 3. Root timeline PlaceObject2 for mlPopup_3
  if (includeRootPopup && !stringOnlyPopup) {
    tagList.push(buildSwfPlaceObject2(1, 200, "mlPopup_3"));
  }

  // ShowFrame (code 1, len 0) and End (code 0)
  const showFrame = Buffer.alloc(2);
  showFrame.writeUInt16LE((1 << 6) | 0, 0);
  tagList.push(showFrame);
  tagList.push(Buffer.from([0, 0]));

  const tagsBuf = Buffer.concat(tagList);
  let stringPayload = Buffer.alloc(0);
  if (stringOnlyPopup) {
    stringPayload = Buffer.concat([stringPayload, Buffer.from("...mlPopup_3...", "latin1")]);
  }
  if (stringOnlyBtnRoom) {
    stringPayload = Buffer.concat([stringPayload, Buffer.from("...btnRoom_20...", "latin1")]);
  }

  const allPayload = Buffer.concat([tagsBuf, stringPayload]);

  const rect = Buffer.from([0x00]); // 1 byte rect (nbits = 0)
  const fpsAndFrames = Buffer.alloc(4);
  fpsAndFrames.writeUInt16LE(24, 0);
  fpsAndFrames.writeUInt16LE(1, 2);

  const fileLen = 8 + rect.length + fpsAndFrames.length + allPayload.length;
  const header = Buffer.alloc(8);
  header.write("FWS", 0, "ascii");
  header.writeUInt8(17, 3);
  header.writeUInt32LE(fileLen, 4);

  return Buffer.concat([header, rect, fpsAndFrames, allPayload]);
}

/** Creates a minimal syntactically valid synthetic Mogobe chat XML (never copyrighted). */
export function makeSyntheticChatXml(opts?: { languageId?: number; withHebrew?: boolean }): Buffer {
  const langId = opts?.languageId ?? 1;
  const isHeb = opts?.withHebrew ?? (langId === 1);
  const msg1 = isHeb ? "שלום" : "Hello";
  const msg2 = isHeb ? "ביי" : "Bye";
  const cat1 = isHeb ? "ברכות" : "Greetings";
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Lang>
  <chat>
    <ms id="1000" title="${cat1}" txt="">
      <m id="1010" title="" txt="${msg1}" />
      <m id="1020" title="" txt="${msg2}" />
      <ms id="1030" title="More" txt="">
        <m id="1040" title="" txt="${msg1} 2" />
      </ms>
    </ms>
  </chat>
</Lang>`;
  return Buffer.from(xml, "utf8");
}

export const SPRING_2013_TEST_ITEM_IDS = [
  109, 110, 681, 989, 374, 571, 329, 2031, 2291, 535,
] as const;

export function createSpring2013TestInventory(userId: number) {
  return SPRING_2013_TEST_ITEM_IDS.map((typeId, idx) => ({
    id: userId * 10000 + 100 + idx,
    typeId,
    sts: 0,
    sCat: 1,
    pCat: 3,
    mType: 1,
    src: 1,
    inStock: true,
    s: 0,
    trd: 1,
    locked: false,
  }));
}

export function isTestFixtureInventory(inventory: Array<{ id: number }>, userId: number): boolean {
  if (inventory.length === 0) return false;
  return inventory.every(
    (item) => item.id >= userId * 10000 + 100 && item.id < userId * 10000 + 200,
  );
}

export const SPRING_2013_STORE_CATEGORIES = [
  { typeId: 1, name: "Clothing" },
];

export const SPRING_2013_STORE_CATALOG = [
  { id: 10001, typeId: 109, sCat: 1, pCat: 3, price: 100, inStock: true, locked: false, sts: 0, src: 1, s: 0, trd: 1, mType: 1 },
  { id: 10002, typeId: 110, sCat: 1, pCat: 3, price: 120, inStock: true, locked: false, sts: 0, src: 1, s: 0, trd: 1, mType: 1 },
];


