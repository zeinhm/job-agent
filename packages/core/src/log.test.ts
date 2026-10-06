import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";

describe("createLogger", () => {
  it("writes one JSON line with ts, level, msg and extra fields", () => {
    const lines: string[] = [];
    const logger = createLogger(
      (line) => lines.push(line),
      () => new Date("2026-01-02T03:04:05.000Z"),
    );
    logger.warn("hello", { source: "demo", count: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ts: "2026-01-02T03:04:05.000Z",
      level: "warn",
      msg: "hello",
      source: "demo",
      count: 2,
    });
  });

  it("supports all four levels", () => {
    const levels: string[] = [];
    const logger = createLogger((line) => levels.push(JSON.parse(line).level));
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });

  it("does not let extra fields override ts, level or msg", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).info("real", { msg: "fake", level: "x" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", msg: "real" });
  });
});
