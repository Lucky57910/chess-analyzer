/**
 * Download the official Stockfish ARM64 build into the Android jniLibs folder.
 *
 * The engine cannot be committed: it is 81 MB, and GitHub refuses files over
 * 100 MB anyway. It also cannot be downloaded by the app at runtime - since API
 * 29 Android will not execute a file from the app's data directory - so it has
 * to be inside the APK before the build. Hence a build step.
 *
 * The name matters. Only files matching `lib*.so` under jniLibs get extracted to
 * nativeLibraryDir and marked executable, which is the one place the app is
 * allowed to exec from.
 *
 * Usage:
 *   node scripts/fetch-engine.mjs              # pinned version, skips if present
 *   node scripts/fetch-engine.mjs --force      # re-download
 *   STOCKFISH_TAG=sf_18 node scripts/fetch-engine.mjs
 *
 * We exec whatever this downloads, so the hash is pinned rather than trusted.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = join(HERE, "..", "android", "app", "src", "main", "jniLibs", "arm64-v8a", "libstockfish.so");

// sf_17.1 rather than the newest sf_18: same engine generation the Python
// backend ran, and 81 MB instead of 115 MB. The whole difference is the
// embedded NNUE net - .text is barely 1 MB either way - so the cost is APK
// size, not strength that matters at the depths this app searches.
const TAG = process.env.STOCKFISH_TAG ?? "sf_17.1";
const VARIANT = process.env.STOCKFISH_VARIANT ?? "android-armv8-dotprod";

// Pinned per (tag, variant). An unknown combination downloads and prints its
// hash so it can be added here; it is never trusted silently.
const KNOWN = {
  "sf_17.1/android-armv8-dotprod": "385293d368837c203b2f1f3d27ce1059680504c27072c96f3227cab1b1a7cfe3",
};

const url = `https://github.com/official-stockfish/Stockfish/releases/download/${TAG}/stockfish-${VARIANT}.tar`;

async function download(target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

/**
 * Walk the 512-byte headers of an uncompressed tar.
 *
 * These releases are plain tars, so this beats pulling in a dependency for a
 * build step. They are not single-file though - sf_17.1 leads with a
 * "Top CPU Contributors.txt" - so callers pick an entry rather than assuming.
 */
async function listEntries(handle) {
  const entries = [];
  const header = Buffer.alloc(512);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(header, 0, 512, offset);
    if (bytesRead < 512 || header.every((byte) => byte === 0)) return entries;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/[\0 ]/g, ""), 8) || 0;
    const type = String.fromCharCode(header[156]);
    offset += 512;
    if (type === "0" || type === "\0") entries.push({ name, size, offset });
    offset += Math.ceil(size / 512) * 512;
  }
}

/** The engine is the archive's largest file by a factor of thousands. */
function pickEngine(entries) {
  const engine = entries.reduce((biggest, entry) => (entry.size > biggest.size ? entry : biggest));
  if (engine.size < 1e6) {
    throw new Error(
      `Largest archive entry is ${engine.name} at ${engine.size} bytes, which is not an engine. ` +
        `Archive held: ${entries.map((e) => e.name).join(", ")}`,
    );
  }
  return engine;
}

async function extractEntry(handle, entry, target) {
  const out = createWriteStream(target);
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1 << 20);
  let offset = entry.offset;
  let remaining = entry.size;
  let magic = null;

  while (remaining > 0) {
    const want = Math.min(remaining, chunk.length);
    const { bytesRead } = await handle.read(chunk, 0, want, offset);
    if (bytesRead <= 0) throw new Error("Truncated archive mid-file");
    const slice = chunk.subarray(0, bytesRead);
    magic ??= Buffer.from(slice.subarray(0, 20));
    hash.update(slice);
    if (!out.write(Buffer.from(slice))) {
      await new Promise((resolve) => out.once("drain", resolve));
    }
    offset += bytesRead;
    remaining -= bytesRead;
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  // This file gets executed on the phone. Confirm it is what it claims to be
  // before it ever reaches an APK.
  if (magic.subarray(0, 4).toString("binary") !== "\x7fELF") {
    throw new Error(`${entry.name} is not an ELF binary`);
  }
  if (magic[4] !== 2) throw new Error(`${entry.name} is not 64-bit`);
  if (magic.readUInt16LE(18) !== 0xb7) {
    throw new Error(`${entry.name} is not aarch64 (e_machine=0x${magic.readUInt16LE(18).toString(16)})`);
  }

  return { size: entry.size, sha256: hash.digest("hex") };
}

async function main() {
  const force = process.argv.includes("--force");
  const key = `${TAG}/${VARIANT}`;

  if (!force) {
    const existing = await stat(DEST).catch(() => null);
    if (existing?.isFile()) {
      console.log(`engine already at ${DEST} (${(existing.size / 1e6).toFixed(1)} MB); --force to replace`);
      return;
    }
  }

  await mkdir(dirname(DEST), { recursive: true });
  const archive = `${DEST}.tar.part`;

  console.log(`fetching ${url}`);
  await download(archive);

  const handle = await open(archive, "r");
  let size;
  let sha256;
  try {
    const entry = pickEngine(await listEntries(handle));
    console.log(`  extracting ${entry.name} (${(entry.size / 1e6).toFixed(1)} MB)`);
    ({ size, sha256 } = await extractEntry(handle, entry, DEST));
  } finally {
    await handle.close();
  }
  await rm(archive, { force: true });

  const expected = KNOWN[key];
  if (expected && sha256 !== expected) {
    await rm(DEST, { force: true });
    throw new Error(
      `sha256 mismatch for ${key}\n  expected ${expected}\n  got      ${sha256}\n` +
        "The binary was removed. This app executes it, so a changed hash is not a warning.",
    );
  }

  console.log(`  -> ${DEST}`);
  console.log(`  ${(size / 1e6).toFixed(1)} MB, sha256 ${sha256}`);
  if (!expected) {
    console.log(`\n  ${key} is not pinned yet. Add to KNOWN in this file:`);
    console.log(`    "${key}": "${sha256}",`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
