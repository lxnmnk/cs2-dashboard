// Автовиплата клієнтам у крипті — з гаманця Binance власника (binanceWallet.js).
//
// Раніше гроші виводились клієнтам прямо з мерчант-балансу Skinbux. Skinbux
// так робити не дозволяє (лише на власний гаманець, 21.11.2026), тому:
// Skinbux -> наш Binance — руками власника, Binance -> клієнт — тут.
//
// Клієнт при продажі сам вказує, куди платити (payoutDetails: мережа й
// адреса). Коли угода виходить із холду (skinbuxSales.payableNow), сервер
// виводить гроші з Binance на його адресу і позначає угоду виплаченою.
// Власнику — повідомлення "виплачено". Картки лишаються ручними: "можно
// платить" у Telegram. Лімітів суми немає (так вирішив власник): платимо
// стільки, скільки винні.
//
// Скільки платимо: борг за угоду, але не більше за "доступно" клієнта на
// сайті — частину він міг уже витратити на скіни з вітрини. Тоді угоду все
// одно закриваємо (markPaid), а різницю повертаємо поправкою в available,
// щоб баланс зійшовся: було A, стало A − виплачено.
// Комісію мережі платить клієнт: Binance бере її з суми виводу, і ми
// показуємо реальну комісію Binance для цієї мережі.
//
// На Binance не вистачає грошей чи мережа на паузі — угода чекає (статус
// "waiting"), власнику одне повідомлення "поповни Binance". "Можно платить"
// у цей час не шлемо: інакше власник заплатив би руками, а потім заплатив би
// й автомат. Хоче заплатити сам — відмічає угоду виплаченою в My Trades.
//
// Ідемпотентність: withdrawOrderId = "sale-<id>". Таймаут чи 5xx — вивід
// міг створитись, тому НЕ повторюємо, а шукаємо його в історії Binance за
// цим id. Не з'явився за 30 хвилин — віддаємо власнику перевірити руками.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const skinbuxSales = require("./skinbuxSales");
const customerBalances = require("./customerBalances");
const payoutDetails = require("./payoutDetails");
const binance = require("./binanceWallet");
const refill = require("./binanceRefill");

const PAIRS = binance.NETWORKS;

// Нестача на Binance: увімкнене автопоповнення (binanceRefill.js) — саме
// виводить її зі Skinbux; ні — одне повідомлення "поповни Binance".
// Про порожній Skinbux пишемо раз на суму, а не кожен прохід.
const lastShortNotice = new Map();
async function coverShortfall(config, demand, notify) {
  for (const [coin, need] of Object.entries(demand)) {
    if (need <= 0) continue;
    let res;
    try {
      res = await refill.ensure(config, coin, need, { notify });
    } catch (err) {
      res = { started: false, reason: "error", error: err.message };
    }
    if (res.started || res.inFlight || res.reason === "enough") {
      lastShortNotice.delete(coin);
      continue;
    }
    const key = `${res.reason}-${round2(need)}`;
    if (lastShortNotice.get(coin) === key) continue;
    lastShortNotice.set(coin, key);
    const why =
      res.reason === "skinbux-empty"
        ? `автопополнение не может: на Skinbux доступно ${money(res.skinbuxAvailable)}, нужно вывести ${money(res.amount)}`
        : res.reason === "error"
        ? `автопополнение не сработало: ${res.error}`
        : res.reason === "off"
        ? "автопополнение со Skinbux выключено"
        : "пополнение не прошло";
    notify(`💰 Для выплат нужно ${money(need)} ${coin} на Binance — ${why}. Пополни Binance вручную, выплаты уйдут сами.`).catch(() => {});
  }
}
const UNKNOWN_GIVE_UP_MS = 30 * 60 * 1000;

