#!/usr/bin/env node
/**
 * epub-inspector — inspect EPUB 2 / EPUB 3 files from the terminal.
 *
 *   epub-inspector info <file> [--json]        metadata + structure summary
 *   epub-inspector toc <file> [--json]         table of contents
 *   epub-inspector chapters <file> [--json]    spine chapters + word counts
 *   epub-inspector text <file> [--chapter N] [--json]
 *                                              plain text of a chapter (or the whole book)
 *   epub-inspector validate <file> [--json]    structural checks; exit 2 on errors
 */

import { EpubBook, EpubError } from "./epub.js";
import { countErrors, countWarnings, validateEpub } from "./validate.js";

const VERSION = "1.0.0";

type Command = "info" | "toc" | "chapters" | "text" | "validate";

interface Options {
  file?: string;
  json: boolean;
  chapter?: number;
}

function usage(): string {
  return `epub-inspector ${VERSION} — inspect EPUB 2 and EPUB 3 files

Usage:
  epub-inspector info <file> [--json]
  epub-inspector toc <file> [--json]
  epub-inspector chapters <file> [--json]
  epub-inspector text <file> [--chapter N] [--json]
  epub-inspector validate <file> [--json]

Commands:
  info       Show metadata, spine size, word count and structure
  toc        Print the table of contents (nested, numbered)
  chapters   List spine chapters with word counts
  text       Print a chapter as plain text (or the whole book with no --chapter)
  validate   Check the container, manifest, spine, TOC and metadata

Options:
  --json        Machine-readable JSON output
  --chapter N   Chapter index for "text" (0-based, spine order)
  --help, -h    Show this help
  --version     Show the version`;
}

function parseArgs(argv: string[]): { command: Command | undefined; options: Options } {
  const options: Options = { json: false };
  const positional: string[] = [];
  let command: Command | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else if (arg === "--chapter") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        fail("--chapter needs a non-negative integer");
      }
      options.chapter = Number.parseInt(value, 10);
      i++;
    } else if (arg?.startsWith("--chapter=")) {
      const value = arg.slice("--chapter=".length);
      if (!/^\d+$/.test(value)) {
        fail("--chapter needs a non-negative integer");
      }
      options.chapter = Number.parseInt(value, 10);
    } else if (arg?.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (command === undefined) {
      if (
        arg === "info" ||
        arg === "toc" ||
        arg === "chapters" ||
        arg === "text" ||
        arg === "validate"
      ) {
        command = arg;
      } else {
        fail(`unknown command: ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    fail("expected exactly one EPUB file");
  }
  const file = positional[0];
  if (file !== undefined) {
    options.file = file;
  }
  return { command, options };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error(`\n${usage()}`);
  process.exit(1);
}

function openBook(file: string | undefined): EpubBook {
  if (file === undefined) {
    fail("missing EPUB file argument");
  }
  try {
    return EpubBook.fromFile(file);
  } catch (error) {
    if (error instanceof EpubError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function runInfo(book: EpubBook, options: Options): void {
  const chapters = book.chapters();
  const summary = {
    title: book.metadata.title ?? null,
    creators: book.metadata.creators,
    language: book.metadata.language ?? null,
    identifier: book.metadata.identifier ?? null,
    publisher: book.metadata.publisher ?? null,
    date: book.metadata.date ?? null,
    description: book.metadata.description ?? null,
    subjects: book.metadata.subjects,
    version: book.version,
    opf: book.opfPath,
    chapters: chapters.length,
    totalWords: book.totalWords(),
    tocSource: book.tocSource,
    mimetype: book.mimetype,
  };
  if (options.json) {
    printJson(summary);
    return;
  }
  const line = (label: string, value: string): void => {
    console.log(`${label.padEnd(12)} ${value}`);
  };
  line("Title:", summary.title ?? "(none)");
  line("Creator:", summary.creators.join(", ") || "(none)");
  line("Language:", summary.language ?? "(none)");
  line("Identifier:", summary.identifier ?? "(none)");
  if (summary.publisher !== null) line("Publisher:", summary.publisher);
  if (summary.date !== null) line("Date:", summary.date);
  if (summary.subjects.length > 0) line("Subjects:", summary.subjects.join(", "));
  line("Version:", `EPUB ${summary.version}`);
  line("OPF:", summary.opf);
  line("Chapters:", String(summary.chapters));
  line("Words:", String(summary.totalWords));
  line("TOC:", `${summary.tocSource === "spine" ? "spine order (no NCX/nav found)" : summary.tocSource}`);
  if (summary.description !== null) {
    console.log(`\n${summary.description}`);
  }
}

function runToc(book: EpubBook, options: Options): void {
  if (options.json) {
    printJson(book.toc);
    return;
  }
  if (book.toc.length === 0) {
    console.log("(no table of contents)");
    return;
  }
  const print = (entries: typeof book.toc, prefix: string): void => {
    entries.forEach((entry, i) => {
      const number = prefix === "" ? String(i + 1) : `${prefix}.${i + 1}`;
      console.log(`${number.padEnd(6)} ${entry.title || "(untitled)"}  — ${entry.href}`);
      print(entry.children, number);
    });
  };
  print(book.toc, "");
}

function runChapters(book: EpubBook, options: Options): void {
  const chapters = book.chapters();
  if (options.json) {
    printJson(chapters);
    return;
  }
  if (chapters.length === 0) {
    console.log("(no chapters in the spine)");
    return;
  }
  for (const chapter of chapters) {
    const title = chapter.title !== undefined ? ` — ${chapter.title}` : "";
    console.log(
      `[${chapter.index}] ${chapter.href}${title} (${chapter.wordCount} words)`,
    );
  }
}

function runText(book: EpubBook, options: Options): void {
  const chapters = book.chapters();
  if (options.chapter !== undefined) {
    const chapter = chapters[options.chapter];
    if (chapter === undefined) {
      fail(
        `chapter ${options.chapter} does not exist (book has ${chapters.length} chapter(s))`,
      );
    }
    if (options.json) {
      printJson({ chapter: options.chapter, href: chapter.href, text: book.chapterText(chapter.href) });
    } else {
      console.log(book.chapterText(chapter.href));
    }
    return;
  }
  const text = book.fullText();
  if (options.json) {
    printJson({ text });
  } else {
    console.log(text);
  }
}

function runValidate(book: EpubBook, options: Options): void {
  const issues = validateEpub(book);
  const errors = countErrors(issues);
  const warnings = countWarnings(issues);
  if (options.json) {
    printJson({ valid: errors === 0, errors, warnings, issues });
  } else {
    if (issues.length === 0) {
      console.log("valid: no issues found");
    } else {
      for (const issue of issues) {
        console.log(`[${issue.severity}] ${issue.code}: ${issue.message}`);
      }
      console.log(
        `\n${errors} error(s), ${warnings} warning(s) — ${errors === 0 ? "usable" : "invalid"}`,
      );
    }
  }
  if (errors > 0) {
    process.exit(2);
  }
}

function main(): void {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === undefined) {
    console.log(usage());
    process.exit(0);
  }
  const book = openBook(options.file);
  switch (command) {
    case "info":
      runInfo(book, options);
      break;
    case "toc":
      runToc(book, options);
      break;
    case "chapters":
      runChapters(book, options);
      break;
    case "text":
      runText(book, options);
      break;
    case "validate":
      runValidate(book, options);
      break;
  }
}

main();
