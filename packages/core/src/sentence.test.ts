import { describe, expect, it } from "vitest";
import { endSentence } from "./sentence.ts";

describe("endSentence", () => {
  it.each([
    ["Open to talk.", "Open to talk."],
    ["Open to talk!", "Open to talk!"],
    ["Open to talk?", "Open to talk?"],
    ["Open to talk...", "Open to talk..."],
    ["Open to talk…", "Open to talk…"],
    ["Open to talk", "Open to talk."],
    ["Open to talk.  ", "Open to talk."],
    ["Open to talk  ", "Open to talk."],
    ['She said "open to talk."', 'She said "open to talk."'],
    ["Open to talk (negotiable.)", "Open to talk (negotiable.)"],
    ["Open to talk (negotiable)", "Open to talk (negotiable)."],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(endSentence(input)).toBe(expected);
  });
});