const DEFAULTS = {
  enabled: false,
  // Тестовий режим: нічого не виводимо, лише пишемо власнику, що вивели б.
  dryRun: true,
  // Вивід за кнопкою клієнта (профіль → Баланс). Тестовий режим dryRun на
  // нього не діє: клієнт сам натиснув і чекає гроші.
  clientWithdraw: false,
  // Менше — не виводимо автоматично (комісія з'їсть усе), лишаємо вручну.
  minUsd: 15,
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${round2(n).toFixed(2)}`;

function settings(config) {
  return { ...DEFAULTS, ...(config.cryptoPayout || {}) };
}

/** Мережа угоди, якщо її можна виплатити з Binance. */
function pairFor(sale) {
  const d = sale.payoutDetails;
  if (!d || d.method !== "crypto") return null;
  return PAIRS[d.network] || null;
}

/** Мережі для форми виводу в профілі: лише відкриті в Binance, з її комісією. */
async function networksForClient() {
  const out = [];
  for (const [id, p] of Object.entries(PAIRS)) {
    let q = null;
    try {
      q = await binance.quote(id);
    } catch {
      q = binance.cachedQuote(id);
    }
    if (!q || !q.enabled) continue;
    out.push({ id, label: p.label, fee: round2(q.fee), min: q.min });
  }
  return out;
}

// ---- Автовиплата угод ----

/** Вивід прийнято Binance: закриваємо угоду, різницю повертаємо поправкою. */
function closeSale(sale, { owed, pay, fee, send, label, address, withdrawal, notify }) {
  skinbuxSales.markPaid(sale.id);
  let adjustmentId = null;
  if (owed - pay > 0.009) {
    adjustmentId = customerBalances.add({
      steamId: sale.steamId,
      amount: round2(owed - pay),
      bucket: "available",
      note: `Сделка #${sale.id}: ${money(owed - pay)} клиент уже потратил на сайте — выплачено ${money(pay)} автоматически`,
      by: "auto-payout",
    }).id;
  }
  skinbuxSales.setAutoPayout(sale.id, {
    status: withdrawal.status || "pending",
    withdrawalId: withdrawal.id ?? null,
    txId: withdrawal.txId || null,
    adjustmentId,
    paidAt: new Date().toISOString(),
  });
  notify(
    `💸 Выплачено автоматически с Binance — сделка #${sale.id}, клиент ${sale.customerName || sale.steamId}\n` +
      `${money(send)} дойдёт (${label}, комиссия сети ${money(fee)} с клиента)${pay < owed ? `, ${money(owed - pay)} клиент потратил на скины` : ""}\n` +
      `${address}\nBinance вывод #${withdrawal.id ?? "?"}`
  ).catch(() => {});
}

/** Угода чекає (немає грошей на Binance / мережа на паузі): одне повідомлення на причину. */
function waitSale(sale, reason, text, notify) {
  const ap = sale.autoPayout || {};
  skinbuxSales.setAutoPayout(sale.id, { status: "waiting", reason });
  if (ap.status === "waiting" && ap.reason === reason) return;
  notify(text).catch(() => {});
}

/**
 * Вивід по угоді в невідомому стані (таймаут / впали посеред запиту):
 * шукаємо в історії Binance. Знайшли — як звичайний успіх чи відмова.
 */
async function resolveUnknownSale(sale, ctx) {
  const ap = sale.autoPayout;
  let found;
  try {
    found = await binance.findWithdrawal(ap.key, ap.requestedAt);
  } catch {
    return; // Binance недоступний — наступного проходу
  }
  const label = PAIRS[ap.networkId]?.label || ap.networkId;
  if (found && ["failed", "rejected"].includes(found.status)) {
    skinbuxSales.setAutoPayout(sale.id, { status: "failed", error: `Binance: ${found.status}${found.info ? ` (${found.info})` : ""}` });
    ctx.notify(`❌ Автовыплата по сделке #${sale.id} не прошла в Binance (${found.status}). Деньги на Binance, придёт «можно платить» — заплати вручную.`).catch(() => {});
    return;
  }
  if (found) {
    closeSale(sale, { owed: skinbuxSales.amountOwed(sale), pay: ap.pay, fee: ap.fee, send: ap.send, label, address: ap.address, withdrawal: found, notify: ctx.notify });
    return;
  }
  if (Date.now() - new Date(ap.requestedAt).getTime() > UNKNOWN_GIVE_UP_MS) {
    skinbuxSales.setAutoPayout(sale.id, { status: "failed", error: "вывод не найден в истории Binance" });
    ctx.notify(
      `⚠️ Автовыплата по сделке #${sale.id}: Binance не ответил, и за 30 минут вывода ${ap.key} нет в его истории.\n` +
        `Проверь в Binance → История выводов. Нет вывода — заплати вручную (${label}, ${ap.address}, ${money(ap.pay)}). Есть — отметь сделку выплаченной в My Trades.`
    ).catch(() => {});
  }
}

