import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SAMPLE_SIZE,
  SIGNATURES,
  isBinaryFile,
  isSupportedImage,
  looksBinary,
  matchSignature,
  peekBytes,
} from "./detector";

function bytes(...parts: Array<string | number[] | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) => {
    if (typeof part === "string") return new TextEncoder().encode(part);
    return part instanceof Uint8Array ? part : new Uint8Array(part);
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A minimal PNG head: signature + IHDR length/type (13, "IHDR") + padding. */
function pngHead(): Uint8Array {
  return bytes(
    [0x89],
    "PNG",
    [0x0d, 0x0a, 0x1a, 0x0a],
    [0x00, 0x00, 0x00, 0x0d],
    "IHDR",
    new Uint8Array(13),
  );
}

describe("matchSignature", () => {
  const cases: Array<{ name: string; data: Uint8Array }> = [
    { name: "PDF", data: bytes("%PDF-1.7\n%âãÏÓ") },
    { name: "SQLite database", data: bytes("SQLite format 3\0", [1, 2, 3]) },
    {
      name: "ZIP / Office document (DOCX, XLSX, PPTX, ODT)",
      data: bytes([0x50, 0x4b, 0x03, 0x04], new Uint8Array(16)),
    },
    {
      name: "Gzip archive",
      data: bytes([0x1f, 0x8b, 0x08], new Uint8Array(8)),
    },
    { name: "Bzip2 archive", data: bytes("BZh9", [0x31, 0x41, 0x59]) },
    {
      name: "XZ archive",
      data: bytes([0xfd], "7zXZ", [0x00, 0x00]),
    },
    { name: "Zstd archive", data: bytes([0x28, 0xb5, 0x2f, 0xfd], [1]) },
    { name: "LZ4 archive", data: bytes([0x04, 0x22, 0x4d, 0x18], [1]) },
    { name: "7-Zip archive", data: bytes("7z", [0xbc, 0xaf, 0x27, 0x1c]) },
    { name: "RAR archive", data: bytes("Rar!", [0x1a, 0x07, 0x00]) },
    {
      name: "tar archive",
      data: bytes(new Uint8Array(257), "ustar", [0x00]),
    },
    { name: "RPM package", data: bytes([0xed, 0xab, 0xee, 0xdb, 3, 0]) },
    { name: "CPIO archive (ASCII)", data: bytes("07070100AB12CD") },
    { name: "CPIO archive (CRC)", data: bytes("0707020099ffee11") },
    { name: "ELF binary", data: bytes([0x7f], "ELF", [2, 1, 1]) },
    {
      name: "PE executable (EXE, DLL)",
      data: bytes("MZ", [0x90, 0x00, 3, 0, 0, 0]),
    },
    { name: "Java serialized object", data: bytes([0xac, 0xed, 0x00, 0x05]) },
    {
      name: "AVIF image",
      data: bytes([0x00, 0x00, 0x00, 0x1c], "ftypavif"),
    },
    { name: "HEIC image", data: bytes([0x00, 0x00, 0x00, 0x18], "ftypheic") },
    {
      name: "HEIC sequence",
      data: bytes([0x00, 0x00, 0x00, 0x18], "ftyphevc"),
    },
    { name: "HEIF image", data: bytes([0x00, 0x00, 0x00, 0x18], "ftypmif1") },
    {
      name: "HEIF sequence",
      data: bytes([0x00, 0x00, 0x00, 0x18], "ftypmsf1"),
    },
    {
      name: "BMP image",
      data: bytes("BM", [0, 1, 0, 0], [0, 0, 0, 0], [54, 0, 0, 0]),
    },
    { name: "ICO image", data: bytes([0x00, 0x00, 0x01, 0x00, 1, 0]) },
    {
      name: "MP4 / M4A / MOV video",
      data: bytes([0x00, 0x00, 0x00, 0x20], "ftypisom"),
    },
    {
      name: "Matroska / WebM video",
      data: bytes([0x1a, 0x45, 0xdf, 0xa3], [1]),
    },
    { name: "AVI video", data: bytes("RIFF", [1, 2, 3, 4], "AVI ") },
    {
      name: "FLV video",
      data: bytes("FLV", [0x01, 0x05, 0, 0, 0, 9]),
    },
    { name: "MPEG video", data: bytes([0x00, 0x00, 0x01, 0xba], [0x44]) },
    {
      name: "SWF (Adobe Flash)",
      data: bytes("FWS", [0x0a], [0xe8, 0x03, 0x00, 0x00]),
    },
    { name: "WAV audio", data: bytes("RIFF", [1, 2, 3, 4], "WAVE") },
    { name: "OGG audio", data: bytes("OggS", [0]) },
    { name: "FLAC audio", data: bytes("fLaC", [0]) },
    {
      name: "MP3 audio",
      data: bytes("ID3", [0x04, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01]),
    },
    { name: "AIFF audio", data: bytes("FORM", [1, 2, 3, 4], "AIFF") },
  ];

  for (const { name, data } of cases) {
    it(`detects ${name}`, () => {
      assert.equal(matchSignature(data)?.name, name);
    });
  }

  it("covers every implemented signature name", () => {
    const tested = new Set(cases.map((c) => c.name));
    for (const sig of SIGNATURES) {
      assert.ok(tested.has(sig.name), `no test case for ${sig.name}`);
    }
  });

  const falsePositives: Array<{ label: string; data: Uint8Array }> = [
    // validate() refinements must reject text that shares the magic
    { label: "text starting with MZ", data: bytes("MZ is a designation") },
    { label: "text starting with ID3", data: bytes("ID3 is a tag format") },
    { label: "text starting with FLV", data: bytes("FLV file format doc") },
    { label: "text starting with FWS", data: bytes("FWS stands for...") },
    { label: "text starting with BM", data: bytes("BM25 ranking notes") },
    { label: "bzip2 magic without level", data: bytes("BZhX not a stream") },
    {
      label: "cpio magic without hex header",
      data: bytes("070701 is a magic"),
    },
  ];

  for (const { label, data } of falsePositives) {
    it(`does not match ${label}`, () => {
      assert.equal(matchSignature(data), undefined);
    });
  }
});

describe("isSupportedImage", () => {
  it("accepts JPEG", () => {
    assert.ok(isSupportedImage(bytes([0xff, 0xd8, 0xff, 0xe0])));
  });
  it("rejects JPEG-LS", () => {
    assert.ok(!isSupportedImage(bytes([0xff, 0xd8, 0xff, 0xf7])));
  });
  it("accepts PNG with a valid IHDR", () => {
    assert.ok(isSupportedImage(pngHead()));
  });
  it("rejects PNG with a corrupt IHDR", () => {
    const corrupt = pngHead();
    corrupt[12] = 0x58; // "XHDR"
    assert.ok(!isSupportedImage(corrupt));
  });
  it("accepts GIF", () => {
    assert.ok(isSupportedImage(bytes("GIF89a")));
  });
  it("accepts WebP", () => {
    assert.ok(isSupportedImage(bytes("RIFF", [1, 2, 3, 4], "WEBP")));
  });
});

describe("looksBinary", () => {
  it("accepts plain ASCII", () => {
    assert.ok(!looksBinary(bytes("hello world\nsecond line\n")));
  });
  it("accepts multi-byte UTF-8", () => {
    assert.ok(!looksBinary(bytes("héllo wörld — ünïcode ✓")));
  });
  it("accepts latin-1 text with a few high bytes", () => {
    assert.ok(
      !looksBinary(
        bytes("caf", [0xe9], " au lait, d", [0xe9], "j", [0xe0], " vu"),
      ),
    );
  });
  it("flags UTF-16LE text via its null bytes", () => {
    const utf16 = new Uint8Array(Buffer.from("hello", "utf16le"));
    assert.ok(looksBinary(utf16));
  });
  it("flags random binary", () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 129) % 256;
    assert.ok(looksBinary(data));
  });
});

