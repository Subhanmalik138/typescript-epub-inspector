import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { childrenNamed, decodeEntities, descendantsNamed, firstChild, localName, parseXml, textContent, } from "../src/xml.js";
describe("parseXml", () => {
    test("parses elements, attributes and direct text", () => {
        const root = parseXml(`<package version="3.0"><metadata><title lang="en">My Book</title></metadata></package>`);
        assert.equal(root.tag, "package");
        assert.equal(root.attributes["version"], "3.0");
        const title = firstChild(firstChild(root, "metadata"), "title");
        assert.equal(textContent(title), "My Book");
        assert.equal(title.attributes["lang"], "en");
    });
    test("keeps namespace prefixes and localName strips them", () => {
        const root = parseXml(`<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>T</dc:title></metadata></package>`);
        const title = descendantsNamed(root, "title")[0];
        assert.equal(title.tag, "dc:title");
        assert.equal(localName(title.tag), "title");
    });
    test("handles self-closing tags, comments, PIs and CDATA", () => {
        const root = parseXml(`<?xml version="1.0"?><!-- a comment --><root><item id="a"/><item id="b">x<![CDATA[<not a tag>]]>y</item></root>`);
        assert.equal(childrenNamed(root, "item").length, 2);
        assert.equal(childrenNamed(root, "item")[1]?.text, "x<not a tag>y");
    });
    test("decodes entities in text and attributes", () => {
        const root = parseXml(`<root attr="a &amp; b &#65;&#x42;"><child>Fish &amp; Chips &lt;3</child></root>`);
        assert.equal(root.attributes["attr"], "a & b AB");
        assert.equal(textContent(firstChild(root, "child")), "Fish & Chips <3");
        assert.equal(decodeEntities("&quot;hi&quot; &apos;x&apos; &unknown;"), `"hi" 'x' &unknown;`);
    });
    test("skips a DOCTYPE with an internal subset", () => {
        const root = parseXml(`<!DOCTYPE html [ <!ENTITY x "y"> ]><html><body>ok</body></html>`);
        assert.equal(textContent(root), "ok");
    });
    test("tolerates a stray end tag and an unclosed element", () => {
        const root = parseXml(`<root><a>1</a></stray><b>2`);
        assert.equal(textContent(firstChild(root, "a")), "1");
        assert.equal(textContent(firstChild(root, "b")), "2");
    });
    test("throws on an empty document or multiple roots", () => {
        assert.throws(() => parseXml(""), /exactly one root/);
        assert.throws(() => parseXml("<a/><b/>"), /exactly one root/);
    });
    test("textContent concatenates nested text in document order", () => {
        const root = parseXml(`<p>Hello <em>brave</em> new world</p>`);
        assert.equal(textContent(root), "Hello brave new world");
    });
});
