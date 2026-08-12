import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export type ArchiveInput = { path: string; bytes: Buffer; executable: boolean };

const BLOCK_SIZE = 512;
const ZERO_BLOCKS = Buffer.alloc(BLOCK_SIZE * 2);

function archiveError(message: string): Error {
  return new Error(`invalid ustar archive: ${message}`);
}

function normalizedPath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) throw archiveError("path is not normalized");
  return path;
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  const segments = path.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) return { name, prefix };
  }
  throw archiveError("path exceeds ustar limits");
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw archiveError("header text field overflows");
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value.toString(8).length > length - 1) throw archiveError("numeric field overflows");
  target.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function headerFor(path: string, byteLength: number, executable: boolean, directory: boolean): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const split = splitUstarPath(path);
  writeText(header, 0, 100, split.name);
  writeOctal(header, 100, 8, directory || executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, directory ? 0 : byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = directory ? "5".charCodeAt(0) : "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 345, 155, split.prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function parentDirectories(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  return [...directories].sort();
}

function normalizeAndSort(entries: readonly ArchiveInput[]): ArchiveInput[] {
  const paths = new Set<string>();
  const normalized = entries.map((entry) => {
    const path = normalizedPath(entry.path);
    if (paths.has(path)) throw archiveError("duplicate path");
    paths.add(path);
    return { path, bytes: entry.bytes, executable: entry.executable };
  });
  if (parentDirectories(normalized.map((entry) => entry.path)).some((directory) => paths.has(directory))) {
    throw archiveError("regular file collides with an implicit parent directory");
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function padding(length: number): Buffer {
  const remainder = length % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

function encodeUstar(entries: readonly ArchiveInput[]): Buffer {
  const blocks: Buffer[] = [];
  for (const directory of parentDirectories(entries.map((entry) => entry.path))) blocks.push(headerFor(directory, 0, true, true));
  for (const entry of entries) blocks.push(headerFor(entry.path, entry.bytes.length, entry.executable, false), entry.bytes, padding(entry.bytes.length));
  blocks.push(ZERO_BLOCKS);
  return Buffer.concat(blocks);
}

export async function writeGzipUstar(entries: readonly ArchiveInput[], destination: string): Promise<void> {
  const tar = encodeUstar(normalizeAndSort(entries));
  await writeFile(destination, gzipSync(tar));
}

function isZeroBlock(buffer: Buffer, offset: number): boolean {
  for (let index = offset; index < offset + BLOCK_SIZE; index += 1) if (buffer[index] !== 0) return false;
  return true;
}

function readText(header: Buffer, offset: number, length: number, field: string): string {
  const fieldBytes = header.subarray(offset, offset + length);
  const terminator = fieldBytes.indexOf(0);
  const content = terminator === -1 ? fieldBytes : fieldBytes.subarray(0, terminator);
  if (terminator !== -1 && fieldBytes.subarray(terminator + 1).some((byte) => byte !== 0)) throw archiveError(`${field} has non-zero padding`);
  const value = content.toString("utf8");
  if (Buffer.from(value, "utf8").compare(content) !== 0) throw archiveError(`${field} is not valid utf8`);
  return value;
}

function readOctal(header: Buffer, offset: number, length: number, field: string): number {
  const fieldBytes = header.subarray(offset, offset + length);
  let end = fieldBytes.findIndex((byte) => byte === 0 || byte === 0x20);
  if (end === -1) end = fieldBytes.length;
  const digits = fieldBytes.subarray(0, end).toString("ascii");
  if (digits.length === 0 || !/^[0-7]+$/.test(digits) || fieldBytes.subarray(end).some((byte) => byte !== 0 && byte !== 0x20)) {
    throw archiveError(`${field} is not octal`);
  }
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) throw archiveError(`${field} is too large`);
  return value;
}

function verifyChecksum(header: Buffer): void {
  const actual = readOctal(header, 148, 8, "checksum");
  let expected = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = header[index];
    if (byte === undefined) throw archiveError("truncated header");
    expected += index >= 148 && index < 156 ? 0x20 : byte;
  }
  if (actual !== expected) throw archiveError("header checksum does not match");
}

export function readGzipUstar(buffer: Buffer): ArchiveInput[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(buffer);
  } catch {
    throw archiveError("gzip data cannot be decoded");
  }
  if (tar.length < ZERO_BLOCKS.length || tar.length % BLOCK_SIZE !== 0) throw archiveError("archive is not block aligned");

  const entries: ArchiveInput[] = [];
  const paths = new Set<string>();
  let offset = 0;
  while (offset < tar.length) {
    if (isZeroBlock(tar, offset)) {
      if (!isZeroBlock(tar, offset + BLOCK_SIZE) || offset + ZERO_BLOCKS.length !== tar.length) throw archiveError("invalid terminating blocks or trailing bytes");
      return entries;
    }
    if (offset + BLOCK_SIZE > tar.length) throw archiveError("truncated header");
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    verifyChecksum(header);
    if (readText(header, 257, 6, "magic") !== "ustar" || readText(header, 263, 2, "version") !== "00") throw archiveError("missing ustar signature");
    const name = readText(header, 0, 100, "name");
    const prefix = readText(header, 345, 155, "prefix");
    const path = normalizedPath(prefix.length === 0 ? name : `${prefix}/${name}`);
    if (paths.has(path)) throw archiveError("duplicate path");
    paths.add(path);
    const mode = readOctal(header, 100, 8, "mode");
    readOctal(header, 108, 8, "uid");
    readOctal(header, 116, 8, "gid");
    const size = readOctal(header, 124, 12, "size");
    readOctal(header, 136, 12, "mtime");
    const type = header[156];
    if (type !== 0 && type !== "0".charCodeAt(0) && type !== "5".charCodeAt(0)) throw archiveError("unsupported type flag");
    if (type === "5".charCodeAt(0)) {
      if (size !== 0) throw archiveError("directory has data");
      offset += BLOCK_SIZE;
      continue;
    }
    const contentOffset = offset + BLOCK_SIZE;
    const end = contentOffset + size;
    if (end > tar.length) throw archiveError("truncated file data");
    entries.push({ path, bytes: Buffer.from(tar.subarray(contentOffset, end)), executable: (mode & 0o111) !== 0 });
    offset = end + (BLOCK_SIZE - (size % BLOCK_SIZE || BLOCK_SIZE));
    if (offset > tar.length) throw archiveError("truncated file padding");
  }
  throw archiveError("missing terminating blocks");
}

async function collectStagedFiles(root: string, relativeRoot = ""): Promise<ArchiveInput[]> {
  const directory = relativeRoot.length === 0 ? root : `${root}${sep}${relativeRoot}`;
  const names = await readdir(directory);
  const files: ArchiveInput[] = [];
  for (const name of names.sort()) {
    const relativePath = relativeRoot.length === 0 ? name : `${relativeRoot}/${name}`;
    const path = `${root}${sep}${relativePath}`;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw archiveError("staging contains a symbolic link");
    if (stat.isDirectory()) {
      files.push(...await collectStagedFiles(root, relativePath));
      continue;
    }
    if (!stat.isFile()) throw archiveError("staging contains a non-regular file");
    files.push({ path: normalizedPath(relativePath), bytes: await readFile(path), executable: (stat.mode & 0o111) !== 0 });
  }
  return files;
}

export async function inspectStagedFiles(stageRoot: string): Promise<ArchiveInput[]> {
  return (await collectStagedFiles(stageRoot)).sort((left, right) => left.path.localeCompare(right.path));
}
