/**
 * A small, forgiving XML parser — just enough for the XML an EPUB
 * contains (container.xml, OPF packages, NCX tables of contents).
 *
 * It builds a plain element tree: tags keep their namespace prefixes
 * (e.g. `dc:title`), attributes are decoded, and text is entity-decoded.
 * Malformed input is tolerated where it costs nothing: a stray end tag is
 * ignored and an unclosed element is closed at end of input, because a
 * real-world EPUB reader should report what it can rather than bail out
 * on one bad file.
 */

export interface XmlElement {
  /** Tag name exactly as written, namespace prefix included. */
  tag: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Direct text content of this element (child elements excluded). */
  text: string;
  /**
   * Text chunks and child elements in document order. This is what
   * `textContent` walks, so "Hello <em>brave</em> new world" comes back
   * in the right order instead of "Hello  new worldbrave".
   */
  content: Array<string | XmlElement>;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

/** The part after any `prefix:` in a tag or attribute name. */
export function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Decode XML entities: the five predefined ones plus numeric references. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const codePoint =
          body.startsWith("#x") || body.startsWith("#X")
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
          return match;
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
}

export function parseXml(input: string): XmlElement {
  let pos = 0;
  const root: XmlElement = { tag: "", attributes: {}, children: [], text: "", content: [] };
  const stack: XmlElement[] = [root];

  const top = (): XmlElement => {
    const element = stack[stack.length - 1];
    if (element === undefined) {
      throw new XmlError("internal parser error: empty element stack");
    }
    return element;
  };

  /** Append decoded text to the current element, keeping document order. */
  const appendText = (value: string): void => {
    if (value === "") {
      return;
    }
    const element = top();
    element.text += value;
    element.content.push(value);
  };

  while (pos < input.length) {
    const lt = input.indexOf("<", pos);
    if (lt === -1) {
      appendText(decodeEntities(input.slice(pos)));
      break;
    }
    if (lt > pos) {
      appendText(decodeEntities(input.slice(pos, lt)));
    }
    pos = lt;

    if (input.startsWith("<!--", pos)) {
      const end = input.indexOf("-->", pos + 4);
      pos = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", pos)) {
      const end = input.indexOf("]]>", pos + 9);
      const cdata = end === -1 ? input.slice(pos + 9) : input.slice(pos + 9, end);
      appendText(cdata);
      pos = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<?", pos)) {
      const end = input.indexOf("?>", pos + 2);
      pos = end === -1 ? input.length : end + 2;
      continue;
    }
    if (input.startsWith("<!", pos)) {
      // DOCTYPE (possibly with an internal subset in [...]) or other
      // declaration: skip to the matching ">" outside brackets.
      pos = skipDeclaration(input, pos);
      continue;
    }
    if (input.startsWith("</", pos)) {
      const end = input.indexOf(">", pos + 2);
      const name = input
        .slice(pos + 2, end === -1 ? input.length : end)
        .trim();
      // Close the nearest open element with this name; stray end tags
      // (no match on the stack) are ignored.
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]?.tag === name) {
          stack.length = i;
          break;
        }
      }
      pos = end === -1 ? input.length : end + 1;
      continue;
    }

    // Start tag (possibly self-closing).
    const end = input.indexOf(">", pos + 1);
    if (end === -1) {
      throw new XmlError("unterminated start tag");
    }
    let inner = input.slice(pos + 1, end);
    const selfClosing = inner.trimEnd().endsWith("/");
    if (selfClosing) {
      inner = inner.trimEnd().slice(0, -1);
    }
    const { tag, attributes } = parseTag(inner);
    if (tag === "") {
      throw new XmlError("empty tag name");
    }
    const element: XmlElement = { tag, attributes, children: [], text: "", content: [] };
    top().children.push(element);
    top().content.push(element);
    if (!selfClosing) {
      stack.push(element);
    }
    pos = end + 1;
  }

  if (root.children.length !== 1) {
    throw new XmlError(
      `expected exactly one root element, found ${root.children.length}`,
    );
  }
  const document = root.children[0];
  if (document === undefined) {
    throw new XmlError("empty document");
  }
  return document;
}

/** Skip a `<!...>` declaration, tracking `[...]` subsets so a ">" inside one does not end it early. */
function skipDeclaration(input: string, pos: number): number {
  let depth = 0;
  for (let i = pos; i < input.length; i++) {
    const char = input[i];
    if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
    } else if (char === ">" && depth === 0) {
      return i + 1;
    }
  }
  return input.length;
}

/** Parse `tag attr="value" attr2='value2'` into a tag name and attributes. */
function parseTag(inner: string): {
  tag: string;
  attributes: Record<string, string>;
} {
  const attributes: Record<string, string> = {};
  let i = 0;
  while (i < inner.length && /\s/.test(inner[i] ?? "")) {
    i++;
  }
  const tagStart = i;
  while (i < inner.length && !/\s/.test(inner[i] ?? "")) {
    i++;
  }
  const tag = inner.slice(tagStart, i);
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i] ?? "")) {
      i++;
    }
    if (i >= inner.length) {
      break;
    }
    const nameStart = i;
    while (i < inner.length && inner[i] !== "=" && !/\s/.test(inner[i] ?? "")) {
      i++;
    }
    const name = inner.slice(nameStart, i);
    while (i < inner.length && /\s/.test(inner[i] ?? "")) {
      i++;
    }
    if (inner[i] !== "=") {
      // Valueless attribute (rare in EPUB XML); record it as empty.
      if (name !== "") {
        attributes[name] = "";
      }
      continue;
    }
    i++; // consume "="
    while (i < inner.length && /\s/.test(inner[i] ?? "")) {
      i++;
    }
    const quote = inner[i];
    if (quote !== '"' && quote !== "'") {
      // Unquoted value: read to the next whitespace.
      const valueStart = i;
      while (i < inner.length && !/\s/.test(inner[i] ?? "")) {
        i++;
      }
      attributes[name] = decodeEntities(inner.slice(valueStart, i));
      continue;
    }
    i++; // consume opening quote
    const valueStart = i;
    const valueEnd = inner.indexOf(quote, i);
    const end = valueEnd === -1 ? inner.length : valueEnd;
    attributes[name] = decodeEntities(inner.slice(valueStart, end));
    i = end + 1;
  }
  return { tag, attributes };
}

/** Direct children whose local tag name matches. */
export function childrenNamed(
  element: XmlElement,
  name: string,
): XmlElement[] {
  return element.children.filter((child) => localName(child.tag) === name);
}

/** First direct child whose local tag name matches. */
export function firstChild(
  element: XmlElement,
  name: string,
): XmlElement | undefined {
  return element.children.find((child) => localName(child.tag) === name);
}

/** All descendants (depth-first, document order) with a matching local name. */
export function descendantsNamed(
  element: XmlElement,
  name: string,
): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (localName(child.tag) === name) {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(element);
  return found;
}

/** First descendant (depth-first) with a matching local name. */
export function firstDescendant(
  element: XmlElement,
  name: string,
): XmlElement | undefined {
  return descendantsNamed(element, name)[0];
}

/** All text in the subtree, in document order (text and elements interleaved). */
export function textContent(element: XmlElement): string {
  let out = "";
  for (const node of element.content) {
    out += typeof node === "string" ? node : textContent(node);
  }
  return out;
}
