import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Reviewed SVG masters and their native-size PNG renderings are source assets.
// Packaging stays deterministic and does not require a browser or image library.
const brand = path.resolve("build", "desktop", "brand");
const source = JSON.parse(await readFile(path.join(brand, "source.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const svgHash = async (file) => hash((await readFile(file, "utf8")).replace(/\r\n/g, "\n"));
if (source.schemaVersion !== 1 || source.sourceSha256 !== await svgHash("desktop/renderer/favicon.svg") || source.smallSha256 !== await svgHash(path.join(brand, "hive-small.svg"))) throw new Error("HIVE icon masters changed; review and regenerate the native-size PNG source assets.");
const sizes = [16, 24, 32, 48, 64, 128, 256];
if (!Array.isArray(source.images) || source.images.length !== sizes.length) throw new Error("HIVE icon source manifest is incomplete.");
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const images = [];
let offset = header.length;
for (let index = 0; index < sizes.length; index++) {
  const size = sizes[index];
  const entry = source.images[index];
  if (entry.size !== size || entry.file !== `icon-${size}.png`) throw new Error("HIVE icon source size is invalid.");
  const png = await readFile(path.join(brand, entry.file));
  if (hash(png) !== entry.sha256 || png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`HIVE ${size}px icon source is invalid.`);
  const start = 6 + index * 16;
  header[start] = size === 256 ? 0 : size;
  header[start + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(png.length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  images.push(png);
  offset += png.length;
}
const output = path.resolve("build", "desktop", "icon.ico");
await writeFile(output, Buffer.concat([header, ...images]));
console.log(`Generated: ${output} (${sizes.join("/")}px)`);
