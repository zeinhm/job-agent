import { convert } from "html-to-text";

const SKIP = ["script", "style", "head", "noscript", "template", "iframe", "svg"].map(
  (selector) => ({
    selector,
    format: "skip",
  }),
);

const OPTIONS = {
  wordwrap: false as const,
  selectors: [
    ...SKIP,
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
};

const ESCAPED = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" } as const;

/** Real HTML passes through; entity-escaped HTML (Greenhouse) is unescaped once; plain text keeps its newlines. */
function toHtmlSource(input: string): string {
  if (/<[a-z!/]/i.test(input)) return input;
  if (/&lt;\/?[a-z!]/i.test(input)) {
    return input.replace(
      /&(?:lt|gt|quot|#39|amp);/g,
      (entity) => ESCAPED[entity as keyof typeof ESCAPED],
    );
  }
  return input.replace(/\r?\n/g, "<br>");
}

/** HTML (or plain text) to plain text: entities decoded, tags stripped, paragraph breaks kept, whitespace collapsed. */
export function htmlToText(html: string): string {
  return convert(toHtmlSource(html), OPTIONS)
    .replace(/[ ​]/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Single-line text (titles, locations): entities decoded, tags stripped, all whitespace collapsed. */
export function cleanLine(text: string): string {
  return htmlToText(text).replace(/\s+/g, " ").trim();
}
