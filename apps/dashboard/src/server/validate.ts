import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType, z } from "zod";

function invalid(paths: string[]): HTTPException {
  return new HTTPException(400, {
    res: Response.json(
      { error: "invalid request", issues: paths.map((path) => ({ path })) },
      { status: 400 },
    ),
  });
}

function check<S extends ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  // Paths only: issue messages can echo the submitted value.
  throw invalid(parsed.error.issues.map((i) => i.path.map(String).join(".")));
}

export function parseQuery<S extends ZodType>(c: Context, schema: S): z.output<S> {
  return check(schema, c.req.query());
}

export async function parseBody<S extends ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid([]);
  }
  return check(schema, raw);
}
