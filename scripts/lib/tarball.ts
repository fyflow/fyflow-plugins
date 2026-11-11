// Downloading an artifact, checking its integrity, and unpacking it.
//
// `unpackTgz` is copied from fyflow-app's `packages/server/src/tgz.ts`, the Host's own unpacker, so a tarball CI
// unpacks is one a Host unpacks the same way. Keep it alike with that file.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { MAX_ARTIFACT_BYTES } from "./schema.ts";

/** An artifact that cannot be downloaded or is not what its entry says, and why. */
export class BadArtifact extends Error {}

/** `sha512-<base64>`, as npm writes integrity. */
export const integrityOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * Downloads `url` (https only, redirects too), refusing more than `maxBytes` while it reads, as a Host does.
 */
export async function download(url: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<Uint8Array> {
  if (!url.startsWith("https://")) throw new BadArtifact(`${url} is not https`);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  } catch (error) {
    throw new BadArtifact(`${url} could not be downloaded: ${(error as Error).message}`);
  }
  if (!response.url.startsWith("https://")) throw new BadArtifact(`${url} redirected to ${response.url}, not https`);
  if (!response.ok || response.body === null)
    throw new BadArtifact(`${url} could not be downloaded: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new BadArtifact(`${url} is ${length} bytes, more than the ${maxBytes} a Host takes`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new BadArtifact(`${url} is more than the ${maxBytes} bytes a Host takes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Refuses `bytes` unless their SHA-512 is `integrity`. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const actual = integrityOf(bytes);
  if (actual !== integrity)
    throw new BadArtifact(`its SHA-512 is ${actual}, not the entry's integrity ${integrity}`);
}

// ---- Copied from fyflow-app packages/server/src/tgz.ts (BadArchive is BadArtifact here; it also returns the files) --

const BLOCK = 512;
/**
 * The most an archive may unpack to, and hold: a Plugin, not a dependency tree (and no zip bomb). Twice the largest
 * archive taken (256 MB), so a Plugin with its own binaries fits.
 */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
/** Names Windows reserves for devices, whatever their extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const decoder = new TextDecoder();

/** A header's text field, up to its first NUL. */
const text = (block: Uint8Array, start: number, length: number) =>
  decoder.decode(block.subarray(start, start + length)).replace(/\0.*$/s, "");

function octal(block: Uint8Array, start: number, length: number): number {
  if (((block[start] ?? 0) & 0x80) !== 0) throw new BadArtifact("an entry is too large (base-256 size)");
  const value = text(block, start, length).trim();
  return value === "" ? 0 : Number.parseInt(value, 8);
}

/** Whether a header's checksum (its bytes summed, the checksum field read as spaces) matches. */
function checksumOk(header: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  return sum === octal(header, 148, 8);
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Uint8Array): string | undefined {
  for (const record of decoder.decode(data).split("\n")) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** An entry's path inside the target, `package/` dropped; null for the archive's top folder itself. */
function safePath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^package(\/|$)/, "");
  if (path === "" || path === ".") return null;
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || parts.includes(".."))
    throw new BadArtifact(`an entry would land outside the Plugin: ${raw}`);
  if (parts.some((p) => p.includes(":") || RESERVED.test(p)))
    throw new BadArtifact(`an entry has a name this machine may not hold: ${raw}`);
  return parts.join("/");
}

/**
 * Unpacks a gzipped tar into `dest` (created). Throws BadArtifact for an archive it cannot or will not unpack,
 * including one that would unpack to more than `maxBytes`.
 */
export async function unpackTgz(tgz: Uint8Array, dest: string, maxBytes = MAX_UNPACKED_BYTES): Promise<string[]> {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw new BadArtifact(`it unpacks to more than ${maxBytes} bytes`);
    throw new BadArtifact("it is not a gzipped archive");
  }
  await mkdir(dest, { recursive: true });
  let longName: string | undefined;
  const files: string[] = [];
  let entries = 0;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    if (++entries > MAX_ENTRIES) throw new BadArtifact(`it holds more than ${MAX_ENTRIES} entries`);
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) break; // the end-of-archive blocks
    if (!checksumOk(header)) throw new BadArtifact("it is not a tar archive, or it is damaged");
    const size = octal(header, 124, 12);
    const type = text(header, 156, 1);
    const data = tar.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x" || type === "L") {
      longName = type === "x" ? paxPath(data) : text(data, 0, data.length);
      continue;
    }
    if (type === "g") continue; // global pax header: nothing the Host needs
    const prefix = text(header, 345, 155);
    const name = longName ?? (prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
    longName = undefined;
    if (type === "1" || type === "2")
      throw new BadArtifact(`it holds a link (${name}); a Plugin archive may not`);
    const path = safePath(name);
    if (path === null) continue;
    try {
      if (type === "5") await mkdir(join(dest, path), { recursive: true });
      else if (type === "" || type === "0" || type === "7") {
        await mkdir(dirname(join(dest, path)), { recursive: true });
        await writeFile(join(dest, path), data);
        files.push(path);
      }
    } catch (error) {
      // A file over a folder, or the other way round: two entries that cannot both be.
      throw new BadArtifact(`its entry ${path} clashes with another: ${(error as Error).message}`);
    }
  }
  if (files.length === 0) throw new BadArtifact("it holds no files");
  return files;
}
