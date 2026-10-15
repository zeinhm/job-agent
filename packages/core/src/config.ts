import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** ATS boards the adapters read; also the source names of their postings. Single source of truth. */
export const ATS_TYPES = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
] as const;

const salaryConfigSchema = z.strictObject({
  floor_idr_month: z.number().positive(),
  position_in_listed_range: z.number().min(0).max(1),
  tiers: z.strictObject({
    indonesia: z.strictObject({ ask_idr_month: z.number().positive() }),
    regional: z.strictObject({ ask_idr_month: z.number().positive() }),
    global_adjusted: z.strictObject({ ask_idr_month: z.number().positive() }),
    global_flat: z.strictObject({ ask_usd_year: z.number().positive() }),
  }),
  /** Optional: the ask when a company's pay policy is unknown. Missing: the regional ask is used. */
  unknown_tier_ask: z.strictObject({ ask_idr_month: z.number().positive() }).optional(),
  unknown_policy: z.string().min(1),
  text_field_answer: z.string().min(1),
  review_salary_answers: z.boolean(),
});

/** Sources that are off unless `sources.<name>: true` is set in `companies.yaml`. */
export const DEFAULT_OFF_SOURCES = ["linkedin_posts"] as const;

const sourcesConfigSchema = z.strictObject({
  /** Off by default: Brave does not index linkedin.com/posts, so every run only used up the shared Brave cap. */
  linkedin_posts: z.boolean().optional(),
});

const companiesConfigSchema = z.strictObject({
  sources: sourcesConfigSchema.optional(),
  companies: z.array(
    z.strictObject({
      name: z.string().min(1),
      ats: z.enum(ATS_TYPES),
      slug: z.string().min(1),
    }),
  ),
});

export type SalaryConfig = z.infer<typeof salaryConfigSchema>;
export type CompanyConfig = z.infer<typeof companiesConfigSchema>["companies"][number];
export type AppConfig = {
  salary: SalaryConfig;
  companies: CompanyConfig[];
  /** Opt-in switches for default-off sources (see `DEFAULT_OFF_SOURCES`). Missing = all off. */
  sources?: z.infer<typeof sourcesConfigSchema> | undefined;
};

/** Names of the default-off sources the config has not switched on. */
export function disabledSources(config: Pick<AppConfig, "sources">): string[] {
  return DEFAULT_OFF_SOURCES.filter((n) => config.sources?.[n] !== true);
}

/** Parses and validates the text of `companies.yaml`. Errors never include file content. */
export function parseCompaniesYaml(text: string): CompanyConfig[] {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "YAML_ERROR";
    throw new Error(`Config file companies.yaml is not valid YAML (${code})`);
  }
  const result = companiesConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
      .join("; ");
    throw new Error(`Config file companies.yaml is invalid: ${issues}`);
  }
  return result.data.companies;
}

/** Reads and validates one YAML file. Errors name the file and key path, never the values. */
function loadYamlFile<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  let text: string;
  try {
    text = readFileSync(join(dir, file), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`Config file ${file} could not be read in ${dir} (${code})`, { cause: err });
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "YAML_ERROR";
    throw new Error(`Config file ${file} is not valid YAML (${code})`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
      .join("; ");
    throw new Error(`Config file ${file} is invalid: ${issues}`);
  }
  return result.data;
}

/**
 * Text of `cv.md`, needed only by the fit stage. A missing (or empty) file returns null so the caller can
 * skip fit scoring with a message; any other read error throws. Errors never include the file content.
 */
export function loadCv(dir: string = process.env.JOB_AGENT_CONFIG_DIR ?? "config"): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, "cv.md"), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    if (code === "ENOENT") return null;
    throw new Error(`Config file cv.md could not be read in ${dir} (${code})`, { cause: err });
  }
  return text.trim() === "" ? null : text;
}

/**
 * Default-off sources that `companies.yaml` has not switched on, for commands that need no other config
 * (digest, status). A missing file means nothing is switched on; an invalid file throws like `loadConfig`.
 */
export function loadDisabledSources(
  dir: string = process.env.JOB_AGENT_CONFIG_DIR ?? "config",
): string[] {
  try {
    return disabledSources(loadYamlFile(dir, "companies.yaml", companiesConfigSchema));
  } catch (err) {
    if ((err as { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT")
      return disabledSources({});
    throw err;
  }
}

export function loadConfig(dir: string = process.env.JOB_AGENT_CONFIG_DIR ?? "config"): AppConfig {
  const companies = loadYamlFile(dir, "companies.yaml", companiesConfigSchema);
  return {
    salary: loadYamlFile(dir, "salary.yaml", salaryConfigSchema),
    companies: companies.companies,
    sources: companies.sources,
  };
}
