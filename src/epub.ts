/**
 * EPUB 2 / EPUB 3 book model.
 *
 * Opens an EPUB from a file or a buffer and exposes its metadata (from the
 * OPF package document), manifest, spine, table of contents (NCX for
 * EPUB 2, the nav document for EPUB 3, falling back to spine order), and
 * chapter text. All parsing is hand-rolled and zero-dependency: ZIP via
 * `zip.ts`, XML via `xml.ts`.
 */

import { readFileSync } from "node:fs";
import { ZipArchive } from "./zip.js";
import {
  childrenNamed,
  decodeEntities,
  firstChild,
  firstDescendant,
  localName,
  parseXml,
  textContent,
  type XmlElement,
} from "./xml.js";

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubError";
  }
}

export interface EpubMetadata {
  title?: string;
  creators: string[];
  contributors: string[];
  language?: string;
  identifier?: string;
  publisher?: string;
  date?: string;
  description?: string;
  subjects: string[];
  rights?: string;
}

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  /** Raw `properties` attribute, e.g. "nav cover". Undefined when absent. */
  properties?: string;
}

export interface SpineItem {
  idref: string;
  /** False for front/back matter the reader may skip; defaults to true. */
  linear: boolean;
}

export interface TocEntry {
  title: string;
  /** Href as written in the TOC, fragment included (e.g. "ch1.xhtml#s2"). */
  href: string;
  /** Nesting depth, 1 for a top-level entry. */
  level: number;
  children: TocEntry[];
}

export interface ChapterInfo {
  /** Position in the spine, 0-based. */
  index: number;
  id: string;
  /** Href relative to the OPF directory, as written in the manifest. */
  href: string;
  mediaType: string;
  /** Title from the TOC when one points at this chapter, else undefined. */
  title?: string;
  wordCount: number;
}

export interface MimetypeInfo {
  present: boolean;
  /** The spec requires mimetype to be the first entry, stored uncompressed. */
  first: boolean;
  stored: boolean;
}

const MIMETYPE_CONTENT = "application/epub+zip";

