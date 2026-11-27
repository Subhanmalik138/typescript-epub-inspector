# epub-inspector

A zero-dependency CLI for inspecting EPUB 2 and EPUB 3 files: metadata, table of contents, chapter text, word counts, and structural validation. Everything is parsed by hand — the ZIP container reader and the XML parser are both written from scratch in this repo, using only Node's standard library.

## Why

Ebook files are ZIP archives with a small set of XML documents inside (`container.xml`, the OPF package, an NCX or nav table of contents). Most tools for reading them pull in a ZIP library and an XML library; this project shows that the two formats are small enough to implement directly, and that doing so keeps the tool fast, auditable, and dependency-free.

## Install

Requires Node.js 22.6 or later.

```sh
npm install
npm run build
npm link   # optional: puts `epub-inspector` on your PATH
```

## Usage

```sh
# Metadata, structure and word counts
epub-inspector info book.epub

# Table of contents (nested, numbered)
epub-inspector toc book.epub

# Spine chapters with word counts
epub-inspector chapters book.epub

# Plain text of one chapter (0-based, spine order) or the whole book
epub-inspector text book.epub --chapter 1
epub-inspector text book.epub

# Structural validation — exit code 2 when errors are found
epub-inspector validate book.epub
```

Every command accepts `--json` for machine-readable output.

Example `info` output:

```
Title:       The Test Book
Creator:     Jane Example, John Sample
Language:    en
Identifier:  urn:isbn:9780000000000
Version:     EPUB 2.0
OPF:         OEBPS/content.opf
Chapters:    3
Words:       37
TOC:         ncx
```

## Design decisions

- **Hand-rolled ZIP reader (`src/zip.ts`).** The reader walks the central directory, extracts entries on demand, and verifies CRC-32. Only stored and deflate entries are supported — the only two methods an EPUB may use — so an archive using anything else fails loudly instead of silently producing garbage.
- **Forgiving XML parser (`src/xml.ts`).** A strict parser would reject half the EPUBs in the wild over one bad file. This one tolerates stray end tags and unclosed elements, skips DOCTYPE internal subsets, and decodes the five predefined entities plus numeric character references. It keeps text and child elements in document order, so `textContent` returns "Hello *brave* new world" instead of scrambling it.
- **TOC from the right source (`src/epub.ts`).** EPUB 3 books get their table of contents from the nav document; EPUB 2 books from NCX; if neither exists the spine order is used as a flat fallback and validation warns about it. Chapter titles come from the TOC, matched to spine items by resolved href (fragments stripped).
- **Text extraction that ignores the chrome (`src/epub.ts`).** `<head>`, `<script>` and `<style>` content is removed before parsing, so word counts count the book, not its metadata or stylesheets. A chapter that fails to parse as XML falls back to tag stripping rather than failing the whole book.
- **Validation split into errors and warnings (`src/validate.ts`).** A missing manifest file or a spine reference to nowhere is an error; a `mimetype` that is compressed instead of stored is a warning — the book will still open, but it is out of spec.

## Library use

The package also exports the pieces for embedding:

```ts
import { EpubBook, validateEpub } from "typescript-epub-inspector";

const book = EpubBook.fromFile("book.epub");
console.log(book.metadata.title); // "The Test Book"
console.log(book.totalWords()); // 37
console.log(validateEpub(book)); // [] when the book is clean
```

## Tests

```sh
npm test
```

The suite builds EPUB fixtures entirely in memory (an independent ZIP writer in `tests/fixtures.ts`), covering stored/deflate entries, CRC failures, NCX and nav tables of contents, broken spines, missing files, and every CLI command including exit codes.
