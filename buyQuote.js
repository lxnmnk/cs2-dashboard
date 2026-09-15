// Публічна котировка "скільки коштуватиме купівля скіна у нас" (клієнт
// купує) — сторінка public/buy-quote.html. Формула: youpin ask + націнка,
// яку власник задає в панелі (/mytrades, pricingSettings.js); тут лишається
// лише запасне значення на випадок, коли її не передали. Якщо на youpin немає ask —
// пропозицію не показуємо (ok:false), як і в sellQuote.js.
const MARKUP = 0;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// markup приходить із налаштувань панелі: у "Купити скіни" і у вітрині Trade
// вони різні (див. pricingSettings.js).
function computeBuyQuote(row, { markup = MARKUP } = {}) {
  if (!row) return { ok: false };

  const youpinAsk = row.prices?.youpin?.ask;
  if (youpinAsk == null) return { ok: false };

  return { ok: true, price: round2(youpinAsk * (1 + markup)) };
}

module.exports = { computeBuyQuote };
