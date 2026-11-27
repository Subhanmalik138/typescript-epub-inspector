/**
 * Public API surface: the book model, the validator, and the two
 * low-level parsers, for anyone who wants to use the inspector as a
 * library instead of a CLI.
 */

export { EpubBook, EpubError, resolveHref } from "./epub.js";
export type {
  ChapterInfo,
  EpubMetadata,
  ManifestItem,
  MimetypeInfo,
  SpineItem,
  TocEntry,
} from "./epub.js";
export { extractText } from "./epub.js";
export { ZipArchive, ZipError, crc32 } from "./zip.js";
export type { ZipEntry } from "./zip.js";
export {
  XmlError,
  childrenNamed,
  decodeEntities,
  descendantsNamed,
  firstChild,
  firstDescendant,
  localName,
  parseXml,
  textContent,
} from "./xml.js";
export type { XmlElement } from "./xml.js";
export { countErrors, countWarnings, validateEpub } from "./validate.js";
export type { Severity, ValidationIssue } from "./validate.js";
