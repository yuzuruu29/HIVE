import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

const size = 256;
const output = path.resolve("build", "desktop", "icon.ico");
const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
  const offset = (y * size + x) * 4;
  const rounded = Math.min(x, y, size - 1 - x, size - 1 - y) >= 24 || Math.hypot(Math.max(0, 24 - Math.min(x, size - 1 - x)), Math.max(0, 24 - Math.min(y, size - 1 - y))) <= 24;
  const violet = inHexStroke(x, y, 80, 91) || inHexStroke(x, y, 144, 91) || inHexStroke(x, y, 112, 147);
  const color = violet ? [169, 112, 255, 255] : rounded ? [11, 7, 18, 255] : [0, 0, 0, 0];
  rgba.set(color, offset);
}

const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])), chunk("IDAT", deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header[6] = 0; header[7] = 0; header[8] = 0; header[9] = 0;
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([header, png]));
console.log(output);

function inHexStroke(x, y, cx, cy) {
  const points = [[cx, cy - 31], [cx + 27, cy - 16], [cx + 27, cy + 16], [cx, cy + 31], [cx - 27, cy + 16], [cx - 27, cy - 16]];
  return points.some((point, index) => distanceToSegment(x, y, point, points[(index + 1) % points.length]) <= 6);
}
function distanceToSegment(x, y, [x1, y1], [x2, y2]) { const dx = x2 - x1; const dy = y2 - y1; const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)); }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; }
function chunk(type, data) { const name = Buffer.from(type); return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]); }
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
