import { crc32, deflateSync } from "node:zlib";

/**
 * The app's icon, drawn here as a PNG (home screens want PNGs): three columns of a deck on a dark
 * tile, the middle one blue. "maskable" fills the square and keeps the drawing in the middle 80%,
 * for launchers that cut their own shape.
 */

type Rgb = [number, number, number];

const TILE: Rgb = [0x1f, 0x1d, 0x1a];
const LIGHT: Rgb = [0xec, 0xe9, 0xe4];
const BLUE: Rgb = [0x8e, 0xa6, 0xff];

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  color: Rgb;
}

const COLUMNS: Rect[] = [
  { x0: 0.22, y0: 0.38, x1: 0.36, y1: 0.76, r: 0.035, color: LIGHT },
  { x0: 0.43, y0: 0.24, x1: 0.57, y1: 0.76, r: 0.035, color: BLUE },
  { x0: 0.64, y0: 0.46, x1: 0.78, y1: 0.76, r: 0.035, color: LIGHT },
];

/** Inside a rounded rectangle (a signed distance of zero or less). */
function inside(x: number, y: number, s: Rect): boolean {
  const cx = (s.x0 + s.x1) / 2;
  const cy = (s.y0 + s.y1) / 2;
  const qx = Math.abs(x - cx) - ((s.x1 - s.x0) / 2 - s.r);
  const qy = Math.abs(y - cy) - ((s.y1 - s.y0) / 2 - s.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r <= 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** RGBA pixels as a PNG. */
export function png(width: number, height: number, rgba: Buffer): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const cache = new Map<string, Buffer>();

export function icon(size: number, maskable = false): Buffer {
  const key = `${size}${maskable ? "m" : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tile: Rect = maskable ? { x0: -1, y0: -1, x1: 2, y1: 2, r: 0, color: TILE } : { x0: 0, y0: 0, x1: 1, y1: 1, r: 0.22, color: TILE };
  const scale = maskable ? 0.8 : 1;
  const shapes = COLUMNS.map((c) => ({ ...c, x0: 0.5 + (c.x0 - 0.5) * scale, x1: 0.5 + (c.x1 - 0.5) * scale, y0: 0.5 + (c.y0 - 0.5) * scale, y1: 0.5 + (c.y1 - 0.5) * scale, r: c.r * scale }));
  const out = Buffer.alloc(size * size * 4);
  const N = 4; // samples per side, for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (px + (sx + 0.5) / N) / size;
          const y = (py + (sy + 0.5) / N) / size;
          if (!inside(x, y, tile)) continue;
          const c = shapes.find((s) => inside(x, y, s))?.color ?? TILE;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const o = (py * size + px) * 4;
      if (a) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (N * N)) * 255)], o);
    }
  }
  const data = png(size, size, out);
  cache.set(key, data);
  return data;
}
