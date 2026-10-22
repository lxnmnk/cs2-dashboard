// Реферальна програма для клієнтів: кожен, хто вже продав нам скін, отримує
// свій код і посилання gaben.market/<код>.
//
// Правила (їх же показує кабінет, див. public/referral.js):
//   - друг за кодом отримує +FRIEND_BONUS_PERCENT до ціни своїх продажів —
//     це наша знижка, зменшена на бонус, як у партнерських кодів;
//   - той, хто запросив, отримує відсоток від суми продажів друга — за
//     рівнем (LEVELS), який залежить від того, скільки продали всі його
//     друзі разом. Відсоток фіксується в момент продажу: новий рівень діє на
//     наступні продажі, минулі не перераховуються;
//   - тільки один рівень: з друзів друга нічого не нараховується;
//   - людина закріплюється назавжди за першим кодом, яким скористалась, і
//     тільки якщо ще нічого нам не продавала — інакше хтось "забрав би" собі
//     наших постійних клієнтів;
//   - нарахування стає доступним, коли Skinbux розморозив гроші за продаж
//     (status "completed", 7 днів захисту трейду). Відкат трейду (reverted)
//     чи скасування — нарахування зникає.
//
// Нарахування окремо не зберігаємо: відсоток і того, хто запросив, пишемо
// прямо в запис продажу (skinbuxSales: referrerSteamId, referralPercent), а
// суми рахуємо з журналу продажів. Так статус нарахування завжди збігається
// зі статусом самого продажу, і нема двох місць, що можуть розійтись.
//
// Тут зберігаємо тільки те, чого в журналі продажів немає: коди, хто кого
// привів, переходи за посиланням і заявки на виплату.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const skinbuxSales = require("./skinbuxSales");
const promoCodes = require("./promoCodes");

const FILE = path.join(__dirname, "referrals.json");

const FRIEND_BONUS_PERCENT = 1;
// Рівні — за сумою продажів усіх друзів (у доларах, без скасованих).
const LEVELS = [
  { key: "start", minVolume: 0, percent: 0.5 },
  { key: "silver", minVolume: 500, percent: 0.75 },
  { key: "gold", minVolume: 2000, percent: 1 },
];
const MIN_WITHDRAW = 10;
// Якщо реферальні гроші не виводити, а додати до виплати за свій продаж —
// +10%: гроші лишаються в обороті, нам це вигідніше за окремий переказ.
const SALE_TOPUP_BONUS_PERCENT = 10;

