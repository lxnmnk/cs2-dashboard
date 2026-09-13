// Публічна котировка "скільки коштуватиме купівля скіна у нас" (клієнт
// купує) — сторінка public/buy-quote.html. Формула: youpin ask + 6%
// (націнка за посередництво/швидкість доставки). Якщо на youpin немає ask —
// пропозицію не показуємо (ok:false), як і в sellQuote.js.
const MARKUP = 0.06;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// markup можна перевизначити: у розділі Trade націнка нижча, бо там ми
// заробляємо ще й на боці клієнта (див. tradeCatalog.js).
function computeBuyQuote(row, { markup = MARKUP } = {}) {
  if (!row) return { ok: false };

  const youpinAsk = row.prices?.youpin?.ask;
  if (youpinAsk == null) return { ok: false };

  return { ok: true, price: round2(youpinAsk * (1 + markup)) };
}

module.exports = { computeBuyQuote };
