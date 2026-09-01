// Публічна котировка "скільки коштуватиме купівля скіна у нас" (клієнт
// купує) — сторінка public/buy-quote.html. Формула: youpin ask + 6%
// (націнка за посередництво/швидкість доставки). Якщо на youpin немає ask —
// пропозицію не показуємо (ok:false), як і в sellQuote.js.
const MARKUP = 0.06;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeBuyQuote(row) {
  if (!row) return { ok: false };

  const youpinAsk = row.prices?.youpin?.ask;
  if (youpinAsk == null) return { ok: false };

  return { ok: true, price: round2(youpinAsk * (1 + MARKUP)) };
}

module.exports = { computeBuyQuote };
