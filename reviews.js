// Відгуки клієнтів про угоди і живу стрічку продажів на головній.
//
// Відгук залишає тільки той, хто реально продав: угода його, і обмін
// прийнято (Skinbux: hold чи completed). Один відгук на угоду — його можна
// переписати, але не додати другий. Публікується одразу: стрічка показує
// відгуки як є, і погані теж — інакше це вже не відгуки. Власник може
// сховати відгук, якщо там образи чи спам (не за те, що він поганий).
//
// Стрічка — останні прийняті угоди: що продали, за скільки і коли, з ніком
// наполовину замаскованим. Усі угоди через сайт, разом з нашими акаунтами й
// TARHUN — так вирішив власник; не потрапляють лише скасовані й відкати.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const skinbuxSales = require("./skinbuxSales");

const FILE = path.join(__dirname, "reviews.json");
const ACCEPTED = new Set(["hold", "completed"]);
const TEXT_MAX = 500;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Нік у стрічці — наполовину: людям видно, що це жива людина, але чужий
// Steam-нік повністю ми нікому не показуємо.
function maskName(name) {
  const s = String(name || "").trim();
  if (!s) return "***";
  if (s.length <= 3) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * Залишити або переписати відгук на свою угоду.
 * Повертає збережений відгук або кидає помилку з кодом.
 */
function upsert(steamId, { saleId, rating, text, displayName }) {
  const sale = skinbuxSales.loadAll().find((s) => String(s.id) === String(saleId));
  if (!sale || String(sale.steamId) !== String(steamId)) throw new Error("SALE_NOT_FOUND");
  if (!ACCEPTED.has(sale.status)) throw new Error("SALE_NOT_ACCEPTED");

  const stars = Math.round(Number(rating));
  if (!(stars >= 1 && stars <= 5)) throw new Error("RATING_RANGE");
  const body = String(text || "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);

  const list = load();
  const now = new Date().toISOString();
  let review = list.find((r) => String(r.saleId) === String(saleId));
  if (review) {
    Object.assign(review, { rating: stars, text: body, updatedAt: now });
  } else {
    review = {
      id: crypto.randomUUID(),
      saleId: String(saleId),
      steamId: String(steamId),
      name: displayName || sale.customerName || "",
      rating: stars,
      text: body,
      hidden: false,
      createdAt: now,
      updatedAt: now,
    };
    list.push(review);
  }
  save(list);
  return review;
}

/** Відгуки по номеру угоди — щоб показати людині її власні в "Моїх угодах". */
function bySaleIds(ids) {
  const wanted = new Set(ids.map(String));
  return new Map(load().filter((r) => wanted.has(r.saleId)).map((r) => [r.saleId, r]));
}

function setHidden(id, hidden) {
  const list = load();
  const review = list.find((r) => r.id === id);
  if (!review) throw new Error("Відгук не знайдено");
  review.hidden = !!hidden;
  save(list);
  return review;
}

/** Усі відгуки для панелі власника — разом зі схованими. */
function listAll() {
  return load().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

const isClientSale = (s) => ACCEPTED.has(s.status);

/**
 * Один продавець — не більше половини стрічки. Інакше, коли хтось продає
 * багато (TARHUN), стрічка складалась з нього одного: 7 угод з 8. Йдемо від
 * нових до старих і беремо угоду, тільки якщо з нею частка цього продавця не
 * перевищить 50% уже показаного — тож і на першій сторінці, і далі.
 */
function capPerSeller(sales) {
  const perSeller = new Map();
  const kept = [];
  for (const s of sales) {
    const key = String(s.steamId);
    const mine = perSeller.get(key) || 0;
    // Перша угода продавця проходить завжди (інакше перша ж угода стрічки —
    // це "100%" і не пройшла б ніяка), далі — не більше половини показаного.
    if (mine > 0 && (mine + 1) * 2 > kept.length + 1) continue;
    perSeller.set(key, mine + 1);
    kept.push(s);
  }
  return kept;
}

/**
 * Стрічка для головної: останні прийняті угоди клієнтів і загальні цифри.
 * withReviews — тільки угоди з відгуком (вкладка "Відгуки").
 * imageOf(name) — картинка предмета (steamImages), передає сервер.
 */
async function feed({ limit = 12, offset = 0, withReviews = false, imageOf }) {
  const reviews = load().filter((r) => !r.hidden);
  const reviewBySale = new Map(reviews.map((r) => [r.saleId, r]));
  let sales = skinbuxSales
    .loadAll()
    .filter(isClientSale)
    .sort((a, b) => new Date(b.heldAt || b.createdAt) - new Date(a.heldAt || a.createdAt));
  const dealsTotal = sales.length;
  if (withReviews) sales = sales.filter((s) => reviewBySale.has(String(s.id)));
  sales = capPerSeller(sales);

  const page = sales.slice(offset, offset + limit);
  const items = await Promise.all(
    page.map(async (s) => {
      // Однакові предмети в угоді — одним рядком з кількістю.
      const counts = new Map();
      for (const it of s.items || []) {
        const g = counts.get(it.name) || { qty: 0, float: it.float ?? null };
        g.qty += 1;
        counts.set(it.name, g);
      }
      const goods = await Promise.all(
        [...counts].map(async ([name, g]) => ({
          name,
          qty: g.qty,
          // Float показуємо лише для одиночного предмета: у трьох однакових
          // він у кожного свій.
          float: g.qty === 1 ? g.float : null,
          image: imageOf ? await imageOf(name) : null,
        }))
      );
      const review = reviewBySale.get(String(s.id));
      return {
        at: s.heldAt || s.createdAt,
        who: maskName(s.customerName),
        kind: s.kind === "trade" ? "trade" : "sell",
        total: round2(s.totalPrice),
        items: goods,
        review: review ? { rating: review.rating, text: review.text, at: review.createdAt } : null,
      };
    })
  );

  const ratings = reviews.map((r) => r.rating);
  return {
    stats: {
      deals: dealsTotal,
      reviews: ratings.length,
      rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    },
    items,
    hasMore: offset + limit < sales.length,
  };
}

module.exports = { upsert, bySaleIds, setHidden, listAll, feed, maskName, TEXT_MAX };
