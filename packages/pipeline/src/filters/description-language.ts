/**
 * Which language a posting description is mainly written in, from function-word counts. Pure word lists, no model.
 * Only words that are rare in the other languages are listed ("do", "as", "in", "a" are left out on purpose).
 */
const WORDS: Record<string, string> = {
  english:
    "the and of to for with you we our is are will be on as your this that have or an at by from their who it can",
  spanish:
    "de la el los las y en que con para por una del se su al como mas es tu nuestro nuestra sus este esta ser tiene tener hacia sobre entre desde",
  portuguese:
    "de da dos das em que com para por uma os se seu sua nao mais ou ter voce nosso nossa pela pelo sobre entre",
  german:
    "der die das und ist mit fur von den dem ein eine wir sie bei auf zu nicht auch oder im ihr unser unsere werden",
  french:
    "le la les des du et est pour dans avec une nous vous sur par qui que au aux ce sont notre votre ou",
  italian:
    "il lo gli di che per con una della delle nel sono nostro nostra anche piu del dei alla nella",
  dutch: "de het een en van voor met wij je ik zijn niet ook bij op onze jouw wordt",
  indonesian: "yang dan untuk dengan di ini kami anda akan atau dalam pada dari adalah sebagai",
};

const SETS = Object.entries(WORDS).map(([language, words]) => ({
  language,
  words: new Set(words.split(" ")),
}));

/** Below this many words the text is too short to judge. */
const MIN_WORDS = 40;
/** The leading language must make up at least this share of the words... */
const MIN_SHARE = 0.2;
/** ...and at least this many times the English share. */
const OVER_ENGLISH = 2;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * The language name when the text is mainly written in a language other than English or Indonesian, else null.
 * A text with a good share of English (a bilingual posting) is never named.
 */
export function foreignDescriptionLanguage(text: string | null | undefined): string | null {
  const words = fold(text ?? "").match(/\p{L}+/gu) ?? [];
  if (words.length < MIN_WORDS) return null;
  const share = new Map<string, number>();
  for (const { language, words: set } of SETS) {
    share.set(language, words.filter((w) => set.has(w)).length / words.length);
  }
  const english = share.get("english") ?? 0;
  const indonesian = share.get("indonesian") ?? 0;
  let best: { language: string; share: number } | undefined;
  for (const [language, s] of share) {
    if (language === "english" || language === "indonesian") continue;
    if (best === undefined || s > best.share) best = { language, share: s };
  }
  if (best === undefined || best.share < MIN_SHARE) return null;
  if (best.share < OVER_ENGLISH * english || best.share <= indonesian) return null;
  return best.language;
}
