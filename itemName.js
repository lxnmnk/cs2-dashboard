// Разбирает market_hash_name на "название" и "качество (wear)".
// Примеры:
//   "AK-47 | Redline (Field-Tested)"       -> { baseName: "AK-47 | Redline", wear: "Field-Tested" }
//   "★ Karambit | Doppler (Factory New)"   -> { baseName: "★ Karambit | Doppler", wear: "Factory New" }
//   "Chroma 2 Case"                         -> { baseName: "Chroma 2 Case", wear: null }
//   "Sticker | Team EnVyUs (Holo)"          -> { baseName: "Sticker | Team EnVyUs", wear: "Holo" }
//   "★ Karambit | Doppler (Factory New) - Phase 2" -> { baseName: "★ Karambit | Doppler", wear: "Factory New · Phase 2", phase: "Phase 2" }

const { translateSearchTokens } = require("./public/item-aliases");

const KNOWN_WEARS = new Set([
  "Factory New",
  "Minimal Wear",
  "Field-Tested",
  "Well-Worn",
  "Battle-Scarred",
]);

// Skinbux отдаёт Doppler/Gamma Doppler с суффиксом " - <Phase>" в имени
// (добавляется в sources/skinbux.js, чтобы фазы не перезатирали друг друга).
const DOPPLER_PHASES = [
  "Phase 1",
  "Phase 2",
  "Phase 3",
  "Phase 4",
  "Ruby",
  "Sapphire",
  "Black Pearl",
  "Emerald",
];

/**
 * Убирает синтетический суффикс " - <Phase>" (см. sources/skinbux.js) и
 * возвращает реальный market_hash_name без него — по этому имени ищутся
 * цены в остальных источниках (у них нет разбивки по фазам).
 */
function stripPhaseSuffix(marketHashName) {
  for (const p of DOPPLER_PHASES) {
    const suffix = ` - ${p}`;
    if (marketHashName.endsWith(suffix)) {
      return { base: marketHashName.slice(0, -suffix.length), phase: p };
    }
  }
  return { base: marketHashName, phase: null };
}

function parseItemName(marketHashName) {
  const { base: name, phase } = stripPhaseSuffix(marketHashName);

  const match = name.match(/^(.*)\s\(([^)]+)\)$/);

  if (!match) {
    return { baseName: name, wear: phase, phase };
  }

  const [, baseName, parenthetical] = match;

  // Для стикеров/капсул в скобках бывает не wear, а вариант (Holo, Foil...) —
  // всё равно кладём это значение в колонку "качество", это и есть нужный признак.
  return {
    baseName,
    wear: phase ? `${parenthetical} · ${phase}` : parenthetical,
    isStandardWear: KNOWN_WEARS.has(parenthetical),
    phase,
  };
}

// Убирает всю пунктуацию ("|", "★", "™", скобки и т.п.), оставляя только
// буквы/цифры, разделённые одиночными пробелами. Нужно, чтобы поиск не
// требовал точного форматирования — "awp gungnir" и "AWP | Gungnir"
// нормализуются в одну и ту же строку "awp gungnir".
function normalizeForSearch(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * true, если каждое слово запроса встречается где-то в названии (в любом
 * порядке, без учёта пунктуации/регистра) — так "gungnir awp" и "awp gungnir"
 * одинаково находят "★ AWP | Gungnir (Field-Tested)".
 */
function matchesSearchQuery(marketHashName, query) {
  // Запит може бути російською/українською ("скелетний ніж") — назви ж
  // завжди англійські, тому спершу перекладаємо слова, які знаємо.
  const tokens = translateSearchTokens(normalizeForSearch(query).split(" ").filter(Boolean));
  if (!tokens.length) return false;

  const normalizedName = normalizeForSearch(marketHashName);
  return tokens.every((t) => normalizedName.includes(t));
}

module.exports = {
  parseItemName,
  stripPhaseSuffix,
  KNOWN_WEARS,
  DOPPLER_PHASES,
  normalizeForSearch,
  matchesSearchQuery,
};
