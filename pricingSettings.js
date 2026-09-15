// Наценки, которые владелец меняет из панели (/mytrades), не трогая код.
//
//   buyMarkup   — вкладка "Купити скіни": цена клиенту = youpin ask + buyMarkup.
//   tradeMarkup — витрина раздела Trade: там своя наценка, потому что в обмене
//                 мы зарабатываем ещё и на стороне клиента (его предметы берём
//                 за 97% цены Skinbux).
//
// Храним дробью (0.03 = 3%), в панели показываем процентами.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "pricingSettings.json");
const DEFAULTS = { buyMarkup: 0, tradeMarkup: 0.03 };
const MAX_MARKUP = 1; // 100% — выше это почти наверняка опечатка

function get() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return {
      buyMarkup: normalize(saved.buyMarkup, DEFAULTS.buyMarkup),
      tradeMarkup: normalize(saved.tradeMarkup, DEFAULTS.tradeMarkup),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function normalize(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_MARKUP ? n : fallback;
}

/**
 * Принимает проценты (5 = 5%), сохраняет дробью. Пустое/не переданное поле
 * оставляем как было — чтобы можно было менять одну наценку, не трогая вторую.
 */
function setFromPercents({ buyMarkupPercent, tradeMarkupPercent }) {
  const current = get();
  const next = { ...current };

  for (const [key, raw] of [["buyMarkup", buyMarkupPercent], ["tradeMarkup", tradeMarkupPercent]]) {
    if (raw === undefined || raw === null || raw === "") continue;
    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent < 0) throw new Error("Наценка должна быть числом не меньше нуля");
    if (percent > MAX_MARKUP * 100) throw new Error("Наценка больше 100% — похоже на опечатку");
    // Округляем до сотых процента: 2.5% -> 0.025, 3% -> 0.03.
    next[key] = Math.round(percent * 100) / 10000;
  }

  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { get, setFromPercents, DEFAULTS };
