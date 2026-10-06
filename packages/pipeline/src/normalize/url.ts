const TRACKING_KEYS = new Set(["ref", "source", "gh_src", "lever-source"]);

function isTracking(param: string): boolean {
  const key = (param.split("=", 1)[0] ?? "").toLowerCase();
  return key.startsWith("utm_") || TRACKING_KEYS.has(key);
}

/** Drops tracking params and the fragment; everything else is left byte-for-byte as given. */
export function cleanUrl(url: string): string {
  const trimmed = url.trim();
  const hashAt = trimmed.indexOf("#");
  const noHash = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);
  const queryAt = noHash.indexOf("?");
  if (queryAt === -1) return noHash;
  const base = noHash.slice(0, queryAt);
  const kept = noHash
    .slice(queryAt + 1)
    .split("&")
    .filter((p) => p !== "" && !isTracking(p));
  return kept.length > 0 ? `${base}?${kept.join("&")}` : base;
}
