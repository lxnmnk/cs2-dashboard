// Проценты, которые владелец меняет из панели (/mytrades), не трогая код.
//
//   buyMarkup     — "Купити скіни": цена клиенту = youpin ask + buyMarkup.
//   sellDiscount  — "Продати скіни" (кабинет, автопродажа, проверка цены):
//                   платим клиенту цену Skinbux − sellDiscount.
//   tradeMarkup   — Trade, наша сторона: youpin ask + tradeMarkup.
//   tradeDiscount — Trade, сторона клиента: его скины берём по цене
//                   Skinbux − tradeDiscount.
//
// Трейд считается отдельно от покупки и продажи: в обмене мы зарабатываем
// сразу на двух сторонах, поэтому его проценты обычно ниже. На акцию все
// четыре можно выставить в 0.
//
// Храним дробью (0.03 = 3%), в панели показываем процентами.
//
// Курс гривны — два, как в обменнике:
//   uahRateSell — клиент продаёт нам скины и получает гривну на карту: столько
//                 гривен за доллар мы ему платим (по этому курсу сами продаём
//                 доллар, чтобы ему заплатить);
//   uahRateBuy  — клиент покупает у нас за гривну: столько гривен за доллар
//                 берём (по этому курсу сами покупаем доллар).
// Хранятся как есть (45 = 45 ₴ за $), не дробью.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "pricingSettings.json");
const DEFAULTS = { buyMarkup: 0, sellDiscount: 0.05, tradeMarkup: 0.03, tradeDiscount: 0.03 };
const MAX_RATE = 1; // 100% — выше это почти наверняка опечатка
const UAH_DEFAULTS = { uahRateSell: 45, uahRateBuy: 47 };
const UAH_RANGE = [10, 200]; // за пределами — опечатка, а не курс

// Поле из панели (в процентах) -> ключ настройки (дробью).
const PERCENT_FIELDS = {
  buyMarkupPercent: "buyMarkup",
  sellDiscountPercent: "sellDiscount",
  tradeMarkupPercent: "tradeMarkup",
  tradeDiscountPercent: "tradeDiscount",
};

function get() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    // файла ещё нет — работают значения по умолчанию
  }
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    result[key] = normalize(saved[key], fallback);
  }
  for (const [key, fallback] of Object.entries(UAH_DEFAULTS)) {
    const n = Number(saved[key]);
    result[key] = Number.isFinite(n) && n >= UAH_RANGE[0] && n <= UAH_RANGE[1] ? n : fallback;
  }
  return result;
}

function normalize(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) && n >= 0 && n <= MAX_RATE ? n : fallback;
}

/**
 * Принимает проценты (5 = 5%), сохраняет дробью. Пустое/не переданное поле
 * оставляем как было — чтобы можно было менять один процент, не трогая другие.
 */
function setFromPercents(body) {
  const next = get();

  for (const [field, key] of Object.entries(PERCENT_FIELDS)) {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent < 0) throw new Error("Процент должен быть числом не меньше нуля");
    if (percent > MAX_RATE * 100) throw new Error("Процент больше 100% — похоже на опечатку");
    // Округляем до сотых процента: 2.5% -> 0.025, 3% -> 0.03.
    next[key] = Math.round(percent * 100) / 10000;
  }

  for (const key of Object.keys(UAH_DEFAULTS)) {
    const raw = body?.[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < UAH_RANGE[0] || rate > UAH_RANGE[1]) {
      throw new Error(`Курс гривны — число от ${UAH_RANGE[0]} до ${UAH_RANGE[1]}`);
    }
    next[key] = Math.round(rate * 100) / 100;
  }
  if (next.uahRateBuy < next.uahRateSell) throw new Error("Курс покупки не может быть ниже курса продажи");

  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { get, setFromPercents, DEFAULTS, UAH_DEFAULTS };
