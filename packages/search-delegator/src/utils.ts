/**
 * Shared utilities for @m4ss/pi-search-delegator.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Atomic file write
// ---------------------------------------------------------------------------

let tempCounter = 0;

/**
 * Atomically write a file by writing to a temp file then renaming.
 * `renameSync` is atomic on POSIX filesystems — a crash mid-write can only
 * leave a stale temp file, never a corrupt target. The temp name includes
 * pid + counter so concurrent writers never share a temp file.
 *
 * @param target  Final file path (directory is created recursively if needed).
 * @param content String content to write.
 */
export function atomicFileWrite(
  target: string,
  content: string,
  encoding: BufferEncoding = "utf8",
): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${tempCounter++}.tmp`;
  writeFileSync(temp, content, encoding);
  renameSync(temp, target);
}
