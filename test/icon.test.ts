import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { icon } from "../src/icon.ts";

/** A PNG's size and pixels, checking every chunk's CRC on the way. */
function decode(png: Buffer): { width: number; height: number; pixel: (x: number, y: number) => number[] } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    const data = png.subarray(at + 8, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), `${type} CRC`);
    if (type === "IHDR") ((width = data.readUInt32BE(0)), (height = data.readUInt32BE(4)), assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]));
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  assert.equal(rows.length, (width * 4 + 1) * height);
  return { width, height, pixel: (x, y) => [...rows.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 1 + x * 4 + 4)] };
}

describe("the app icon", () => {
  it("is a valid PNG of three columns on a rounded tile, the middle one blue", () => {
    const png = decode(icon(192));
    assert.deepEqual([png.width, png.height], [192, 192]);
    assert.equal(png.pixel(0, 0)[3], 0, "the tile's corner is rounded off");
    assert.deepEqual(png.pixel(96, 120), [0x8e, 0xa6, 0xff, 255], "the middle column");
    assert.deepEqual(png.pixel(96, 20), [0x1f, 0x1d, 0x1a, 255], "the tile");
  });

  it("fills the square when maskable", () => {
    const png = decode(icon(512, true));
    assert.equal(png.pixel(0, 0)[3], 255);
  });
});