/**
 * Один прохід. getAvailable(steamId) — "доступно" клієнта на сайті (з
 * поправками й покупками). notify(text) — власнику.
 * Повертає Set id угод, які взялись автоматом (їм "можно платить" не шлемо).
 */
async function run(config, { getAvailable, notify = async () => {} }) {
  const cfg = settings(config);
  const handled = new Set();
  if (!cfg.enabled || !binance.configured()) return handled;
  const ctx = { notify };
  // Залишок на Binance — свіжий на кожен прохід: власник міг щойно поповнити.
  binance.invalidate();
  // Скільки якої монети бракує на Binance (угоди + холди + черга кнопки).
  const demand = queuedClientDemand();

  // 1. Угоди, що вийшли з холду.
  for (const sale of skinbuxSales.payableNow()) {
    if (skinbuxSales.OWN_STEAM_IDS.has(String(sale.steamId))) continue;
    const pair = pairFor(sale);
    if (!pair) continue;
    const ap = sale.autoPayout;
    // Записи старої автовиплати через Skinbux — не наші, не чіпаємо.
    if (ap && ap.key && ap.provider !== "binance") continue;
    if (ap && ["failed", "manual"].includes(ap.status)) continue;
    if (ap && cfg.dryRun && ap.status === "dry-run") continue;
    if (ap && ["requesting", "unknown"].includes(ap.status)) {
      handled.add(String(sale.id));
      await resolveUnknownSale(sale, ctx);
      continue;
    }

    const networkId = sale.payoutDetails.network;
    const address = sale.payoutDetails.address;
    const owed = skinbuxSales.amountOwed(sale);
    const pay = round2(Math.min(owed, Math.max(0, getAvailable(sale.steamId))));
    const where = `${pair.label} · ${address}`;

    let q;
    try {
      q = await binance.quote(networkId);
    } catch (err) {
      handled.add(String(sale.id));
      waitSale(sale, "binance-down", `⚠️ Автовыплата по сделке #${sale.id} ждёт: Binance не ответил (${err.message}). Повторю сам, вручную не плати.`, notify);
      continue;
    }
    if (!q) {
      skinbuxSales.setAutoPayout(sale.id, { status: "manual", reason: `Binance не выводит ${pair.label}` });
      continue; // прийде звичайне "можно платить"
    }
    const fee = round2(q.fee);
    const send = round2(pay - fee);
    const min = Math.max(cfg.minUsd, q.min);
    if (pay < min || send <= 0) {
      skinbuxSales.setAutoPayout(sale.id, { status: "manual", reason: `к выплате ${money(pay)} — меньше минимума ${money(min)}` });
      continue;
    }
    if (!q.enabled) {
      handled.add(String(sale.id));
      waitSale(sale, "network-off", `⏸ Автовыплата по сделке #${sale.id} ждёт: Binance сейчас закрыл вывод ${pair.label}. Выплачу, когда откроет.`, notify);
      continue;
    }
    if (q.free + 0.001 < pay) {
      // Чекає грошей на Binance; нестачу по всіх угодах покриваємо разом
      // після циклу (coverShortfall). Хоче заплатити сам — відмічає угоду
      // виплаченою в My Trades.
      handled.add(String(sale.id));
      skinbuxSales.setAutoPayout(sale.id, { status: "waiting", reason: `funds-${pair.coin}` });
      demand[pair.coin] = round2((demand[pair.coin] || 0) + pay);
      continue;
    }

    if (cfg.dryRun) {
      skinbuxSales.setAutoPayout(sale.id, { status: "dry-run", pay, fee, send });
      notify(
        `🧪 ТЕСТ автовыплаты с Binance (ничего не отправлено): сделка #${sale.id}, клиент ${sale.customerName || sale.steamId}\n` +
          `Долг ${money(owed)}, к выплате ${money(pay)}, комиссия сети ${money(fee)} → дойдёт ${money(send)}\n${where}\n` +
          `Плати как обычно вручную. Включить по-настоящему: config.json → cryptoPayout.dryRun: false`
      ).catch(() => {});
      continue;
    }

    const key = `sale-${sale.id}`;
    skinbuxSales.setAutoPayout(sale.id, { provider: "binance", key, networkId, address, pay, fee, send, status: "requesting", requestedAt: new Date().toISOString() });
    handled.add(String(sale.id));
    let w;
    try {
      w = await binance.withdraw({ networkId, address, amount: pay, orderId: key });
    } catch (err) {
      if (err.ambiguous) {
        skinbuxSales.setAutoPayout(sale.id, { status: "unknown", error: err.message });
        notify(`⚠️ Автовыплата по сделке #${sale.id}: ${err.message}. Проверю по истории Binance — двойной выплаты не будет. Вручную НЕ плати.`).catch(() => {});
      } else {
        handled.delete(String(sale.id));
        skinbuxSales.setAutoPayout(sale.id, { status: "failed", error: err.message, code: err.code });
        notify(`❌ Автовыплата по сделке #${sale.id} не прошла: Binance ответил «${err.message}».\nЗаплати вручную как обычно: ${where}, ${money(pay)}`).catch(() => {});
      }
      continue;
    }
    closeSale(sale, { owed, pay, fee, send, label: pair.label, address, withdrawal: { id: w.id, status: "pending" }, notify });
  }

  // 2. Уже створені виводи по угодах: статус з історії Binance.
  for (const sale of skinbuxSales.loadAll()) {
    const ap = sale.autoPayout;
    if (!ap || ap.provider !== "binance" || !sale.paidAt || !["pending", "processing"].includes(ap.status)) continue;
    let found;
    try {
      found = await binance.findWithdrawal(ap.key, ap.requestedAt);
    } catch {
      continue;
    }
    if (!found || found.status === ap.status) continue;
    skinbuxSales.setAutoPayout(sale.id, { status: found.status, txId: found.txId, withdrawalId: found.id ?? ap.withdrawalId });
    if (found.status === "failed" || found.status === "rejected") {
      // Гроші лишились на Binance — угода знову невиплачена.
      skinbuxSales.unmarkPaid(sale.id);
      if (ap.adjustmentId) {
        try {
          customerBalances.remove(sale.steamId, ap.adjustmentId);
        } catch {
          // поправку могли вже прибрати руками
        }
      }
      skinbuxSales.setAutoPayout(sale.id, { status: "failed" });
      notify(
        `❌ Binance ${found.status === "rejected" ? "отклонил" : "не смог выполнить"} автовыплату по сделке #${sale.id}${found.info ? `: ${found.info}` : ""}. ` +
          `Деньги остались на Binance, сделка снова «не выплачена» — заплати вручную.`
      ).catch(() => {});
    }
  }

  // 3. Ручні холди власника з датою виходу й автовиплатою.
  await runHoldReleases(cfg, { getAvailable, notify, demand });

  // 4. Нестача на Binance — поповнюємо зі Skinbux (або просимо власника).
  await coverShortfall(config, demand, notify);
  return handled;
}

