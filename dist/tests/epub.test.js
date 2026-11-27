import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EpubBook, EpubError, extractText, resolveHref, } from "../src/epub.js";
import { countErrors, countWarnings, validateEpub } from "../src/validate.js";
import { epub2Buffer, epub3Buffer, epubBrokenSpineBuffer, epubMissingFileBuffer, epubNoContainerBuffer, epubNoTocBuffer, } from "./fixtures.js";
describe("resolveHref", () => {
    test("joins relative hrefs onto the OPF directory and strips fragments", () => {
        assert.equal(resolveHref("OEBPS", "ch1.xhtml"), "OEBPS/ch1.xhtml");
        assert.equal(resolveHref("OEBPS", "ch3.xhtml#section-1"), "OEBPS/ch3.xhtml");
        assert.equal(resolveHref("OEBPS/text", "../ch1.xhtml"), "OEBPS/ch1.xhtml");
        assert.equal(resolveHref("", "mimetype"), "mimetype");
    });
});
describe("extractText", () => {
    test("strips tags, head, script and style; decodes entities", () => {
        const text = extractText(`<html><head><title>Ignore Me</title></head><body><h1>Hi</h1>` +
            `<p>Fish &amp; Chips</p><script>var x = 1;</script>` +
            `<style>p{}</style></body></html>`);
        assert.equal(text, "Hi Fish & Chips");
    });
    test("falls back to tag stripping for malformed markup", () => {
        const text = extractText(`<p>Unclosed <b>bold text`);
        assert.equal(text, "Unclosed bold text");
    });
});
describe("EpubBook — EPUB 2", () => {
    const book = EpubBook.fromBuffer(epub2Buffer());
    test("reads Dublin Core metadata", () => {
        assert.equal(book.metadata.title, "The Test Book");
        assert.deepEqual(book.metadata.creators, ["Jane Example", "John Sample"]);
        assert.equal(book.metadata.language, "en");
        assert.equal(book.metadata.identifier, "urn:isbn:9780000000000");
        assert.equal(book.metadata.publisher, "Example Press");
        assert.equal(book.metadata.date, "2026-01-15");
        assert.deepEqual(book.metadata.subjects, ["Fiction", "Testing"]);
        assert.equal(book.version, "2.0");
        assert.equal(book.opfPath, "OEBPS/content.opf");
    });
    test("parses the NCX table of contents with nesting", () => {
        assert.equal(book.tocSource, "ncx");
        assert.equal(book.toc.length, 2);
        assert.equal(book.toc[0]?.title, "Chapter One");
        assert.equal(book.toc[0]?.href, "ch1.xhtml");
        assert.equal(book.toc[0]?.level, 1);
        assert.equal(book.toc[1]?.title, "Part Two");
        assert.equal(book.toc[1]?.children.length, 1);
        assert.equal(book.toc[1]?.children[0]?.title, "Chapter Three");
        assert.equal(book.toc[1]?.children[0]?.href, "ch3.xhtml#section-1");
        assert.equal(book.toc[1]?.children[0]?.level, 2);
    });
    test("lists spine chapters with TOC titles and word counts", () => {
        const chapters = book.chapters();
        assert.equal(chapters.length, 3);
        assert.deepEqual(chapters.map((c) => [c.href, c.title, c.wordCount]), [
            ["ch1.xhtml", "Chapter One", 19],
            ["ch2.xhtml", "Part Two", 10],
            ["ch3.xhtml", "Chapter Three", 8],
        ]);
        assert.equal(book.totalWords(), 37);
    });
    test("chapterText returns plain text without script/style content", () => {
        const text = book.chapterText("ch2.xhtml");
        assert.match(text, /Pack my box with five dozen liquor jugs/);
        assert.doesNotMatch(text, /this must not appear/);
        assert.doesNotMatch(text, /color: red/);
    });
    test("chapterText returns an empty string for a missing file", () => {
        assert.equal(book.chapterText("nope.xhtml"), "");
    });
    test("mimetype is present, first and stored", () => {
        assert.deepEqual(book.mimetype, { present: true, first: true, stored: true });
    });
    test("a valid book validates cleanly", () => {
        const issues = validateEpub(book);
        assert.deepEqual(issues, []);
    });
});
describe("EpubBook — EPUB 3", () => {
    const book = EpubBook.fromBuffer(epub3Buffer());
    test("reads the nav document as the table of contents", () => {
        assert.equal(book.version, "3.0");
        assert.equal(book.tocSource, "nav");
        assert.equal(book.toc.length, 2);
        assert.equal(book.toc[1]?.title, "Part Two");
        assert.equal(book.toc[1]?.children[0]?.title, "Chapter Three");
        assert.equal(book.metadata.title, "The Test Book");
        assert.equal(book.chapters().length, 3);
    });
    test("a valid EPUB 3 book validates cleanly", () => {
        assert.deepEqual(validateEpub(book), []);
    });
});
describe("EpubBook — broken books", () => {
    test("throws when container.xml is missing", () => {
        assert.throws(() => EpubBook.fromBuffer(epubNoContainerBuffer()), EpubError);
    });
    test("throws when the input is not a ZIP at all", () => {
        assert.throws(() => EpubBook.fromBuffer(Buffer.from("hello world")), EpubError);
    });
    test("validation flags a spine idref missing from the manifest", () => {
        const book = EpubBook.fromBuffer(epubBrokenSpineBuffer());
        const issues = validateEpub(book);
        assert.equal(countErrors(issues), 1);
        assert.equal(issues[0]?.code, "MISSING_SPINE_ITEM");
        assert.equal(countWarnings(issues), 0);
    });
    test("validation flags a manifest href missing from the archive", () => {
        const book = EpubBook.fromBuffer(epubMissingFileBuffer());
        const issues = validateEpub(book);
        assert.equal(countErrors(issues), 1);
        assert.equal(issues[0]?.code, "MISSING_MANIFEST_FILE");
    });
    test("falls back to spine order and warns when no TOC document exists", () => {
        const book = EpubBook.fromBuffer(epubNoTocBuffer());
        assert.equal(book.tocSource, "spine");
        assert.equal(book.toc.length, 3);
        assert.equal(book.toc[0]?.title, "ch1.xhtml");
        const issues = validateEpub(book);
        assert.equal(countErrors(issues), 0);
        assert.equal(countWarnings(issues), 1);
        assert.equal(issues[0]?.code, "MISSING_TOC");
        assert.equal(book.chapters().length, 3);
    });
});