describe("isBinaryFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "binary-file-guard-test-"));

  it("flags a PDF file with its signature", async () => {
    const path = join(dir, "doc.pdf");
    writeFileSync(path, "%PDF-1.7 rest of file");
    const result = await isBinaryFile(path);
    assert.equal(typeof result, "object");
    assert.equal((result as { name: string }).name, "PDF");
  });

  it("lets text files through", async () => {
    const path = join(dir, "notes.txt");
    writeFileSync(path, "just some notes\n");
    assert.equal(await isBinaryFile(path), undefined);
  });

  it("lets supported images through", async () => {
    const path = join(dir, "img.png");
    writeFileSync(path, pngHead());
    assert.equal(await isBinaryFile(path), undefined);
  });

  it("flags unknown binary via the heuristic", async () => {
    const path = join(dir, "blob.bin");
    const data = new Uint8Array(512);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 130) % 256;
    writeFileSync(path, data);
    assert.equal(await isBinaryFile(path), "binary");
  });

  it("ignores empty and missing files", async () => {
    const path = join(dir, "empty");
    writeFileSync(path, "");
    assert.equal(await isBinaryFile(path), undefined);
    assert.equal(await isBinaryFile(join(dir, "missing")), undefined);
    assert.equal(await peekBytes(join(dir, "missing"), SAMPLE_SIZE), undefined);
  });
});
