import { z } from "zod";

export const HealthSchema = z.object({ ok: z.boolean(), db: z.enum(["ok", "error"]) });
export type Health = z.infer<typeof HealthSchema>;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`api ${path} ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

// Same-origin JSON GET, validated with a Zod schema. Never echoes response bodies into errors.
export async function apiGet<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(new URL(path, window.location.origin), {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new ApiError(res.status, path);
  return schema.parse(await res.json());
}

export const api = {
  health: (): Promise<Health> => apiGet("/api/health", HealthSchema),
};
