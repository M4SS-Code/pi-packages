/**
 * Binary file detection utilities.
 *
 * Reads the first few kilobytes of a file and checks for known magic-byte
 * signatures, supported-image formats, and a UTF-8 / null-byte heuristic.
 */

import { open, stat } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bytes to read upfront for signature matching and heuristic check. */
const SAMPLE_SIZE = 4 * 1024;

/** Max ratio of invalid-UTF8 bytes before we call it binary. */
const MAX_INVALID_UTF8_RATIO = 0.25;

/** Max null bytes in the sample before we call it binary. */
const MAX_NULL_BYTES = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A magic-byte signature that identifies a binary format. */
export interface Signature {
  name: string;
  bytes: Uint8Array;
  offset?: number;
  hint: string;
  /**
   * Extra structural check for magics short enough (or ASCII enough) to
   * appear at the start of legitimate text files ("BM", "MZ", "ID3", …).
   * The signature only matches when this returns true.
   */
  validate?: (bytes: Uint8Array) => boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function le32(bytes: Uint8Array, offset: number): number | undefined {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined)
    return undefined;
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function isHexDigit(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x46) || // A-F
    (byte >= 0x61 && byte <= 0x66) // a-f
  );
}

/** cpio "newc"/"crc" headers store c_ino as 8 ASCII hex chars right after the magic. */
function validCpioHeader(bytes: Uint8Array): boolean {
  for (let i = 6; i < 14; i++) {
    if (!isHexDigit(bytes[i])) return false;
  }
  return true;
}

/** ISO BMFF: the leading 4-byte big-endian box size is small for real `ftyp` boxes. */
function validFtypBoxSize(bytes: Uint8Array): boolean {
  return bytes[0] === 0x00 && bytes[1] === 0x00;
}

