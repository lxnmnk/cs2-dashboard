// Публичная котировка "сколько мы готовы заплатить за твой скин" — отдельная
// страница public/sell-quote.html, доступная БЕЗ логина внешним людям (не
// путать с обычным арбитражным расчётом в pricingEngine.js — там своя формула
// под нашу собственную покупку/продажу через биржи, здесь фиксированная
// формула ручного выкупа у людей, заданная пользователем):
//   цена = skinbux bid - 5%, но не выше цены на youpin ask и не выше buff ask
// (сам youpin/buff ask, без дополнительной скидки на потолке — скидка 5%
// закладывается только через skinbux-часть формулы).
// Если хотя бы одного из трёх чисел нет — цену не показываем вообще (ok:false),
// вместо неё на странице показывается контакт для ручного согласования: риск
// переплатить из-за неполных данных важнее, чем показать примерную цифру.
const SKINBUX_DISCOUNT = 0.05;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeSellQuote(row) {
  if (!row) return { ok: false };

  const skinbuxBid = row.prices?.skinbux?.bid;
  const buffAsk = row.prices?.buff?.ask;
  const youpinAsk = row.prices?.youpin?.ask;

  if (skinbuxBid == null || buffAsk == null || youpinAsk == null) {
    return { ok: false };
  }

  const base = skinbuxBid * (1 - SKINBUX_DISCOUNT);
  const cap = Math.min(buffAsk, youpinAsk);

  return { ok: true, price: round2(Math.min(base, cap)) };
}

module.exports = { computeSellQuote };
