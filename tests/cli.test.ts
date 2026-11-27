import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { epub2Buffer, epubBrokenSpineBuffer } from "./fixtures.js";

const run = promisify(execFile);
// Tests run compiled from dist/tests/, so ../src/cli.js is dist/src/cli.js.
const CLI = new URL("../src/cli.js", import.meta.url).pathname;

async function writeEpub(data: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "epub-inspector-"));
  const path = join(dir, "book.epub");
  await writeFile(path, data);
  return path;
}

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

describe("CLI", () => {
  test("info prints metadata and counts", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["info", path]);
    assert.equal(code, 0);
    assert.match(stdout, /The Test Book/);
    assert.match(stdout, /Jane Example, John Sample/);
    assert.match(stdout, /Chapters:\s+3/);
    assert.match(stdout, /Words:\s+37/);
    assert.match(stdout, /EPUB 2\.0/);
  });

  test("info --json returns structured data", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["info", path, "--json"]);
    assert.equal(code, 0);
    const data = JSON.parse(stdout) as {
      title: string;
      chapters: number;
      totalWords: number;
      tocSource: string;
    };
    assert.equal(data.title, "The Test Book");
    assert.equal(data.chapters, 3);
    assert.equal(data.totalWords, 37);
    assert.equal(data.tocSource, "ncx");
  });

  test("toc prints the nested table of contents", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["toc", path]);
    assert.equal(code, 0);
    assert.match(stdout, /1\s+Chapter One/);
    assert.match(stdout, /2\s+Part Two/);
    assert.match(stdout, /2\.1\s+Chapter Three/);
  });

  test("chapters lists word counts per chapter", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["chapters", path]);
    assert.equal(code, 0);
    assert.match(stdout, /\[0\] ch1\.xhtml — Chapter One \(19 words\)/);
    assert.match(stdout, /\[2\] ch3\.xhtml — Chapter Three \(8 words\)/);
  });

  test("text --chapter prints one chapter without script content", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["text", path, "--chapter", "1"]);
    assert.equal(code, 0);
    assert.match(stdout, /Pack my box with five dozen liquor jugs/);
    assert.doesNotMatch(stdout, /this must not appear/);
  });

  test("text with no --chapter prints the whole book", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["text", path]);
    assert.equal(code, 0);
    assert.match(stdout, /quick brown fox/);
    assert.match(stdout, /vexingly quick daft zebras/);
  });

  test("validate exits 0 for a valid book", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stdout, code } = await runCli(["validate", path]);
    assert.equal(code, 0);
    assert.match(stdout, /valid: no issues found/);
  });

  test("validate exits 2 and names the problem for a broken book", async () => {
    const path = await writeEpub(epubBrokenSpineBuffer());
    const { stdout, code } = await runCli(["validate", path]);
    assert.equal(code, 2);
    assert.match(stdout, /MISSING_SPINE_ITEM/);
  });

  test("a missing file exits 1 with an error", async () => {
    const { stderr, code } = await runCli(["info", "/tmp/does-not-exist.epub"]);
    assert.equal(code, 1);
    assert.match(stderr, /cannot read file/);
  });

  test("an out-of-range --chapter exits 1", async () => {
    const path = await writeEpub(epub2Buffer());
    const { stderr, code } = await runCli(["text", path, "--chapter", "9"]);
    assert.equal(code, 1);
    assert.match(stderr, /chapter 9 does not exist/);
  });

  test("no command prints usage", async () => {
    const { stdout, code } = await runCli([]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage:/);
  });
});
