const TRACKING_KEYS = new Set(["ref", "source", "gh_src", "lever-source"]);

function isTracking(param: string): boolean {
  const key = (param.split("=", 1)[0] ?? "").toLowerCase();
  return key.startsWith("utm_") || TRACKING_KEYS.has(key);
}

/** web3.career terms of use: its apply_url must be linked exactly as given. */
function isWeb3Career(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "web3.career" || host.endsWith(".web3.career");
  } catch {
    return false;
  }
}

/** Drops tracking params and the fragment; everything else is left byte-for-byte as given. web3.career links are never modified. */
export function cleanUrl(url: string): string {
  const trimmed = url.trim();
  if (isWeb3Career(trimmed)) return trimmed;
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
