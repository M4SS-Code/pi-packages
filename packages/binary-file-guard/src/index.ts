/**
 * @m4ss/pi-binary-file-guard
 *
 * Pi extension that blocks the `read` tool from reading binary files by
 * detecting magic bytes.
 * Returns a helpful error message suggesting an alternative tool or command
 * for the LLM to use.
 *
 * Images (PNG, JPEG, GIF, WebP) are intentionally allowed through so the LLM can view them directly.
 * Only formats Pi can actually render are permitted — AVIF, HEIC/HEIF, BMP, and ICO are blocked with hints.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { type Signature, isBinaryFile, isDirectory } from "./detector";

function binaryHint(result: Signature | "binary", rawPath: string): string {
  if (result === "binary") {
    return `Cannot read binary file: "${rawPath}". This file appears to be binary data — try a hex viewer, a format-specific tool, or check the file type with the file command. If it is UTF-16 text, convert it first: \`iconv -f UTF-16 -t UTF-8 <file>\`.`;
  }
  return `Cannot read binary file (${result.name}): "${rawPath}". ${result.hint}`;
}

function notifyLabel(result: Signature | "binary", rawPath: string): string {
  return result === "binary"
    ? `Blocked read of binary file: ${rawPath}`
    : `Blocked read of ${result.name}: ${rawPath}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // The type guard narrows event.input to the read tool's typed schema —
    // toolName comparison alone can't (custom tool events overlap it).
    if (!isToolCallEventType("read", event)) return undefined;

    const rawPath = event.input.path;
    if (!rawPath) return undefined;

    // resolve() returns absolute inputs unchanged
    const filePath = resolve(ctx.cwd, rawPath);

    if (await isDirectory(filePath)) return undefined;

    const detection = await isBinaryFile(filePath);
    if (!detection) return undefined;

    if (ctx.hasUI) {
      ctx.ui.notify(notifyLabel(detection, rawPath), "warning");
    }
    return {
      block: true,
      reason: binaryHint(detection, rawPath),
    };
  });
}
