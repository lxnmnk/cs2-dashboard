// Промокоди й партнерські посилання — щоб реклама рахувалась, а не відчувалась.
//
// Один код працює одразу двома способами:
//   gaben.market/sicarios — посилання, яке можна дати команді чи стрімеру.
//     Перехід рахується і кладе код у cookie на 90 днів, тож людина, що
//     прийшла сьогодні й продала скін через тиждень, усе одно зарахується.
//   SICARIOS — той самий код руками в кошику, для тих, хто прийшов не за
//     посиланням, а почув його на стрімі.
//
// Що дає код:
//   bonusPercent    — наскільки більше отримає клієнт за свої скіни. Це наша
//                     знижка, зменшена на цей відсоток, тобто платимо з
//                     власної маржі.
//   partnerPercent  — яка частка нашої маржі належить партнеру за приведеного
//                     клієнта. Нічого не переказує саме: це число для звіту,
//                     за яким власник платить руками.
//
// Файл навмисно простий (JSON поруч із рештою даних): кодів буде десяток, не
// мільйон, і окрема база тут була б складністю заради складності.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "promoCodes.json");

// Скільки днів код живе в cookie після переходу. 90 — бо скіни продають не в
// день, коли вперше побачили сайт: людина приходить, дивиться ціни, і
// повертається, коли надумає.
const COOKIE_DAYS = 90;
const COOKIE_NAME = "promo";

// Код = і адреса посилання, і те, що вводять руками. Тому дозволяємо тільки
// те, що не ламається в URL і що неможливо переплутати на слух.
const CODE_RE = /^[a-z0-9_-]{3,20}$/i;

// Адреси, які вже зайняті сторінками сайту: кодом їх займати не можна,
// інакше посилання перекриє сторінку.
const RESERVED = new Set([
  "account", "profile", "trade", "buy", "sell", "my-skins", "arbitrage",
  "mytrades", "capital", "login", "ru", "en", "ua", "api", "auth", "uploads",
]);

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveAll(codes) {
  fs.writeFileSync(FILE, JSON.stringify(codes, null, 2));
}

function normalize(code) {
  return String(code || "").trim().toLowerCase();
}

/** Код за назвою, незалежно від регістру. null — такого немає або вимкнений. */
function find(code, { includeInactive = false } = {}) {
  const key = normalize(code);
  if (!key) return null;
  const found = loadAll().find((c) => c.code === key);
  if (!found) return null;
  if (!found.active && !includeInactive) return null;
  return found;
}

function upsert({ code, name, bonusPercent, partnerPercent, active }) {
  const key = normalize(code);
  if (!CODE_RE.test(key)) throw new Error("Код — 3–20 латинських літер, цифр, дефіс або підкреслення");
  if (RESERVED.has(key)) throw new Error(`"${key}" — це адреса сторінки сайту, кодом її зайняти не можна`);

  const bonus = Number(bonusPercent);
  const partner = Number(partnerPercent);
  if (!Number.isFinite(bonus) || bonus < 0 || bonus > 20) throw new Error("Бонус клієнту — від 0 до 20%");
  if (!Number.isFinite(partner) || partner < 0 || partner > 100) throw new Error("Частка партнера — від 0 до 100%");

  const codes = loadAll();
  const existing = codes.find((c) => c.code === key);
  const record = {
    code: key,
    name: String(name || "").slice(0, 80),
    bonusPercent: bonus,
    partnerPercent: partner,
    active: active !== false,
    clicks: existing?.clicks || 0,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  if (existing) Object.assign(existing, record);
  else codes.push(record);
  saveAll(codes);
  return record;
}

function remove(code) {
  const key = normalize(code);
  const codes = loadAll();
  if (!codes.some((c) => c.code === key)) throw new Error("Код не знайдено");
  saveAll(codes.filter((c) => c.code !== key));
}

/** Перехід за посиланням. Рахуємо навіть вимкнені — цікаво, що ними ще ходять. */
function countClick(code) {
  const key = normalize(code);
  const codes = loadAll();
  const found = codes.find((c) => c.code === key);
  if (!found) return null;
  found.clicks = (found.clicks || 0) + 1;
  saveAll(codes);
  return found;
}

/**
 * Звіт по кожному коду: скільки переходів, скільки з них вийшло угод і
 * скільки на цьому заробили ми й партнер.
 *
 * Наша маржа з угоди — різниця між тим, що заплатив Skinbux, і тим, що ми
 * віддали клієнту. Бонус за промокодом уже сидить усередині виплати клієнту,
 * тобто вираховується з нашої ж маржі, а не додається згори.
 */
function report(sales) {
  const byCode = new Map(loadAll().map((c) => [c.code, { ...c, deals: 0, volume: 0, margin: 0, customers: new Set() }]));

  for (const sale of sales) {
    const key = normalize(sale.promoCode);
    const row = byCode.get(key);
    if (!row) continue;
    if (["cancelled", "reverted"].includes(sale.status)) continue;

    const skinbux = (sale.items || []).reduce((sum, it) => {
      if (it.skinbuxCents != null) return sum + Number(it.skinbuxCents) / 100;
      if (it.skinbuxBid != null) return sum + Number(it.skinbuxBid);
      return sum;
    }, 0);
    row.deals++;
    row.volume = round2(row.volume + (Number(sale.totalPrice) || 0));
    row.margin = round2(row.margin + (skinbux - (Number(sale.totalPrice) || 0)));
    if (sale.steamId) row.customers.add(String(sale.steamId));
  }

  return [...byCode.values()]
    .map((row) => ({
      ...row,
      customers: row.customers.size,
      // Скільки належить партнеру за приведених людей.
      partnerDue: round2((row.margin * (Number(row.partnerPercent) || 0)) / 100),
    }))
    .sort((a, b) => b.margin - a.margin);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { loadAll, find, upsert, remove, countClick, report, normalize, COOKIE_NAME, COOKIE_DAYS, CODE_RE, RESERVED };
