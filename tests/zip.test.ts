import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ZipArchive, ZipError, crc32 } from "../src/zip.js";
import { buildZip } from "./fixtures.js";

describe("crc32", () => {
  test("matches the standard check value for '123456789'", () => {
    assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  });

  test("is 0 for empty input", () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe("ZipArchive", () => {
  test("lists entries and reads stored and deflated files", () => {
    const zip = ZipArchive.fromBuffer(
      buildZip([
        { name: "a.txt", data: "hello", method: 0 },
        { name: "dir/b.txt", data: "world".repeat(100) },
      ]),
    );
    assert.deepEqual(zip.names(), ["a.txt", "dir/b.txt"]);
    assert.equal(zip.read("a.txt")?.toString("utf8"), "hello");
    assert.equal(zip.read("dir/b.txt")?.toString("utf8"), "world".repeat(100));
  });

  test("has() and getEntry() report presence and metadata", () => {
    const zip = ZipArchive.fromBuffer(
      buildZip([{ name: "x.bin", data: Buffer.from([1, 2, 3]), method: 0 }]),
    );
    assert.equal(zip.has("x.bin"), true);
    assert.equal(zip.has("nope.bin"), false);
    assert.equal(zip.getEntry("x.bin")?.method, 0);
    assert.equal(zip.getEntry("x.bin")?.size, 3);
  });

  test("read() returns undefined for a missing entry", () => {
    const zip = ZipArchive.fromBuffer(buildZip([{ name: "a.txt", data: "hi" }]));
    assert.equal(zip.read("missing.txt"), undefined);
  });

  test("rejects data that is not a ZIP archive", () => {
    assert.throws(() => ZipArchive.fromBuffer(Buffer.from("not a zip at all")), ZipError);
    assert.throws(() => ZipArchive.fromBuffer(Buffer.alloc(0)), ZipError);
  });

  test("rejects an entry whose CRC does not match", () => {
    const good = buildZip([{ name: "a.txt", data: "hello", method: 0 }]);
    // Corrupt the stored payload byte inside the local file data.
    const corrupted = Buffer.from(good);
    const payloadOffset = corrupted.indexOf("hello");
    assert.notEqual(payloadOffset, -1);
    corrupted[payloadOffset] = "H".charCodeAt(0);
    const zip = ZipArchive.fromBuffer(corrupted);
    assert.throws(() => zip.read("a.txt"), ZipError);
  });

  test("rejects an archive with a tampered central directory signature", () => {
    const good = buildZip([{ name: "a.txt", data: "hello" }]);
    const corrupted = Buffer.from(good);
    const sigOffset = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(sigOffset, -1);
    corrupted.writeUInt32LE(0xdeadbeef, sigOffset);
    assert.throws(() => ZipArchive.fromBuffer(corrupted), ZipError);
  });
});
