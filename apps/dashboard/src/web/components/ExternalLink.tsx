import type { ReactNode } from "react";

/** The normalized URL when it is a plain http(s) URL, else undefined. */
export function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// Posting-supplied URLs are untrusted: only http(s) becomes a link, anything else is shown as text.
export function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  const safe = safeHref(href);
  if (safe === undefined) return <span>{children ?? href}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children ?? href}
    </a>
  );
}