const ACCEPTED = new Set(["hold", "completed"]);

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { members: data.members || {}, clicks: data.clicks || {}, payouts: data.payouts || [] };
  } catch {
    return { members: {}, clicks: {}, payouts: [] };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normalize = (code) => String(code || "").trim().toLowerCase();

function member(data, steamId) {
  const key = String(steamId);
  if (!data.members[key]) data.members[key] = { codes: [], code: null, referredBy: null };
  return data.members[key];
}

/** Steam ID власника коду (і нинішнього, і старого — старі посилання працюють). */
function ownerOfCode(code, data = load()) {
  const key = normalize(code);
  if (!key) return null;
  for (const [steamId, m] of Object.entries(data.members)) {
    if ((m.codes || []).includes(key)) return steamId;
  }
  return null;
}

function isCodeTaken(code, data = load()) {
  const key = normalize(code);
  return (
    promoCodes.RESERVED.has(key) || !!promoCodes.find(key, { includeInactive: true }) || !!ownerOfCode(key, data)
  );
}

function acceptedSalesOf(steamId) {
  return skinbuxSales.loadAll().filter((s) => String(s.steamId) === String(steamId) && ACCEPTED.has(s.status));
}

/** Код дається тим, хто вже продав нам хоч щось — щоб не плодили порожні акаунти. */
function isEligible(steamId) {
  return acceptedSalesOf(steamId).length > 0;
}

// Код за замовчуванням — з ніка в Steam, якщо там є латиниця, інакше
// випадковий. Людина може змінити його на свій у кабінеті.
function suggestCode(displayName, data) {
  const base = String(displayName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const start = base.length >= 3 ? base : `gm${crypto.randomInt(1000, 9999)}`;
  let candidate = start;
  for (let i = 2; isCodeTaken(candidate, data); i++) candidate = `${start}${i}`.slice(0, 20);
  return candidate;
}

/** Видає код, якщо людина вже може його мати. Повертає код або null. */
function ensureCode(steamId, displayName) {
  const data = load();
  const m = member(data, steamId);
  if (m.code) return m.code;
  if (!isEligible(steamId)) return null;
  m.code = suggestCode(displayName, data);
  m.codes = [...(m.codes || []), m.code];
  m.codeCreatedAt = new Date().toISOString();
  save(data);
  return m.code;
}

/**
 * Свій код замість виданого. Старий не видаляємо: посилання з ним уже могли
 * розійтись, і за ними люди мають і далі закріплюватись за тим самим.
 */
function setCode(steamId, wanted) {
  const key = normalize(wanted);
  if (!promoCodes.CODE_RE.test(key)) throw new Error("CODE_FORMAT");
  const data = load();
  const m = member(data, steamId);
  if (!m.code) throw new Error("NOT_ELIGIBLE");
  if (m.codes.includes(key)) {
    m.code = key;
    save(data);
    return key;
  }
  if (isCodeTaken(key, data)) throw new Error("CODE_TAKEN");
  m.code = key;
  m.codes.push(key);
  save(data);
  return key;
}

function countClick(code) {
  const data = load();
  const key = normalize(code);
  if (!ownerOfCode(key, data)) return false;
  data.clicks[key] = (data.clicks[key] || 0) + 1;
  save(data);
  return true;
}

/**
 * Закріплює людину за тим, чий код вона використала. Тільки раз і тільки
 * нового клієнта. Повертає Steam ID того, хто запросив, або null.
 */
function bind(friendSteamId, code, via) {
  const data = load();
  const referrer = ownerOfCode(code, data);
  if (!referrer || referrer === String(friendSteamId)) return null;
  if (skinbuxSales.OWN_STEAM_IDS?.has?.(String(friendSteamId))) return null;

  const m = member(data, friendSteamId);
  if (m.referredBy) return m.referredBy;
  if (acceptedSalesOf(friendSteamId).length) return null;

  m.referredBy = referrer;
  m.referredAt = new Date().toISOString();
  m.referredVia = via === "link" ? "link" : "code";
  m.referredCode = normalize(code);
  save(data);
  return referrer;
}

function referrerOf(steamId) {
  return load().members[String(steamId)]?.referredBy || null;
}

function friendsOf(referrerSteamId, data = load()) {
  return Object.entries(data.members)
    .filter(([, m]) => m.referredBy === String(referrerSteamId))
    .map(([steamId, m]) => ({ steamId, ...m }));
}

/** Сума продажів усіх друзів — від неї рівень. */
function friendsVolume(referrerSteamId, data = load()) {
  const friends = new Set(friendsOf(referrerSteamId, data).map((f) => f.steamId));
  return round2(
    skinbuxSales
      .loadAll()
      .filter((s) => friends.has(String(s.steamId)) && ACCEPTED.has(s.status))
      .reduce((sum, s) => sum + (Number(s.totalPrice) || 0), 0)
  );
}

function levelFor(volume) {
  let level = LEVELS[0];
  for (const l of LEVELS) if (volume >= l.minVolume) level = l;
  const next = LEVELS[LEVELS.indexOf(level) + 1] || null;
  return { ...level, next: next ? { key: next.key, minVolume: next.minVolume, percent: next.percent } : null };
}

/**
 * Що записати в продаж друга: хто запросив і під яким відсотком.
 * null — продаж нічий.
 */
function accrualForSale(friendSteamId) {
  const referrer = referrerOf(friendSteamId);
  if (!referrer) return null;
  return { referrerSteamId: referrer, referralPercent: levelFor(friendsVolume(referrer)).percent };
}

const accrualAmount = (sale) => round2(((Number(sale.totalPrice) || 0) * (Number(sale.referralPercent) || 0)) / 100);

// Стан нарахування з продажу: поки обмін не прийнятий — ще нічого; холд —
// "чекає"; гроші розморожені — "доступно"; скасовано/відкат — "скасовано".
function accrualState(sale) {
  if (sale.status === "completed") return "available";
  if (sale.status === "hold") return "pending";
  if (["cancelled", "reverted", "failed", "expired"].includes(sale.status)) return "cancelled";
  return "waiting";
}

/**
 * Виплата "до свого продажу" дійсна, поки дійсний сам продаж: якщо його
 * скасували, гроші повертаються на реферальний баланс.
 */
function payoutCounts(payout, salesById) {
  if (payout.status === "rejected") return false;
  if (payout.method !== "sale") return true;
  const sale = salesById.get(String(payout.saleId));
  return !sale || !["cancelled", "reverted", "failed", "expired"].includes(sale.status);
}

function balanceOf(steamId, data = load()) {
  const sales = skinbuxSales.loadAll();
  const salesById = new Map(sales.map((s) => [String(s.id), s]));
  let pending = 0;
  let earned = 0;
  for (const s of sales) {
    if (s.referrerSteamId !== String(steamId)) continue;
    const state = accrualState(s);
    if (state === "available") earned += accrualAmount(s);
    else if (state === "pending") pending += accrualAmount(s);
  }
  const mine = data.payouts.filter((p) => p.steamId === String(steamId) && payoutCounts(p, salesById));
  const paidOut = mine.reduce((sum, p) => sum + p.amount, 0);
  const paid = mine.filter((p) => p.status === "paid" || p.method === "sale").reduce((sum, p) => sum + p.amount, 0);
  return {
    pending: round2(pending),
    available: round2(Math.max(0, earned - paidOut)),
    requested: round2(paidOut - paid),
    paid: round2(paid),
    earned: round2(earned),
  };
}

// У списку друзів показуємо нік наполовину: це чужі люди, і їхній повний
// нік тому, хто запросив, не потрібен.
function maskName(name) {
  const s = String(name || "").trim();
  if (s.length <= 3) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** Усе для кабінету одним запитом. */
function summary(steamId, { displayName, customerName } = {}) {
  const code = ensureCode(steamId, displayName);
  const data = load();
  const m = data.members[String(steamId)] || {};
  const sales = skinbuxSales.loadAll();

  const friends = friendsOf(steamId, data).map((f) => {
    const theirSales = sales.filter((s) => String(s.steamId) === f.steamId && s.referrerSteamId === String(steamId));
    const accepted = theirSales.filter((s) => ACCEPTED.has(s.status));
    return {
      name: maskName(customerName?.(f.steamId) || f.steamId),
      since: f.referredAt,
      deals: accepted.length,
      volume: round2(accepted.reduce((sum, s) => sum + (Number(s.totalPrice) || 0), 0)),
      income: round2(theirSales.filter((s) => accrualState(s) !== "cancelled").reduce((sum, s) => sum + accrualAmount(s), 0)),
    };
  });

  const accruals = sales
    .filter((s) => s.referrerSteamId === String(steamId) && accrualState(s) !== "waiting")
    .map((s) => ({
      at: s.heldAt || s.createdAt,
      friend: maskName(s.customerName),
      saleAmount: round2(s.totalPrice),
      percent: s.referralPercent,
      amount: accrualAmount(s),
      state: accrualState(s),
    }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  const volume = friendsVolume(steamId, data);
  const allCodes = new Set(m.codes || []);
  return {
    eligible: !!code,
    code,
    clicks: [...allCodes].reduce((sum, c) => sum + (data.clicks[c] || 0), 0),
    registered: friends.length,
    sold: friends.filter((f) => f.deals > 0).length,
    volume,
    level: levelFor(volume),
    levels: LEVELS,
    balance: balanceOf(steamId, data),
    friends: friends.sort((a, b) => new Date(b.since) - new Date(a.since)),
    accruals,
    payouts: data.payouts
      .filter((p) => p.steamId === String(steamId))
      .map(({ id, amount, method, network, status, createdAt, paidAt, bonus }) => ({ id, amount, method, network, status, createdAt, paidAt, bonus }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    rules: {
      friendBonusPercent: FRIEND_BONUS_PERCENT,
      minWithdraw: MIN_WITHDRAW,
      saleTopUpBonusPercent: SALE_TOPUP_BONUS_PERCENT,
    },
    referredBy: m.referredBy ? true : false,
  };
}

/** Заявка на вивід усього доступного в крипті. Гроші переказує власник руками. */
function requestWithdraw(steamId, { network, address }) {
  const data = load();
  const { available } = balanceOf(steamId, data);
  if (available < MIN_WITHDRAW) throw new Error("BELOW_MIN");
  const payout = {
    id: crypto.randomUUID(),
    steamId: String(steamId),
    amount: available,
    method: "crypto",
    network,
    address,
    status: "requested",
    createdAt: new Date().toISOString(),
  };
  data.payouts.push(payout);
  save(data);
  return payout;
}

/**
 * Реферальні гроші — до виплати за власний продаж, з бонусом. Повертає,
 * скільки додати до суми продажу (разом із бонусом), або 0, якщо нічого.
 */
function spendOnSale(steamId, saleId) {
  const data = load();
  const { available } = balanceOf(steamId, data);
  if (available <= 0) return 0;
  const bonus = round2((available * SALE_TOPUP_BONUS_PERCENT) / 100);
  data.payouts.push({
    id: crypto.randomUUID(),
    steamId: String(steamId),
    amount: available,
    bonus,
    method: "sale",
    saleId: String(saleId),
    status: "paid",
    createdAt: new Date().toISOString(),
    paidAt: new Date().toISOString(),
  });
  save(data);
  return round2(available + bonus);
}

function setPayoutStatus(id, status) {
  if (!["paid", "rejected", "requested"].includes(status)) throw new Error("Невідомий статус");
  const data = load();
  const payout = data.payouts.find((p) => p.id === id);
  if (!payout) throw new Error("Заявку не знайдено");
  if (payout.method === "sale") throw new Error("Виплата в рахунок продажу закривається разом із продажем");
  payout.status = status;
  payout.paidAt = status === "paid" ? new Date().toISOString() : null;
  save(data);
  return payout;
}

/** Для панелі власника: заявки на виплату й хто скільки привів. */
function ownerReport(customerName) {
  const data = load();
  const payouts = data.payouts
    .filter((p) => p.method !== "sale")
    .map((p) => ({ ...p, customerName: customerName(p.steamId) }))
    // Спершу ті, що чекають переказу, далі — новіші.
    .sort((a, b) => (b.status === "requested") - (a.status === "requested") || new Date(b.createdAt) - new Date(a.createdAt));
  const referrers = Object.entries(data.members)
    .filter(([, m]) => m.code)
    .map(([steamId, m]) => {
      const volume = friendsVolume(steamId, data);
      return {
        steamId,
        customerName: customerName(steamId),
        code: m.code,
        clicks: (m.codes || []).reduce((sum, c) => sum + (data.clicks[c] || 0), 0),
        friends: friendsOf(steamId, data).length,
        volume,
        percent: levelFor(volume).percent,
        balance: balanceOf(steamId, data),
      };
    })
    .filter((r) => r.friends || r.clicks || r.balance.earned)
    .sort((a, b) => b.volume - a.volume);
  return { payouts, referrers };
}

module.exports = {
  FRIEND_BONUS_PERCENT,
  LEVELS,
  MIN_WITHDRAW,
  ownerOfCode,
  ensureCode,
  setCode,
  countClick,
  bind,
  referrerOf,
  accrualForSale,
  summary,
  requestWithdraw,
  spendOnSale,
  setPayoutStatus,
  ownerReport,
  balanceOf,
};