// ---- Виводи, записані в cryptoWithdrawals.json (кнопка клієнта й холди) ----
const WD_FILE = path.join(__dirname, "cryptoWithdrawals.json");

function loadWd() {
  try {
    const d = JSON.parse(fs.readFileSync(WD_FILE, "utf8"));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
function saveWd(list) {
  fs.writeFileSync(WD_FILE, JSON.stringify(list, null, 2));
}
function updateWd(id, patch) {
  const all = loadWd();
  const w = all.find((x) => x.id === id);
  if (!w) return null;
  Object.assign(w, patch, { updatedAt: new Date().toISOString() });
  saveWd(all);
  return w;
}

class WithdrawError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Куди платити клієнту: реквізити з останньої продажі, інакше останній вивід. */
function cryptoDetailsFor(steamId) {
  const last = skinbuxSales.lastPayout(String(steamId));
  if (last?.details?.method === "crypto" && PAIRS[last.details.network] && last.details.address) {
    return { network: last.details.network, address: last.details.address };
  }
  const w = loadWd()
    .filter((x) => x.steamId === String(steamId) && PAIRS[x.network] && x.address && !["failed", "rejected"].includes(x.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return w ? { network: w.network, address: w.address } : null;
}

/** Списати W з балансу клієнта: закрити угоди + поправка на решту. */
function debit(steamId, amount, note) {
  let left = round2(amount);
  const closed = [];
  const payable = skinbuxSales
    .payableNow()
    .filter((s) => String(s.steamId) === String(steamId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const sale of payable) {
    const owed = skinbuxSales.amountOwed(sale);
    if (owed > left + 0.001) break;
    skinbuxSales.markPaid(sale.id);
    closed.push(String(sale.id));
    left = round2(left - owed);
  }
  let adjustmentId = null;
  if (left > 0.001) {
    adjustmentId = customerBalances.add({ steamId, amount: -left, bucket: "available", note, by: "withdraw" }).id;
  }
  return { closed, adjustmentId };
}

function undoDebit(w) {
  for (const id of w.closedSales || []) skinbuxSales.unmarkPaid(id);
  if (w.adjustmentId) {
    try {
      customerBalances.remove(w.steamId, w.adjustmentId);
    } catch {
      // поправку могли прибрати руками
    }
  }
}

/**
 * Створити запис і вивід у Binance. Повертає { w, error }:
 * error.ambiguous — невідомо, чи створено (статус "unknown", доведе sync).
 */
async function sendRecorded(record) {
  const all = loadWd();
  all.push(record);
  saveWd(all);
  try {
    const r = await binance.withdraw({ networkId: record.network, address: record.address, amount: record.amount, orderId: record.key });
    return { w: updateWd(record.id, { status: "pending", withdrawalId: r.id }) };
  } catch (err) {
    if (err.ambiguous) return { w: updateWd(record.id, { status: "unknown", error: err.message }), error: err };
    const w = updateWd(record.id, { status: "failed", error: err.message, code: err.code ?? null });
    undoDebit(w);
    return { w, error: err };
  }
}

/**
 * Власник поставив клієнту +$X у hold на N днів з автовиплатою (продав його
 * скін сам). Коли холд вийшов — виводимо рівно цю суму (не більше за
 * "доступно") на криптореквізити клієнта. Вивід пишемо в cryptoWithdrawals
 * як звичайний вивід клієнта: syncClientWithdrawals стежить за статусом і
 * при відмові повертає гроші на баланс; клієнт бачить вивід у профілі.
 */
async function runHoldReleases(cfg, { getAvailable, notify, demand = {} }) {
  for (const { steamId, entry } of customerBalances.releasedAutoPayouts()) {
    if (!["waiting", "waiting-funds"].includes(entry.autoPayout?.status)) continue;
    const set = (patch) => customerBalances.update(steamId, entry.id, { autoPayout: { ...entry.autoPayout, ...patch, updatedAt: new Date().toISOString() } });
    const label = `холд ${money(entry.amount)} клиента ${steamId}${entry.note ? ` («${entry.note}»)` : ""}`;

    const details = cryptoDetailsFor(steamId);
    if (!details) {
      set({ status: "no-details" });
      notify(`ℹ️ Вышел ${label}, но у клиента нет крипто-реквизитов. Деньги у него в «доступно» — заплати вручную.`).catch(() => {});
      continue;
    }
    const pair = PAIRS[details.network];
    let q;
    try {
      q = await binance.quote(details.network);
    } catch {
      continue; // Binance недоступний — наступного проходу
    }
    const pay = round2(Math.min(entry.amount, Math.max(0, getAvailable(steamId))));
    const fee = round2(q?.fee ?? 0);
    const send = round2(pay - fee);
    const where = `${pair.label} · ${details.address}`;
    const min = Math.max(cfg.minUsd, q?.min || 0);
    if (!q || pay < min || send <= 0) {
      set({ status: "manual", reason: q ? `доступно ${money(pay)} — меньше минимума ${money(min)}` : `Binance не выводит ${pair.label}` });
      notify(`ℹ️ Вышел ${label}: автоматически не плачу (${q ? `к выплате ${money(pay)}, минимум ${money(min)}` : `Binance не выводит ${pair.label}`}). Деньги у клиента в «доступно».`).catch(() => {});
      continue;
    }
    if (!q.enabled) {
      if (entry.autoPayout.status !== "waiting-funds") {
        notify(`⏸ Вышел ${label}, но Binance закрыл вывод ${pair.label}. Выплачу сам, когда откроет.`).catch(() => {});
      }
      set({ status: "waiting-funds" });
      continue;
    }
    if (q.free + 0.001 < pay) {
      // Нестачу покриває coverShortfall після проходу.
      demand[pair.coin] = round2((demand[pair.coin] || 0) + pay);
      set({ status: "waiting-funds" });
      continue;
    }
    if (cfg.dryRun) {
      set({ status: "dry-run", pay, fee, send });
      notify(`🧪 ТЕСТ (ничего не отправлено): вышел ${label} → дошло бы ${money(send)} (комиссия сети ${money(fee)})\n${where}`).catch(() => {});
      continue;
    }

    const id = crypto.randomUUID();
    const adjustmentId = customerBalances.add({
      steamId,
      amount: -pay,
      bucket: "available",
      note: `Автовыплата холда ${money(pay)} ${pair.label} (#${id.slice(0, 8)})`,
      by: "hold-payout",
    }).id;
    const now = new Date().toISOString();
    set({ status: "sent", withdrawId: id, pay, fee, send });
    const { error } = await sendRecorded({
      id, steamId: String(steamId), network: details.network, address: details.address, amount: pay, fee, send,
      key: `hold-${entry.id}`, provider: "binance", requestedAt: now, closedSales: [], adjustmentId,
      source: "hold", entryId: entry.id, status: "requesting", createdAt: now, updatedAt: now,
    });
    if (error && !error.ambiguous) {
      set({ status: "failed", error: error.message });
      notify(`❌ Автовыплата холда не прошла: Binance ответил «${error.message}».\n${label}: деньги у клиента в «доступно», заплати вручную: ${where}, ${money(pay)}`).catch(() => {});
    } else if (error) {
      notify(`⚠️ Автовыплата холда клиенту ${steamId} ${money(pay)}: ${error.message}. Проверю по истории Binance — двойной выплаты не будет. Вручную НЕ плати.`).catch(() => {});
    } else {
      notify(`💸 Выплачен холд автоматически с Binance: ${label}\nдойдёт ${money(send)} (${pair.label}, комиссия сети ${money(fee)} с клиента)\n${details.address}`).catch(() => {});
    }
  }
}

// ---- Вивід за кнопкою клієнта ("Вивести" у профілі → Баланс) ----
// Клієнт сам обирає суму, мережу й адресу; гроші йдуть з нашого Binance на
// його гаманець. Тільки "доступно до виплати".
//
// Щоб власник потім не заплатив за ті самі угоди вдруге ("можно платить" чи
// автовиплата), вивід спершу закриває готові до виплати угоди клієнта
// (найстаріші першими, поки сума покриває борг угоди повністю), а решту
// списує поправкою балансу. Підсумок завжди: було A, стало A − вивід.
// Binance відмовив — усе відкочуємо.
//
// Під тим самим замком, що й покупки (skinbuxPurchases.exclusive).
function clientWithdraw(config, { steamId, network, address, amount, exclusive, getAvailable, notify = async () => {} }) {
  return exclusive(async () => {
    const cfg = settings(config);
    if (!cfg.clientWithdraw || !binance.configured()) throw new WithdrawError("DISABLED");
    const pair = PAIRS[network];
    if (!pair) throw new WithdrawError("BAD_NETWORK");
    let details;
    try {
      details = payoutDetails.parse("crypto", { network, address });
    } catch (err) {
      throw new WithdrawError("BAD_ADDRESS", { message: err.message });
    }
    let q;
    try {
      q = await binance.quote(network, { force: true });
    } catch {
      throw new WithdrawError("SHOP_UNAVAILABLE");
    }
    if (!q || !q.enabled) throw new WithdrawError("SHOP_UNAVAILABLE");
    const sum = round2(Number(amount));
    const fee = round2(q.fee);
    const send = round2(sum - fee);
    const min = round2(Math.max(cfg.minUsd, q.min));
    // Вивід від мінімуму — сума, яку людина вводить, до вирахування комісії.
    if (!Number.isFinite(sum) || sum < min || send <= 0) throw new WithdrawError("BAD_AMOUNT", { min });
    const available = round2(getAvailable(steamId));
    if (sum > available + 0.001) throw new WithdrawError("INSUFFICIENT_BALANCE", { available });
    // На Binance бракує: з автопоповненням — ставимо вивід у чергу (гроші
    // клієнта списуємо одразу, піде, щойно Skinbux поповнить Binance);
    // без нього — "вивід зараз недоступний".
    const queued = q.free + 0.001 < sum;
    if (queued && !refill.settings(config).enabled) {
      notify(`💰 Клиент ${steamId} хотел вывести ${money(sum)} (${pair.label}), но на Binance свободно ${money(q.free)} ${pair.coin} — пополни.`).catch(() => {});
      throw new WithdrawError("SHOP_UNAVAILABLE");
    }

    const id = crypto.randomUUID();
    const { closed, adjustmentId } = debit(steamId, sum, `Вывод ${pair.label} ${money(sum)} (#${id.slice(0, 8)})`);
    const now = new Date().toISOString();
    if (queued) {
      const record = {
        id, steamId: String(steamId), network, address: details.address, amount: sum, fee, send,
        key: `wd-${id}`, provider: "binance", requestedAt: now, closedSales: closed, adjustmentId,
        status: "waiting-funds", createdAt: now, updatedAt: now,
      };
      const all = loadWd();
      all.push(record);
      saveWd(all);
      notify(`⏳ Клиент ${steamId} выводит ${money(sum)} (${pair.label}), на Binance свободно ${money(q.free)} — вывод в очереди до пополнения.`).catch(() => {});
      await coverShortfall(config, queuedClientDemand(), notify);
      return record;
    }
    const { w, error } = await sendRecorded({
      id, steamId: String(steamId), network, address: details.address, amount: sum, fee, send,
      key: `wd-${id}`, provider: "binance", requestedAt: now, closedSales: closed, adjustmentId,
      status: "requesting", createdAt: now, updatedAt: now,
    });
    if (error && !error.ambiguous) {
      notify(`⚠️ Вывод клиента ${steamId} ${money(sum)} (${pair.label}) не прошёл: Binance ответил «${error.message}». Деньги вернулись ему на баланс.`).catch(() => {});
      throw new WithdrawError("FAILED", { message: error.message });
    }
    if (error) {
      notify(`⚠️ Вывод клиента ${steamId} ${money(sum)} (${pair.label}): ${error.message}. Проверю по истории Binance — двойного вывода не будет.`).catch(() => {});
      return w;
    }
    notify(`💸 Клиент ${steamId} вывел с Binance: дойдёт ${money(send)} ${pair.label} (комиссия сети ${money(fee)})\n${details.address}`).catch(() => {});
    return w;
  });
}

/** Скільки якої монети чекають виводи в черзі (кнопка клієнта, "waiting-funds"). */
function queuedClientDemand() {
  const demand = {};
  for (const w of loadWd()) {
    if (w.provider !== "binance" || w.status !== "waiting-funds") continue;
    const coin = PAIRS[w.network]?.coin;
    if (coin) demand[coin] = round2((demand[coin] || 0) + w.amount);
  }
  return demand;
}

/**
 * Раз на хвилину: поповнення Binance в дорозі, черга виводів, що чекала
 * грошей, і статуси вже створених виводів (з історії Binance).
 */
async function syncClientWithdrawals({ notify = async () => {}, config = null } = {}) {
  if (!binance.configured()) return;
  try {
    await refill.sync({ notify });
  } catch (err) {
    console.error("[binance-refill] sync:", err.message);
  }

  // Черга: гроші на Binance з'явились — відправляємо.
  let stillShort = false;
  binance.invalidate();
  for (const w of loadWd()) {
    if (w.provider !== "binance" || w.status !== "waiting-funds") continue;
    let q;
    try {
      q = await binance.quote(w.network);
    } catch {
      stillShort = true;
      continue;
    }
    if (!q || !q.enabled || q.free + 0.001 < w.amount) {
      stillShort = true;
      continue;
    }
    const now = new Date().toISOString();
    updateWd(w.id, { status: "requesting", requestedAt: now });
    try {
      const r = await binance.withdraw({ networkId: w.network, address: w.address, amount: w.amount, orderId: w.key });
      updateWd(w.id, { status: "pending", withdrawalId: r.id });
      notify(`💸 Вывод клиента ${w.steamId} из очереди ушёл с Binance: дойдёт ${money(w.send)} ${PAIRS[w.network].label}\n${w.address}`).catch(() => {});
    } catch (err) {
      if (err.ambiguous) {
        updateWd(w.id, { status: "unknown", error: err.message });
      } else {
        const f = updateWd(w.id, { status: "failed", error: err.message, code: err.code ?? null });
        undoDebit(f);
        notify(`❌ Вывод клиента ${w.steamId} ${money(w.amount)} из очереди не прошёл: Binance ответил «${err.message}». Деньги вернулись ему на баланс.`).catch(() => {});
      }
    }
  }
  if (stillShort && config) await coverShortfall(config, queuedClientDemand(), notify);

  for (const w of loadWd()) {
    if (w.provider !== "binance" || !["pending", "processing", "unknown", "requesting"].includes(w.status)) continue;
    let found;
    try {
      found = await binance.findWithdrawal(w.key, w.requestedAt || w.createdAt);
    } catch {
      continue;
    }
    if (!found) {
      // Невідомо, чи створено, і за 30 хвилин в історії нема. Гроші клієнту
      // самі не повертаємо: якщо вивід усе ж пішов, заплатили б двічі.
      if (["unknown", "requesting"].includes(w.status) && Date.now() - new Date(w.requestedAt || w.createdAt).getTime() > UNKNOWN_GIVE_UP_MS) {
        updateWd(w.id, { status: "check" });
        notify(
          `⚠️ Вывод клиента ${w.steamId} ${money(w.amount)} (${PAIRS[w.network]?.label || w.network}) не найден в истории Binance за 30 минут (${w.key}).\n` +
            `Проверь в Binance. Вывода нет — верни клиенту ${money(w.amount)} поправкой баланса в My Trades.`
        ).catch(() => {});
      }
      continue;
    }
    if (found.status === w.status) continue;
    updateWd(w.id, { status: found.status, withdrawalId: found.id ?? w.withdrawalId, txId: found.txId });
    if (found.status === "failed" || found.status === "rejected") {
      undoDebit(w);
      notify(`❌ Binance ${found.status === "rejected" ? "отклонил" : "не смог выполнить"} вывод клиента ${w.steamId} ${money(w.amount)} — деньги вернулись ему на баланс.`).catch(() => {});
    }
  }
}

function listWithdrawals(steamId) {
  return loadWd()
    .filter((w) => w.steamId === String(steamId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { run, settings, pairFor, PAIRS, networksForClient, clientWithdraw, syncClientWithdrawals, listWithdrawals, WithdrawError };
