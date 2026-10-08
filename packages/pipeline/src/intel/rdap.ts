import { HttpError, httpGetJson, log } from "@job-agent/core";
import { z } from "zod";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const DAY_MS = 86_400_000;
/** RDAP registries differ in limits; the shared client waits at least this long between requests to one host. */
const RDAP_INTERVAL_MS = 2000;

const BootstrapSchema = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});

const DomainSchema = z.object({
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).optional(),
});

export type DomainAgeLookup = (domain: string) => Promise<number | null>;

/**
 * Domain age in days from the RDAP `registration` event (R6 section 2), or null when it cannot be known:
 * TLD with no RDAP entry (`.io`, `.co`), HTTP failure, bad payload, 404, missing event. Never throws.
 * The bootstrap file and every answer (also failures) are cached in memory for the life of this lookup,
 * so one run asks at most once per domain.
 */
export function createDomainAgeLookup(now: () => Date): DomainAgeLookup {
  let bootstrap: Promise<z.infer<typeof BootstrapSchema> | null> | undefined;
  const cache = new Map<string, Promise<number | null>>();

  const loadBootstrap = () => {
    bootstrap ??= httpGetJson(BOOTSTRAP_URL)
      .then((raw) => BootstrapSchema.parse(raw))
      .catch((e: unknown) => {
        log.warn("rdap: bootstrap unavailable", { error: e instanceof Error ? e.name : "unknown" });
        return null;
      });
    return bootstrap;
  };

  const lookup = async (domain: string): Promise<number | null> => {
    const tld = domain.split(".").at(-1) ?? "";
    const boot = await loadBootstrap();
    const base = boot?.services.find(([tlds]) => tlds.includes(tld))?.[1][0];
    if (!base) return null;
    try {
      const body = DomainSchema.parse(
        await httpGetJson(`${base.replace(/\/?$/, "/")}domain/${encodeURIComponent(domain)}`, {
          minIntervalMs: RDAP_INTERVAL_MS,
          timeoutMs: 5000,
        }),
      );
      const date = body.events?.find((e) => e.eventAction === "registration")?.eventDate;
      const ms = date ? Date.parse(date) : NaN;
      if (Number.isNaN(ms)) return null;
      return Math.max(0, Math.floor((now().getTime() - ms) / DAY_MS));
    } catch (e) {
      log.warn("rdap: lookup failed", {
        domain,
        status: e instanceof HttpError ? e.status : null,
      });
      return null;
    }
  };

  return (domain) => {
    const key = domain.toLowerCase();
    let hit = cache.get(key);
    if (!hit) {
      hit = lookup(key);
      cache.set(key, hit);
    }
    return hit;
  };
}