/** SWF: plausible version byte and uncompressed length (header is 8 bytes min). */
function validSwfHeader(bytes: Uint8Array): boolean {
  const version = bytes[3];
  if (version === undefined || version < 1 || version > 43) return false;
  const length = le32(bytes, 4);
  return length !== undefined && length >= 9 && length <= 100 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Signatures — grouped by category
// ---------------------------------------------------------------------------

export const SIGNATURES: Signature[] = [
  // — Documents —
  {
    name: "PDF",
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
    hint: "Use pdftotext (poppler-utils) to extract text: `pdftotext <file> -`",
  },
  {
    name: "SQLite database",
    bytes: new Uint8Array([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61,
      0x74, 0x20, 0x33, 0x00,
    ]), // "SQLite format 3\0"
    hint: "Query with sqlite3: `sqlite3 <file> '.dump'` or `sqlite3 <file> 'SELECT * FROM <table>'`",
  },
  // — Archives —
  {
    name: "ZIP / Office document (DOCX, XLSX, PPTX, ODT)",
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
    hint: "Unzip the file: `unzip -p <file> '*.xml'`. If this is an Office document, convert to PDF first then extract text: `libreoffice --headless --convert-to pdf <file> --outdir /tmp/office && pdftotext /tmp/office/$(basename <file .ext>).pdf -`",
  },
  {
    name: "Gzip archive",
    bytes: new Uint8Array([0x1f, 0x8b]),
    hint: "Decompress first: `gzip -dc <file>` or `zcat <file>`",
  },
  {
    name: "Bzip2 archive",
    bytes: new Uint8Array([0x42, 0x5a, 0x68]), // BZh
    // Block-size digit '1'-'9' follows the magic in every real bzip2 stream
    validate: (bytes) => {
      const level = bytes[3];
      return level !== undefined && level >= 0x31 && level <= 0x39;
    },
    hint: "Decompress first: `bzip2 -dc <file>` or `bzcat <file>`",
  },
  {
    name: "XZ archive",
    bytes: new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
    hint: "Decompress first: `xz -dc <file>`",
  },
  {
    name: "Zstd archive",
    bytes: new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),
    hint: "Decompress first: `zstd -dc <file>` or `zstdcat <file>`",
  },
  {
    name: "LZ4 archive",
    bytes: new Uint8Array([0x04, 0x22, 0x4d, 0x18]), // LZ4 frame magic (LE)
    hint: "Decompress first: `lz4 -dc <file>` or `lz4cat <file>`",
  },
  {
    name: "7-Zip archive",
    bytes: new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), // 7z\xbc\xaf\x27\x1c
    hint: "Extract first: `7z x <file> -o/tmp/archive` then read the contents",
  },
  {
    name: "RAR archive",
    bytes: new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]), // Rar!\x1a\x07
    hint: "Extract first: `unrar x <file> /tmp/archive` then read the contents",
  },
  {
    name: "tar archive",
    bytes: new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72]), // "ustar"
    offset: 257,
    hint: "Extract first: `tar xf <file> -C /tmp/archive` then read the contents",
  },
  {
    name: "RPM package",
    bytes: new Uint8Array([0xed, 0xab, 0xee, 0xdb]), // \xed\xab\xee\xdb (magic) + version
    hint: "Extract with `rpm2cpio <file> | cpio -idmv` then read the contents",
  },
  {
    name: "CPIO archive (ASCII)",
    bytes: new Uint8Array([0x30, 0x37, 0x30, 0x37, 0x30, 0x31]), // "070701" new ASCII
    validate: validCpioHeader,
    hint: "Extract with `cpio -idmv < <file>` then read the contents",
  },
  {
    name: "CPIO archive (CRC)",
    bytes: new Uint8Array([0x30, 0x37, 0x30, 0x37, 0x30, 0x32]), // "070702" CRC format
    validate: validCpioHeader,
    hint: "Extract with `cpio -idmv < <file>` then read the contents",
  },
  // — Executables —
  {
    name: "ELF binary",
    bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), // \x7fELF
    hint: "This is a compiled binary — not human-readable as text",
  },
  {
    name: "PE executable (EXE, DLL)",
    bytes: new Uint8Array([0x4d, 0x5a]), // MZ
    // e_cblp (bytes in last page) is <= 511 in real MZ headers; printable
    // text after "MZ" would put an ASCII code (>= 0x20) in the high byte
    validate: (bytes) => {
      const cblpHigh = bytes[3];
      return cblpHigh !== undefined && cblpHigh <= 0x01;
    },
    hint: "This is a Windows executable or DLL — not human-readable as text",
  },
  {
    name: "Java serialized object",
    bytes: new Uint8Array([0xac, 0xed, 0x00, 0x05]),
    hint: "This is a Java serialized stream — not human-readable as text",
  },
  // — Images (unsupported by Pi) —
  {
    name: "AVIF image",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]), // "ftypavif"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "Pi does not render AVIF images — convert to PNG or WebP first: `convert <file> <file.png>`",
  },
  {
    name: "HEIC image",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), // "ftypheic"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "Pi does not render HEIC images — convert to PNG or WebP first: `heif-convert <file> <file.png>` or `magick <file> <file.png>`",
  },
  {
    name: "HEIC image",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x78]), // "ftypheix"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "Pi does not render HEIC images — convert to PNG or WebP first: `heif-convert <file> <file.png>` or `magick <file> <file.png>`",
  },
  {
    name: "HEIC sequence",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x76, 0x63]), // "ftyphevc"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "Pi does not render HEIC sequences — extract a frame or convert with `heif-convert <file> <file.png>`",
  },
  {
    name: "HEIF image",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]), // "ftypmif1"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "Pi does not render HEIF images — convert to PNG or WebP first: `heif-convert <file> <file.png>` or `magick <file> <file.png>`",
  },
  {
    name: "HEIF sequence",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x66, 0x31]), // "ftypmsf1"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "Pi does not render HEIF sequences — extract a frame or convert with `heif-convert <file> <file.png>`",
  },
  {
    name: "BMP image",
    bytes: new Uint8Array([0x42, 0x4d]), // "BM"
    // Reserved dword must be zero and the pixel-data offset sane in real BMPs
    validate: (bytes) => {
      const reserved = le32(bytes, 6);
      const pixelOffset = le32(bytes, 10);
      return (
        reserved === 0 &&
        pixelOffset !== undefined &&
        pixelOffset >= 26 &&
        pixelOffset <= 1024 * 1024
      );
    },
    hint: "Pi does not render BMP images — convert to PNG or WebP first: `convert <file> <file.png>`",
  },
  {
    name: "ICO image",
    bytes: new Uint8Array([0x00, 0x00, 0x01, 0x00]), // 0,0,reserved,type(ICO=1),count
    hint: "Pi does not render ICO images — convert to PNG or WebP first: `convert <file> <file.png>`",
  },
  // — Video —
  {
    name: "MP4 / M4A / MOV video",
    bytes: new Uint8Array([0x66, 0x74, 0x79, 0x70]), // "ftyp"
    offset: 4,
    validate: validFtypBoxSize,
    hint: "This is a video or audio file — extract embedded subtitles with `ffmpeg -i <file> subtitle.srt`, or use a speech-to-text tool to transcribe the audio track",
  },
  {
    name: "Matroska / WebM video",
    bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), // EBML header Element ID
    hint: "This is a video file — extract embedded subtitles with `ffmpeg -i <file> subtitle.srt`, or use a speech-to-text tool to transcribe the audio track",
  },
  {
    name: "AVI video",
    bytes: new Uint8Array([0x41, 0x56, 0x49, 0x20]), // "AVI " at offset 8 (after RIFF header)
    offset: 8,
    validate: (bytes) => asciiAt(bytes, 0, "RIFF"),
    hint: "This is a video file — extract embedded subtitles with `ffmpeg -i <file> subtitle.srt`, or use a speech-to-text tool to transcribe the audio track",
  },
  {
    name: "FLV video",
    bytes: new Uint8Array([0x46, 0x4c, 0x56]), // "FLV"
    // Version byte is 0x01 and the flags byte only uses the audio/video bits
    validate: (bytes) => {
      const flags = bytes[4];
      return (
        bytes[3] === 0x01 && flags !== undefined && (flags & 0xfa) === 0x00
      );
    },
    hint: "This is a video file — extract embedded subtitles with `ffmpeg -i <file> subtitle.srt`, or use a speech-to-text tool to transcribe the audio track",
  },
  {
    name: "MPEG video",
    bytes: new Uint8Array([0x00, 0x00, 0x01, 0xba]), // system stream header
    hint: "This is a video file — extract embedded subtitles with `ffmpeg -i <file> subtitle.srt`, or use a speech-to-text tool to transcribe the audio track",
  },
  {
    name: "SWF (Adobe Flash)",
    bytes: new Uint8Array([0x46, 0x57, 0x53]), // "FWS" uncompressed
    validate: validSwfHeader,
    hint: "This is a Flash SWF file — not human-readable as text",
  },
  {
    name: "SWF (Adobe Flash)",
    bytes: new Uint8Array([0x43, 0x57, 0x53]), // "CWS" compressed (ZLIB)
    validate: validSwfHeader,
    hint: "This is a Flash SWF file — not human-readable as text",
  },
  // — Audio —
  {
    name: "WAV audio",
    bytes: new Uint8Array([0x57, 0x41, 0x56, 0x45]), // "WAVE" at offset 8 (after RIFF header)
    offset: 8,
    validate: (bytes) => asciiAt(bytes, 0, "RIFF"),
    hint: "This is an audio file — use a speech-to-text tool to transcribe the audio",
  },
  {
    name: "OGG audio",
    bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), // "OggS"
    hint: "This is an audio file — use a speech-to-text tool to transcribe the audio",
  },
  {
    name: "FLAC audio",
    bytes: new Uint8Array([0x66, 0x4c, 0x61, 0x43]), // "fLaC"
    hint: "This is an audio file — use a speech-to-text tool to transcribe the audio",
  },
  {
    name: "MP3 audio",
    bytes: new Uint8Array([0x49, 0x44, 0x33]), // "ID3"
    // ID3v2 header: small version byte, then a syncsafe size (high bits clear)
    validate: (bytes) => {
      const version = bytes[3];
      if (version === undefined || version > 0x0a) return false;
      for (let i = 6; i < 10; i++) {
        const b = bytes[i];
        if (b === undefined || b >= 0x80) return false;
      }
      return true;
    },
    hint: "This is an audio file — use a speech-to-text tool to transcribe the audio",
  },
  {
    name: "AIFF audio",
    bytes: new Uint8Array([0x41, 0x49, 0x46, 0x46]), // "AIFF" at offset 8 (after FORM header)
    offset: 8,
    validate: (bytes) => asciiAt(bytes, 0, "FORM"),
    hint: "This is an audio file — use a speech-to-text tool to transcribe the audio",
  },
];

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export async function peekBytes(
  filePath: string,
  size: number,
): Promise<Uint8Array | undefined> {
  let file;
  try {
    file = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } catch {
    return undefined;
  } finally {
    await file.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Signature matching
// ---------------------------------------------------------------------------

export function matchSignature(bytes: Uint8Array): Signature | undefined {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (bytes.length < offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match && (sig.validate === undefined || sig.validate(bytes))) {
      return sig;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Image detection
// ---------------------------------------------------------------------------

export function isSupportedImage(bytes: Uint8Array): boolean {
  // JPEG-LS (byte[3] === 0xf7) is not renderable by Pi TUI — exclude it
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return bytes.length < 4 || bytes[3] !== 0xf7;
  }
  // Signature alone isn't enough — validate IHDR chunk to reject corrupt/empty PNGs
  if (bytes.length >= 29) {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (pngSig.every((b, i) => bytes[i] === b)) {
      // In-bounds: guarded by the length check above
      const ihdrLen =
        (bytes[8]! << 24) | (bytes[9]! << 16) | (bytes[10]! << 8) | bytes[11]!;
      const ihdrType = String.fromCharCode(
        bytes[12]!,
        bytes[13]!,
        bytes[14]!,
        bytes[15]!,
      );
      if (ihdrLen === 13 && ihdrType === "IHDR") return true;
    }
  }
  // GIF: starts with "GIF"
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return true;
  }
  // WebP: "RIFF" at offset 0 + "WEBP" at offset 8
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Binary heuristic
// ---------------------------------------------------------------------------

export function looksBinary(bytes: Uint8Array): boolean {
  // 1 null byte can appear in valid text (e.g. icon fonts); 2+ is the binary signal
  let nullCount = 0;
  for (const b of bytes) {
    if (b === 0) nullCount++;
    if (nullCount > MAX_NULL_BYTES) return true;
  }

  let invalid = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === undefined) break;
    if (b < 0x80) {
      // ASCII
      i++;
      continue;
    }

    let seqLen: number;
    if ((b & 0xe0) === 0xc0) {
      seqLen = 2;
    } else if ((b & 0xf0) === 0xe0) {
      seqLen = 3;
    } else if ((b & 0xf8) === 0xf0) {
      seqLen = 4;
    } else {
      // Continuation byte without lead
      invalid++;
      i++;
      continue;
    }

    // A truncated or malformed sequence counts as one invalid occurrence
    for (let j = 1; j < seqLen; j++) {
      const cont = bytes[i + j];
      if (cont === undefined || (cont & 0xc0) !== 0x80) {
        invalid++;
        break;
      }
    }
    i += seqLen;
  }

  return invalid / bytes.length > MAX_INVALID_UTF8_RATIO;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export { SAMPLE_SIZE };

export async function isBinaryFile(
  filePath: string,
): Promise<Signature | "binary" | undefined> {
  const bytes = await peekBytes(filePath, SAMPLE_SIZE);
  if (!bytes || bytes.length === 0) return undefined;

  // Images are binary but Pi can render them natively — allow through
  if (isSupportedImage(bytes)) return undefined;

  const signature = matchSignature(bytes);
  if (signature) return signature;

  if (looksBinary(bytes)) return "binary";

  return undefined;
}