/** Join a relative href onto a base directory inside the archive. */
export function resolveHref(baseDir: string, href: string): string {
  const path = href.split("#")[0] ?? "";
  const parts = [...(baseDir === "" ? [] : baseDir.split("/")), ...path.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export class EpubBook {
  readonly zip: ZipArchive;
  readonly opfPath: string;
  readonly version: string;
  readonly metadata: EpubMetadata;
  readonly manifest: ManifestItem[];
  readonly spine: SpineItem[];
  readonly toc: TocEntry[];
  /** Where the TOC came from: "ncx", "nav", or "spine" (fallback). */
  readonly tocSource: "ncx" | "nav" | "spine";
  readonly mimetype: MimetypeInfo;

  private constructor(init: {
    zip: ZipArchive;
    opfPath: string;
    version: string;
    metadata: EpubMetadata;
    manifest: ManifestItem[];
    spine: SpineItem[];
    toc: TocEntry[];
    tocSource: "ncx" | "nav" | "spine";
    mimetype: MimetypeInfo;
  }) {
    this.zip = init.zip;
    this.opfPath = init.opfPath;
    this.version = init.version;
    this.metadata = init.metadata;
    this.manifest = init.manifest;
    this.spine = init.spine;
    this.toc = init.toc;
    this.tocSource = init.tocSource;
    this.mimetype = init.mimetype;
  }

  static fromBuffer(data: Buffer): EpubBook {
    let zip: ZipArchive;
    try {
      zip = ZipArchive.fromBuffer(data);
    } catch (error) {
      throw new EpubError(
        `not a readable EPUB: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const mimetype = inspectMimetype(zip);

    const containerRaw = zip.read("META-INF/container.xml");
    if (containerRaw === undefined) {
      throw new EpubError("missing META-INF/container.xml");
    }
    const container = parseXml(containerRaw.toString("utf8"));
    const rootfile = firstDescendant(container, "rootfile");
    const opfPath = rootfile?.attributes["full-path"];
    if (opfPath === undefined || opfPath === "") {
      throw new EpubError("container.xml has no rootfile full-path");
    }

    const opfRaw = zip.read(opfPath);
    if (opfRaw === undefined) {
      throw new EpubError(`OPF package document not found: ${opfPath}`);
    }
    const opf = parseXml(opfRaw.toString("utf8"));
    const version = opf.attributes["version"] ?? "2.0";
    const opfDir = dirname(opfPath);

    const metadataEl = firstChild(opf, "metadata");
    const metadata = parseMetadata(metadataEl);
    const manifest = parseManifest(firstChild(opf, "manifest"));
    const spine = parseSpine(firstChild(opf, "spine"));

    const { toc, tocSource } = buildToc(zip, opfDir, version, manifest, spine);

    return new EpubBook({
      zip,
      opfPath,
      version,
      metadata,
      manifest,
      spine,
      toc,
      tocSource,
      mimetype,
    });
  }

  static fromFile(path: string): EpubBook {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      throw new EpubError(`cannot read file: ${path}`);
    }
    try {
      return EpubBook.fromBuffer(data);
    } catch (error) {
      if (error instanceof EpubError) {
        throw error;
      }
      throw new EpubError(
        `not a readable EPUB: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  manifestById(id: string): ManifestItem | undefined {
    return this.manifest.find((item) => item.id === id);
  }

  /** Spine items resolved to their manifest entries, in reading order. */
  chapters(): ChapterInfo[] {
    const titlesByHref = new Map<string, string>();
    const collect = (entries: TocEntry[]): void => {
      for (const entry of entries) {
        const file = resolveHref(dirname(this.opfPath), entry.href);
        if (!titlesByHref.has(file)) {
          titlesByHref.set(file, entry.title);
        }
        collect(entry.children);
      }
    };
    collect(this.toc);

    const chapters: ChapterInfo[] = [];
    this.spine.forEach((spineItem, index) => {
      const item = this.manifestById(spineItem.idref);
      if (item === undefined) {
        return;
      }
      const fullPath = resolveHref(dirname(this.opfPath), item.href);
      const title = titlesByHref.get(fullPath);
      chapters.push({
        index,
        id: item.id,
        href: item.href,
        mediaType: item.mediaType,
        ...(title !== undefined ? { title } : {}),
        wordCount: countWords(this.chapterText(item.href)),
      });
    });
    return chapters;
  }

  /**
   * Plain text of one chapter, referenced by its manifest href. Tags are
   * stripped and entities decoded; whitespace is collapsed to single
   * spaces. Returns "" when the file is missing from the archive.
   */
  chapterText(href: string): string {
    const fullPath = resolveHref(dirname(this.opfPath), href);
    const raw = this.zip.read(fullPath);
    if (raw === undefined) {
      return "";
    }
    return extractText(raw.toString("utf8"));
  }

  /** Plain text of the whole book, chapters joined in spine order. */
  fullText(): string {
    return this.chapters()
      .map((chapter) => this.chapterText(chapter.href))
      .filter((text) => text !== "")
      .join("\n\n");
  }

  totalWords(): number {
    return this.chapters().reduce((sum, chapter) => sum + chapter.wordCount, 0);
  }
}

function inspectMimetype(zip: ZipArchive): MimetypeInfo {
  const entries = zip.list();
  const first = entries[0];
  const entry = zip.getEntry("mimetype");
  if (entry === undefined) {
    return { present: false, first: false, stored: false };
  }
  const content = zip.read("mimetype")?.toString("ascii").trim();
  return {
    present: content === MIMETYPE_CONTENT,
    first: first?.name === "mimetype",
    stored: entry.method === 0,
  };
}

function parseMetadata(metadataEl: XmlElement | undefined): EpubMetadata {
  const metadata: EpubMetadata = { creators: [], contributors: [], subjects: [] };
  if (metadataEl === undefined) {
    return metadata;
  }
  for (const child of metadataEl.children) {
    const name = localName(child.tag);
    const value = textContent(child).trim();
    switch (name) {
      case "title":
        metadata.title ??= value;
        break;
      case "creator":
        if (value !== "") metadata.creators.push(value);
        break;
      case "contributor":
        if (value !== "") metadata.contributors.push(value);
        break;
      case "language":
        metadata.language ??= value;
        break;
      case "identifier":
        metadata.identifier ??= value;
        break;
      case "publisher":
        metadata.publisher ??= value;
        break;
      case "date":
        metadata.date ??= value;
        break;
      case "description":
        metadata.description ??= value;
        break;
      case "subject":
        if (value !== "") metadata.subjects.push(value);
        break;
      case "rights":
        metadata.rights ??= value;
        break;
      default:
        break;
    }
  }
  return metadata;
}

function parseManifest(manifestEl: XmlElement | undefined): ManifestItem[] {
  if (manifestEl === undefined) {
    return [];
  }
  return childrenNamed(manifestEl, "item").map((item) => {
    const properties = item.attributes["properties"];
    return {
      id: item.attributes["id"] ?? "",
      href: item.attributes["href"] ?? "",
      mediaType: item.attributes["media-type"] ?? "",
      ...(properties !== undefined ? { properties } : {}),
    };
  });
}

function parseSpine(spineEl: XmlElement | undefined): SpineItem[] {
  if (spineEl === undefined) {
    return [];
  }
  return childrenNamed(spineEl, "itemref").map((item) => ({
    idref: item.attributes["idref"] ?? "",
    linear: item.attributes["linear"] !== "no",
  }));
}

function buildToc(
  zip: ZipArchive,
  opfDir: string,
  version: string,
  manifest: ManifestItem[],
  spine: SpineItem[],
): { toc: TocEntry[]; tocSource: "ncx" | "nav" | "spine" } {
  // EPUB 3: the nav document carries the TOC.
  if (version.startsWith("3")) {
    const nav = manifest.find((item) =>
      (item.properties ?? "").split(/\s+/).includes("nav"),
    );
    if (nav !== undefined) {
      const raw = zip.read(resolveHref(opfDir, nav.href));
      if (raw !== undefined) {
        const toc = parseNavDocument(raw.toString("utf8"));
        if (toc.length > 0) {
          return { toc, tocSource: "nav" };
        }
      }
    }
  }

  // EPUB 2: the NCX document named by the spine's toc attribute.
  const ncx = manifest.find(
    (item) => item.mediaType === "application/x-dtbncx+xml",
  );
  if (ncx !== undefined) {
    const raw = zip.read(resolveHref(opfDir, ncx.href));
    if (raw !== undefined) {
      const toc = parseNcx(raw.toString("utf8"));
      if (toc.length > 0) {
        return { toc, tocSource: "ncx" };
      }
    }
  }

  // Fallback: one flat entry per spine item.
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const toc: TocEntry[] = spine
    .map((spineItem) => byId.get(spineItem.idref))
    .filter((item): item is ManifestItem => item !== undefined)
    .map((item) => ({
      title: basename(item.href),
      href: item.href,
      level: 1,
      children: [],
    }));
  return { toc, tocSource: "spine" };
}

/** Parse an EPUB 3 nav document: `<nav epub:type="toc"><ol><li><a href>…`. */
function parseNavDocument(xhtml: string): TocEntry[] {
  let root: XmlElement;
  try {
    root = parseXml(xhtml);
  } catch {
    return [];
  }
  const navs = [root, ...walk(root)].filter(
    (el) =>
      localName(el.tag) === "nav" &&
      (el.attributes["epub:type"] ?? "").split(/\s+/).includes("toc"),
  );
  const nav = navs[0] ?? firstDescendant(root, "nav");
  if (nav === undefined) {
    return [];
  }
  const list = firstChild(nav, "ol");
  return list === undefined ? [] : parseNavList(list, 1);
}

function parseNavList(list: XmlElement, level: number): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const li of childrenNamed(list, "li")) {
    const link = firstChild(li, "a");
    const nested = firstChild(li, "ol");
    // Some navs use a bare <span> instead of a link for section headers.
    const span = link === undefined ? firstChild(li, "span") : undefined;
    const titleEl = link ?? span;
    const title = titleEl === undefined ? "" : textContent(titleEl).trim();
    const href = link?.attributes["href"] ?? "";
    entries.push({
      title,
      href,
      level,
      children: nested === undefined ? [] : parseNavList(nested, level + 1),
    });
  }
  return entries;
}

/** Parse an EPUB 2 NCX document: navMap > navPoint (navLabel/text, content src). */
function parseNcx(ncxXml: string): TocEntry[] {
  let root: XmlElement;
  try {
    root = parseXml(ncxXml);
  } catch {
    return [];
  }
  const navMap = firstDescendant(root, "navMap");
  if (navMap === undefined) {
    return [];
  }
  return parseNavPoints(navMap, 1);
}

function parseNavPoints(navMap: XmlElement, level: number): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const point of childrenNamed(navMap, "navPoint")) {
    const label = firstDescendant(point, "text");
    const content = firstChild(point, "content");
    entries.push({
      title: label === undefined ? "" : textContent(label).trim(),
      href: content?.attributes["src"] ?? "",
      level,
      children: parseNavPoints(point, level + 1),
    });
  }
  return entries;
}

function walk(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const child of node.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(element);
  return out;
}

/**
 * Extract readable text from an XHTML chapter. The document is parsed as
 * XML when it is well-formed; anything else (loose HTML, a truncated
 * file) falls back to tag stripping so one bad chapter never kills the
 * whole book. Script and style content is dropped in both paths.
 */
export function extractText(xhtml: string): string {
  const withoutHead = xhtml.replace(/<head[\s>][\s\S]*?<\/head\s*>/gi, " ");
  const withoutScripts = withoutHead
    .replace(/<script[\s>][\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s>][\s\S]*?<\/style\s*>/gi, " ");
  try {
    const root = parseXml(withoutScripts);
    return collapseWhitespace(spacedText(root));
  } catch {
    return collapseWhitespace(
      decodeEntities(
        withoutScripts
          .replace(/<!--[\s\S]*?-->/g, " ")
          .replace(/<[^>]*>/g, " "),
      ),
    );
  }
}

/**
 * Like `textContent`, but with a space after every element so words from
 * adjacent elements never run together ("Chapter One" + "The quick…"
 * must not become "OneThe"). Whitespace is collapsed afterwards, so the
 * extra spaces are harmless.
 */
function spacedText(element: XmlElement): string {
  let out = "";
  for (const node of element.content) {
    if (typeof node === "string") {
      out += node;
    } else {
      out += spacedText(node);
      out += " ";
    }
  }
  return out;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  if (text === "") {
    return 0;
  }
  return text.split(/\s+/).filter((word) => word !== "").length;
}
