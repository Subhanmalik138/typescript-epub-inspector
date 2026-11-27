/**
 * Minimal ZIP archive reader.
 *
 * EPUB files are ZIP archives, so this module parses the central directory
 * and extracts entries on demand. Only the two methods an EPUB is allowed
 * to use are supported: stored (0) and deflate (8). No third-party
 * dependencies — decompression is Node's built-in zlib.
 */
import { inflateRawSync } from "node:zlib";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
export class ZipError extends Error {
    constructor(message) {
        super(message);
        this.name = "ZipError";
    }
}
/** CRC-32 (IEEE 802.3) lookup table, built once at module load. */
const CRC_TABLE = (() => {
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
export function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
export class ZipArchive {
    data;
    entries;
    entriesByName = new Map();
    constructor(data, entries) {
        this.data = data;
        this.entries = entries;
        for (const entry of entries) {
            this.entriesByName.set(entry.name, entry);
        }
    }
    static fromBuffer(data) {
        const eocdOffset = findEndOfCentralDirectory(data);
        const totalEntries = data.readUInt16LE(eocdOffset + 10);
        const centralOffset = data.readUInt32LE(eocdOffset + 16);
        const entries = [];
        let offset = centralOffset;
        for (let i = 0; i < totalEntries; i++) {
            if (data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
                throw new ZipError(`central directory entry ${i} at offset ${offset} has a bad signature`);
            }
            const nameLength = data.readUInt16LE(offset + 28);
            const extraLength = data.readUInt16LE(offset + 30);
            const commentLength = data.readUInt16LE(offset + 32);
            entries.push({
                name: data.toString("utf8", offset + 46, offset + 46 + nameLength),
                method: data.readUInt16LE(offset + 10),
                crc: data.readUInt32LE(offset + 16),
                compressedSize: data.readUInt32LE(offset + 20),
                size: data.readUInt32LE(offset + 24),
                localHeaderOffset: data.readUInt32LE(offset + 42),
            });
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return new ZipArchive(data, entries);
    }
    list() {
        return [...this.entries];
    }
    names() {
        return this.entries.map((entry) => entry.name);
    }
    has(name) {
        return this.entriesByName.has(name);
    }
    getEntry(name) {
        return this.entriesByName.get(name);
    }
    /**
     * Extract an entry's contents. Returns undefined when the entry does
     * not exist. Throws ZipError on an unsupported method, a truncated
     * archive, or a CRC mismatch.
     */
    read(name) {
        const entry = this.entriesByName.get(name);
        if (entry === undefined) {
            return undefined;
        }
        const local = entry.localHeaderOffset;
        if (this.data.readUInt32LE(local) !== LOCAL_SIGNATURE) {
            throw new ZipError(`local header for "${name}" has a bad signature`);
        }
        const nameLength = this.data.readUInt16LE(local + 26);
        const extraLength = this.data.readUInt16LE(local + 28);
        const dataStart = local + 30 + nameLength + extraLength;
        const dataEnd = dataStart + entry.compressedSize;
        if (dataEnd > this.data.length) {
            throw new ZipError(`entry "${name}" is truncated`);
        }
        const raw = this.data.subarray(dataStart, dataEnd);
        let decoded;
        if (entry.method === METHOD_STORED) {
            decoded = Buffer.from(raw);
        }
        else if (entry.method === METHOD_DEFLATE) {
            try {
                decoded = inflateRawSync(raw);
            }
            catch {
                throw new ZipError(`entry "${name}" failed to inflate`);
            }
        }
        else {
            throw new ZipError(`entry "${name}" uses unsupported compression method ${entry.method}`);
        }
        if (decoded.length !== entry.size) {
            throw new ZipError(`entry "${name}" has size ${decoded.length}, expected ${entry.size}`);
        }
        if (crc32(decoded) !== entry.crc) {
            throw new ZipError(`entry "${name}" failed its CRC-32 check`);
        }
        return decoded;
    }
}
/**
 * Locate the End of Central Directory record. It sits at the very end of
 * the file, optionally followed by a comment of up to 64 KiB, so scan
 * backwards from the tail.
 */
function findEndOfCentralDirectory(data) {
    const minSize = 22;
    if (data.length < minSize) {
        throw new ZipError("file is too small to be a ZIP archive");
    }
    const scanStart = Math.max(0, data.length - minSize - 65535);
    for (let i = data.length - minSize; i >= scanStart; i--) {
        if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
            return i;
        }
    }
    throw new ZipError("end of central directory record not found");
}
