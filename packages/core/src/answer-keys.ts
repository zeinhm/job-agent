import keys from "./answer-keys.json" with { type: "json" };

/** Every real answer-bank key (names only), from answer-keys.json: the contract between the code and the owner's private bank. */
export const ANSWER_KEYS: readonly string[] = keys;

const KNOWN = new Set<string>(ANSWER_KEYS);

export const isAnswerKey = (key: string): boolean => KNOWN.has(key);
