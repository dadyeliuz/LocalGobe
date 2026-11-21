export const MAX_FRAME_BYTES = 1024 * 1024;

/** Flash SmartFox Socket frames are UTF-8 bytes terminated by a single NUL. */
export function frameText(text: string): Buffer {
  if (text.includes("\0")) throw new Error("frame contains an embedded NUL");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_FRAME_BYTES) throw new Error("frame exceeds 1 MiB");
  return Buffer.concat([bytes, Buffer.from([0])]);
}

export class NulFramer {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    for (let end = this.pending.indexOf(0); end >= 0; end = this.pending.indexOf(0)) {
      if (end > MAX_FRAME_BYTES) throw new Error("frame exceeds 1 MiB");
      frames.push(Buffer.from(this.pending.subarray(0, end)));
      this.pending = this.pending.subarray(end + 1);
    }
    if (this.pending.length > MAX_FRAME_BYTES) throw new Error("frame exceeds 1 MiB");
    return frames;
  }

  get trailingBytes(): number { return this.pending.length; }
  reset(): void { this.pending = Buffer.alloc(0); }
}
