/**
 * Test helpers: build minimal but valid EPUB 2 / EPUB 3 files entirely in
 * memory, so the tests never depend on a fixture file on disk.
 *
 * The ZIP writer is deliberately independent of `src/zip.ts` — it is the
 * *producer* side (local headers + central directory + EOCD) while the
 * module under test is the *consumer* side, so a shared bug cannot hide.
 */

import { deflateRawSync } from "node:zlib";

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInputEntry {
  name: string;
  data: string | Buffer;
  /** 0 = stored, 8 = deflate. Defaults to 8. */
  method?: 0 | 8;
}

export function buildZip(entries: ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const name = Buffer.from(entry.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CHAPTER_1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head>
<body><h1>Chapter One</h1><p>The quick brown fox jumps over the lazy dog.</p>
<p>Second paragraph with <em>emphasis</em> and an &amp; entity.</p></body></html>`;

const CHAPTER_2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter Two</title></head>
<body><h1>Chapter Two</h1><p>Pack my box with five dozen liquor jugs.</p>
<script>var secret = "this must not appear";</script>
<style>p { color: red; }</style></body></html>`;

const CHAPTER_3 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter Three</title></head>
<body><h1>Chapter Three</h1><p>How vexingly quick daft zebras jump!</p></body></html>`;

const OPF_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test Book</dc:title>
    <dc:creator>Jane Example</dc:creator>
    <dc:creator>John Sample</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="book-id">urn:isbn:9780000000000</dc:identifier>
    <dc:publisher>Example Press</dc:publisher>
    <dc:date>2026-01-15</dc:date>
    <dc:description>A tiny book built for tests.</dc:description>
    <dc:subject>Fiction</dc:subject>
    <dc:subject>Testing</dc:subject>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3" linear="no"/>
  </spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:isbn:9780000000000"/></head>
  <docTitle><text>The Test Book</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>Part Two</text></navLabel>
      <content src="ch2.xhtml"/>
      <navPoint id="np2a" playOrder="3">
        <navLabel><text>Chapter Three</text></navLabel>
        <content src="ch3.xhtml#section-1"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`;

const NAV_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Chapter One</a></li>
  <li><a href="ch2.xhtml">Part Two</a><ol>
    <li><a href="ch3.xhtml">Chapter Three</a></li>
  </ol></li>
</ol></nav></body></html>`;

const OPF_V3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test Book</dc:title>
    <dc:creator>Jane Example</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="book-id">urn:isbn:9780000000000</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

/** A complete, valid EPUB 2 book with three chapters and a nested NCX TOC. */
export function epub2Buffer(): Buffer {
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    { name: "OEBPS/content.opf", data: OPF_V2 },
    { name: "OEBPS/toc.ncx", data: NCX },
    { name: "OEBPS/ch1.xhtml", data: CHAPTER_1 },
    { name: "OEBPS/ch2.xhtml", data: CHAPTER_2 },
    { name: "OEBPS/ch3.xhtml", data: CHAPTER_3 },
  ]);
}

/** A complete, valid EPUB 3 book with a nav-document TOC. */
export function epub3Buffer(): Buffer {
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    { name: "OEBPS/content.opf", data: OPF_V3 },
    { name: "OEBPS/nav.xhtml", data: NAV_XHTML },
    { name: "OEBPS/ch1.xhtml", data: CHAPTER_1 },
    { name: "OEBPS/ch2.xhtml", data: CHAPTER_2 },
    { name: "OEBPS/ch3.xhtml", data: CHAPTER_3 },
  ]);
}

/** EPUB 2 with the spine pointing at a manifest id that does not exist. */
export function epubBrokenSpineBuffer(): Buffer {
  const brokenOpf = OPF_V2.replace(
    '<itemref idref="ch3" linear="no"/>',
    '<itemref idref="missing-chapter"/>',
  );
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    { name: "OEBPS/content.opf", data: brokenOpf },
    { name: "OEBPS/toc.ncx", data: NCX },
    { name: "OEBPS/ch1.xhtml", data: CHAPTER_1 },
    { name: "OEBPS/ch2.xhtml", data: CHAPTER_2 },
    { name: "OEBPS/ch3.xhtml", data: CHAPTER_3 },
  ]);
}

/** EPUB 2 whose manifest lists a file that is not in the archive. */
export function epubMissingFileBuffer(): Buffer {
  const brokenOpf = OPF_V2.replace(
    '<item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>',
    '<item id="ch3" href="ch3-missing.xhtml" media-type="application/xhtml+xml"/>',
  );
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    { name: "OEBPS/content.opf", data: brokenOpf },
    { name: "OEBPS/toc.ncx", data: NCX },
    { name: "OEBPS/ch1.xhtml", data: CHAPTER_1 },
    { name: "OEBPS/ch2.xhtml", data: CHAPTER_2 },
    { name: "OEBPS/ch3.xhtml", data: CHAPTER_3 },
  ]);
}

/** A ZIP with no container.xml at all. */
export function epubNoContainerBuffer(): Buffer {
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "OEBPS/content.opf", data: OPF_V2 },
  ]);
}

/** A valid EPUB 3 book with no nav document — TOC falls back to spine order. */
export function epubNoTocBuffer(): Buffer {
  const opfNoNav = OPF_V3.replace(
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n`,
    "",
  );
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    { name: "OEBPS/content.opf", data: opfNoNav },
    { name: "OEBPS/ch1.xhtml", data: CHAPTER_1 },
    { name: "OEBPS/ch2.xhtml", data: CHAPTER_2 },
    { name: "OEBPS/ch3.xhtml", data: CHAPTER_3 },
  ]);
}
