/**
 * Structural validation for EPUB files.
 *
 * Checks the rules the EPUB spec and common reading systems actually care
 * about: a well-formed container, a resolvable OPF, every manifest and
 * spine reference pointing at a file that exists in the archive, a
 * reachable table of contents, and the required Dublin Core metadata.
 * Issues are split into errors (the book is broken) and warnings (it will
 * probably still open, but something is off).
 */
import { resolveHref } from "./epub.js";
export function validateEpub(book) {
    const issues = [];
    const error = (code, message) => {
        issues.push({ severity: "error", code, message });
    };
    const warning = (code, message) => {
        issues.push({ severity: "warning", code, message });
    };
    // --- Container -------------------------------------------------------
    if (!book.mimetype.present) {
        error("MISSING_MIMETYPE", 'missing or wrong "mimetype" file (expected "application/epub+zip")');
    }
    else {
        if (!book.mimetype.first) {
            warning("MIMETYPE_NOT_FIRST", '"mimetype" should be the first entry in the archive');
        }
        if (!book.mimetype.stored) {
            warning("MIMETYPE_COMPRESSED", '"mimetype" should be stored uncompressed, not deflated');
        }
    }
    // --- Metadata --------------------------------------------------------
    if (book.metadata.title === undefined || book.metadata.title === "") {
        error("MISSING_TITLE", "no dc:title in the OPF metadata");
    }
    if (book.metadata.identifier === undefined || book.metadata.identifier === "") {
        error("MISSING_IDENTIFIER", "no dc:identifier in the OPF metadata");
    }
    if (book.metadata.language === undefined || book.metadata.language === "") {
        error("MISSING_LANGUAGE", "no dc:language in the OPF metadata");
    }
    if (book.metadata.creators.length === 0) {
        warning("MISSING_CREATOR", "no dc:creator in the OPF metadata");
    }
    // --- Manifest --------------------------------------------------------
    if (book.manifest.length === 0) {
        error("EMPTY_MANIFEST", "the OPF manifest has no items");
    }
    const seenIds = new Set();
    const opfDir = book.opfPath.includes("/")
        ? book.opfPath.slice(0, book.opfPath.lastIndexOf("/"))
        : "";
    for (const item of book.manifest) {
        if (item.id === "") {
            error("MANIFEST_ITEM_NO_ID", `manifest item "${item.href}" has no id`);
            continue;
        }
        if (seenIds.has(item.id)) {
            error("DUPLICATE_MANIFEST_ID", `manifest id "${item.id}" appears twice`);
        }
        seenIds.add(item.id);
        if (item.href === "") {
            error("MANIFEST_ITEM_NO_HREF", `manifest item "${item.id}" has no href`);
            continue;
        }
        const fullPath = resolveHref(opfDir, item.href);
        if (!book.zip.has(fullPath)) {
            error("MISSING_MANIFEST_FILE", `manifest item "${item.id}" points at "${item.href}", which is not in the archive`);
        }
    }
    // --- Spine -----------------------------------------------------------
    if (book.spine.length === 0) {
        error("EMPTY_SPINE", "the OPF spine has no items");
    }
    for (const spineItem of book.spine) {
        if (book.manifestById(spineItem.idref) === undefined) {
            error("MISSING_SPINE_ITEM", `spine references id "${spineItem.idref}", which is not in the manifest`);
        }
    }
    // --- Table of contents ------------------------------------------------
    if (book.tocSource === "spine") {
        warning("MISSING_TOC", "no NCX (EPUB 2) or nav document (EPUB 3) found; using spine order as the table of contents");
    }
    const checkToc = (entries) => {
        for (const entry of entries) {
            if (entry.href === "") {
                warning("TOC_ENTRY_NO_HREF", `table of contents entry "${entry.title}" has no link`);
            }
            else {
                const fullPath = resolveHref(opfDir, entry.href);
                if (!book.zip.has(fullPath)) {
                    error("MISSING_TOC_TARGET", `table of contents entry "${entry.title}" links to "${entry.href}", which is not in the archive`);
                }
            }
            checkToc(entry.children);
        }
    };
    checkToc(book.toc);
    return issues;
}
export function countErrors(issues) {
    return issues.filter((issue) => issue.severity === "error").length;
}
export function countWarnings(issues) {
    return issues.filter((issue) => issue.severity === "warning").length;
}
