import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
};

export type ZipSafetyLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalExtractBytes: number;
};

export const DEFAULT_ZIP_LIMITS: ZipSafetyLimits = Object.freeze({
  maxEntries: 15_000,
  maxEntryBytes: 64 * 1024 * 1024, // 64 MB per entry
  maxTotalExtractBytes: 256 * 1024 * 1024, // 256 MB total extracted
});

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

// Precomputed IEEE 802.3 CRC-32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function isSafeArchiveEntryPath(entryName: string): boolean {
  if (!entryName || entryName.includes("\0") || entryName.includes("\\")) return false;
  if (entryName.startsWith("/") || /^[A-Za-z]:/.test(entryName)) return false;
  const parts = entryName.split("/");
  return !parts.some((p) => p === ".." || p === ".");
}

export class SafeZipArchive {
  private readonly buffer: Buffer;
  private readonly entriesMap: Map<string, ZipEntry>;
  private readonly limits: ZipSafetyLimits;
  private totalExtracted = 0;

  constructor(buffer: Buffer, limits: ZipSafetyLimits = DEFAULT_ZIP_LIMITS) {
    this.buffer = buffer;
    this.limits = limits;
    this.entriesMap = new Map();
    this.parseCentralDirectory();
  }

  private parseCentralDirectory(): void {
    const buf = this.buffer;
    if (buf.length < 22) {
      throw new Error("Archive is too small to be a valid ZIP/APK file.");
    }

    // Locate End of Central Directory (EOCD)
    const minOffset = Math.max(0, buf.length - 22 - 65535);
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= minOffset; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      throw new Error("Invalid ZIP/APK archive: missing End of Central Directory.");
    }

    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);

    if (totalEntries > this.limits.maxEntries) {
      throw new Error(`Archive exceeds maximum allowed entry count (${this.limits.maxEntries}).`);
    }
    if (cdOffset + cdSize > eocdOffset) {
      throw new Error("Invalid ZIP/APK archive: Central Directory out of bounds.");
    }

    let cursor = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CD_SIG) {
        throw new Error("Invalid ZIP/APK archive: malformed Central Directory entry.");
      }

      const versionMadeBy = buf.readUInt16LE(cursor + 4);
      const compressionMethod = buf.readUInt16LE(cursor + 10);
      const entryCrc = buf.readUInt32LE(cursor + 16);
      const compressedSize = buf.readUInt32LE(cursor + 20);
      const uncompressedSize = buf.readUInt32LE(cursor + 24);
      const nameLen = buf.readUInt16LE(cursor + 28);
      const extraLen = buf.readUInt16LE(cursor + 30);
      const commentLen = buf.readUInt16LE(cursor + 32);
      const externalAttrs = buf.readUInt32LE(cursor + 38);
      const localHeaderOffset = buf.readUInt32LE(cursor + 42);

      const nameStart = cursor + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > buf.length) {
        throw new Error("Invalid ZIP/APK archive: entry name out of bounds.");
      }
      const name = buf.subarray(nameStart, nameEnd).toString("utf8");

      if (!isSafeArchiveEntryPath(name)) {
        throw new Error(`Security violation: unsafe archive path "${name}".`);
      }

      const isDirectory = name.endsWith("/");
      const isUnix = (versionMadeBy >>> 8) === 3;
      const unixMode = (externalAttrs >>> 16) & 0o170000;
      const isSymlink = isUnix && unixMode === 0o120000;
      if (isSymlink) {
        throw new Error(`Security violation: symlink entry "${name}" is not permitted.`);
      }

      this.entriesMap.set(name, {
        name,
        compressionMethod,
        crc32: entryCrc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDirectory,
        isSymlink,
      });

      cursor = nameEnd + extraLen + commentLen;
    }
  }

  listEntries(): ZipEntry[] {
    return Array.from(this.entriesMap.values());
  }

  hasEntry(name: string): boolean {
    return this.entriesMap.has(name);
  }

  readEntry(name: string): Buffer | null {
    const entry = this.entriesMap.get(name);
    if (!entry || entry.isDirectory) return null;

    if (entry.uncompressedSize > this.limits.maxEntryBytes) {
      throw new Error(`Security violation: entry "${name}" exceeds maximum size limit.`);
    }
    if (this.totalExtracted + entry.uncompressedSize > this.limits.maxTotalExtractBytes) {
      throw new Error("Security violation: total archive extraction exceeds size limit.");
    }

    const buf = this.buffer;
    const offset = entry.localHeaderOffset;
    if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== LFH_SIG) {
      throw new Error(`Invalid ZIP/APK archive: malformed local header for "${name}".`);
    }

    const lfhNameLen = buf.readUInt16LE(offset + 26);
    const lfhExtraLen = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`Invalid ZIP/APK archive: compressed data out of bounds for "${name}".`);
    }

    const rawSlice = buf.subarray(dataStart, dataEnd);
    let output: Buffer;
    if (entry.compressionMethod === 0) {
      output = Buffer.from(rawSlice);
    } else if (entry.compressionMethod === 8) {
      output = inflateRawSync(rawSlice, { maxOutputLength: this.limits.maxEntryBytes });
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for "${name}".`);
    }

    if (output.length !== entry.uncompressedSize) {
      throw new Error(`Archive integrity error: size mismatch for "${name}".`);
    }
    if (crc32(output) !== entry.crc32) {
      throw new Error(`Archive integrity error: CRC-32 mismatch for "${name}".`);
    }

    this.totalExtracted += output.length;
    return output;
  }
}
