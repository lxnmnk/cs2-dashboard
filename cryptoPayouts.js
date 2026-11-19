// Автовиплата клієнтам у крипті через вивід із мерчант-балансу Skinbux.
//
// Клієнт при продажі сам вказує, куди платити (payoutDetails: мережа й
// адреса). Коли угода виходить із холду (skinbuxSales.payableNow), сервер
// сам виводить гроші через POST /v1/account/withdrawals на його адресу і
// позначає угоду виплаченою. Власнику — повідомлення "виплачено".
// Мережі, яких Skinbux не вміє (BEP-20, Solana, USDC TRC-20), і картки
// лишаються ручними, як і були: "можно платить" у Telegram.
//
// Скільки платимо: борг за угоду, але не більше за "доступно" клієнта на
// сайті — частину він міг уже витратити на скіни з вітрини. Тоді угоду все
// одно закриваємо (markPaid), а різницю повертаємо поправкою в available,
// щоб баланс зійшовся: було A, стало A − виплачено.
// Комісію мережі за вивід платить клієнт: feeUsd віднімається з суми.
//
// Ідемпотентність: Idempotency-Key = "sale-<id>". Повтор того самого запиту
// не спише вдруге, а поверне вже створений вивід із поточним статусом —
// так і стежимо за pending -> paid (окремого "статусу виводу" в API немає).
// Неоднозначна відповідь (таймаут, 5xx, код 53) — повторюємо тим самим
// ключем на наступному проході.
// Skinbux відхилив вивід (failed / rejected) — гроші повернулись на наш
// баланс Skinbux, тож знімаємо позначку "виплачено" і віддаємо власнику
// вручну, як раніше.
const skinbuxSales = require("./skinbuxSales");
const customerBalances = require("./customerBalances");

const URL = "https://api.skinbux.com/v1/account/withdrawals";
const TIMEOUT_MS = 45000; // API Skinbux буває повільним (баланс — до 12 с)

// Мережа з payoutDetails.js -> пара Skinbux.
const PAIRS = {
  "usdt-erc20": { coin: "usdt", chain: "ethereum", label: "USDT ERC-20" },
  "usdt-trc20": { coin: "usdt", chain: "tron", label: "USDT TRC-20" },
  "usdc-erc20": { coin: "usdc", chain: "ethereum", label: "USDC ERC-20" },
};

const DEFAULTS = {
  enabled: false,
  // Тестовий режим: нічого не виводимо, лише пишемо власнику, що вивели б.
  dryRun: true,
  // Комісія мережі за вивід, яку платить клієнт ($), — по мережі.
  feeUsd: { "usdt-erc20": 1, "usdt-trc20": 1, "usdc-erc20": 1 },
  // Вивід за кнопкою клієнта (профіль → Баланс). Тестовий режим dryRun на
  // нього не діє: клієнт сам натиснув і чекає гроші.
  clientWithdraw: false,
  // Менше — не виводимо автоматично (комісія з'їсть усе), лишаємо вручну.
  minUsd: 15,
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function settings(config) {
  const c = config.cryptoPayout || {};
  return { ...DEFAULTS, ...c, feeUsd: { ...DEFAULTS.feeUsd, ...(c.feeUsd || {}) } };
}

/** Чи можна цю угоду виплатити автоматично (мережа, яку вміє Skinbux). */
function pairFor(sale) {
  const d = sale.payoutDetails;
  if (!d || d.method !== "crypto") return null;
  return PAIRS[d.network] || null;
}

async function withdraw(apiKey, key, body) {
  let res;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ambiguous: true, error: err.message };
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data?.success) return { withdrawal: data.data };
  const code = data?.error?.code;
  // 53 — "можливо, створено": повторюємо тим самим ключем.
  if (res.status >= 500 || code === 53) return { ambiguous: true, error: data?.error?.message || `HTTP ${res.status}` };
  return { failed: true, code, error: data?.error?.message || `HTTP ${res.status}` };
}

/**
 * Один прохід. getAvailable(steamId) — "доступно" клієнта на сайті (з
 * поправками й покупками). notify(text) — власнику.
 * Повертає Set id угод, які взялись автоматом (їм "можно платить" не шлемо).
 */
async function run(config, { getAvailable, notify = async () => {} }) {
  const cfg = settings(config);
  const handled = new Set();
  if (!cfg.enabled) return handled;
  const apiKey = process.env.SKINBUX_API_KEY;
  if (!apiKey) return handled;

  // 1. Нові угоди, що вийшли з холду.
  for (const sale of skinbuxSales.payableNow()) {
    if (skinbuxSales.OWN_STEAM_IDS.has(String(sale.steamId))) continue;
    const pair = pairFor(sale);
    if (!pair) continue;
    const ap = sale.autoPayout;
    // Уже пробували й віддали власнику — не чіпаємо.
    if (ap && ["failed", "manual"].includes(ap.status)) continue;
    // Тест уже показали; платить власнику вручну — "можно платить" прийде.
    if (ap && cfg.dryRun && ap.status === "dry-run") continue;

    const owed = skinbuxSales.amountOwed(sale);
    // Повтор після таймауту — суми з першої спроби, не перераховуємо.
    const retry = ap?.body && ap.status === "unknown";
    const pay = retry ? ap.pay : round2(Math.min(owed, Math.max(0, getAvailable(sale.steamId))));
    const fee = retry ? ap.fee : round2(cfg.feeUsd[sale.payoutDetails.network] ?? 1);
    const send = retry ? ap.send : round2(pay - fee);
    const address = sale.payoutDetails.address;
    const where = `${pair.label} · ${address}`;

    // Мінімум рахуємо від суми до комісії — так само, як у виводі за кнопкою.
    if (!retry && pay < cfg.minUsd) {
      skinbuxSales.setAutoPayout(sale.id, { status: "manual", reason: `к выплате $${pay.toFixed(2)} — меньше минимума $${cfg.minUsd}` });
      continue; // власник отримає звичайне "можно платить"
    }

    if (cfg.dryRun && !retry) {
      skinbuxSales.setAutoPayout(sale.id, { status: "dry-run", pay, fee, send });
      notify(
        `🧪 ТЕСТ автовыплаты (ничего не отправлено): сделка #${sale.id}, клиент ${sale.customerName || sale.steamId}\n` +
          `Долг $${owed.toFixed(2)}, доступно $${pay.toFixed(2)}, комиссия $${fee.toFixed(2)} → отправили бы $${send.toFixed(2)}\n${where}\n` +
          `Плати как обычно вручную. Включить по-настоящему: config.json → cryptoPayout.dryRun: false`
      ).catch(() => {});
      continue;
    }

    const key = ap?.key || `sale-${sale.id}`;
    // Повтор після таймауту — РІВНО той самий запит: інший amount з тим самим
    // ключем Skinbux відхилить (код 48), а новий ключ міг би вивести вдруге.
    const body = ap?.body || { amount: Math.round(send * 100), coin: pair.coin, chain: pair.chain, withdrawal_address: address };
    skinbuxSales.setAutoPayout(sale.id, { key, body, pay, fee, send, status: ap?.status === "unknown" ? "unknown" : "requesting" });
    const r = await withdraw(apiKey, key, body);

    if (r.ambiguous) {
      skinbuxSales.setAutoPayout(sale.id, { status: "unknown", error: r.error });
      handled.add(String(sale.id)); // повторимо тим самим ключем, вручну не платимо
      if (!ap) notify(`⚠️ Автовыплата по сделке #${sale.id}: Skinbux не ответил (${r.error}). Повторю сам тем же запросом — двойной выплаты не будет. Вручную НЕ плати.`).catch(() => {});
      continue;
    }
    if (r.failed) {
      skinbuxSales.setAutoPayout(sale.id, { status: "failed", error: r.error, code: r.code ?? null });
      notify(
        `❌ Автовыплата по сделке #${sale.id} не прошла: ${r.error}${r.code === 8 ? " (на балансе Skinbux не хватает денег)" : ""}${r.code === 49 ? " (Skinbux не принял адрес)" : ""}.\n` +
          `Заплати вручную как обычно: ${where}, $${send.toFixed(2)}`
      ).catch(() => {});
      continue; // угода лишається невиплаченою -> прийде звичайне "можно платить"
    }

    // Вивід прийнято, баланс Skinbux списано: закриваємо угоду.
    const w = r.withdrawal || {};
    skinbuxSales.markPaid(sale.id);
    let adjustmentId = null;
    if (owed - pay > 0.009) {
      adjustmentId = customerBalances.add({
        steamId: sale.steamId,
        amount: round2(owed - pay),
        bucket: "available",
        note: `Сделка #${sale.id}: $${round2(owed - pay).toFixed(2)} клиент уже потратил на сайте — выплачено $${pay.toFixed(2)} автоматически`,
        by: "auto-payout",
      }).id;
    }
    skinbuxSales.setAutoPayout(sale.id, { status: w.status || "pending", withdrawalId: w.id ?? null, adjustmentId, paidAt: new Date().toISOString() });
    handled.add(String(sale.id));
    notify(
      `💸 Выплачено автоматически — сделка #${sale.id}, клиент ${sale.customerName || sale.steamId}\n` +
        `$${send.toFixed(2)} (${pair.label}, комиссия $${fee.toFixed(2)} с клиента)${pay < owed ? `, $${round2(owed - pay).toFixed(2)} клиент потратил на скины` : ""}\n` +
        `${address}\nSkinbux вывод #${w.id ?? "?"}, статус ${w.status || "pending"}`
    ).catch(() => {});
  }

  // 2. Уже створені виводи: стежимо за статусом повтором того самого запиту.
  for (const sale of skinbuxSales.loadAll()) {
    const ap = sale.autoPayout;
    if (!ap || !["pending", "processing", "unknown"].includes(ap.status) || !ap.body) continue;
    // "unknown" для невиплаченої угоди обробив крок 1.
    if (ap.status === "unknown" && !sale.paidAt) continue;
    const r = await withdraw(apiKey, ap.key, ap.body);
    if (!r.withdrawal) continue; // спробуємо наступного разу
    const st = r.withdrawal.status;
    if (st === ap.status) continue;
    skinbuxSales.setAutoPayout(sale.id, { status: st, txId: r.withdrawal.transaction_id || null, failureReason: r.withdrawal.failure_reason || null });
    if (st === "failed" || st === "rejected") {
      // Гроші повернулись на баланс Skinbux — угода знову невиплачена.
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
        `❌ Skinbux ${st === "rejected" ? "отклонил" : "не смог выполнить"} автовыплату по сделке #${sale.id}${r.withdrawal.failure_reason ? `: ${r.withdrawal.failure_reason}` : ""}. ` +
          `Деньги вернулись на баланс Skinbux, сделка снова «не выплачена» — заплати вручную.`
      ).catch(() => {});
    }
  }

  // 3. Ручні холди власника з датою виходу й автовиплатою.
  await runHoldReleases(cfg, apiKey, { getAvailable, notify });
  return handled;
}

/** Куди платити клієнту: реквізити з останньої продажі, інакше останній вивід. */
function cryptoDetailsFor(steamId) {
  const last = skinbuxSales.lastPayout(String(steamId));
  if (last?.details?.method === "crypto" && PAIRS[last.details.network] && last.details.address) {
    return { network: last.details.network, address: last.details.address };
  }
  const w = loadWd().filter((x) => x.steamId === String(steamId) && PAIRS[x.network] && x.address && !["failed", "rejected"].includes(x.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return w ? { network: w.network, address: w.address } : null;
}

/**
 * Власник поставив клієнту +$X у hold на N днів з автовиплатою (продав його
 * скін сам). Коли холд вийшов — виводимо рівно цю суму (не більше за
 * "доступно") на криптореквізити клієнта. Вивід пишемо в cryptoWithdrawals
 * як звичайний вивід клієнта: syncClientWithdrawals стежить за статусом і
 * при відмові повертає гроші на баланс; клієнт бачить вивід у профілі.
 */
async function runHoldReleases(cfg, apiKey, { getAvailable, notify }) {
  for (const { steamId, entry } of customerBalances.releasedAutoPayouts()) {
    if (entry.autoPayout?.status !== "waiting") continue;
    const set = (patch) => customerBalances.update(steamId, entry.id, { autoPayout: { ...entry.autoPayout, ...patch, updatedAt: new Date().toISOString() } });
    const label = `холд $${entry.amount.toFixed(2)} клиента ${steamId}${entry.note ? ` («${entry.note}»)` : ""}`;

    const details = cryptoDetailsFor(steamId);
    if (!details) {
      set({ status: "no-details" });
      notify(`ℹ️ Вышел ${label}, но у клиента нет крипто-реквизитов. Деньги у него в «доступно» — выведет сам или заплати вручную.`).catch(() => {});
      continue;
    }
    const pair = PAIRS[details.network];
    const pay = round2(Math.min(entry.amount, Math.max(0, getAvailable(steamId))));
    const fee = round2(cfg.feeUsd[details.network] ?? 1);
    const send = round2(pay - fee);
    const where = `${pair.label} · ${details.address}`;
    if (pay < cfg.minUsd || send <= 0) {
      set({ status: "manual", reason: `доступно $${pay.toFixed(2)} — меньше минимума $${cfg.minUsd}` });
      notify(`ℹ️ Вышел ${label}: к выплате $${pay.toFixed(2)} — меньше минимума $${cfg.minUsd}, автоматически не плачу. Деньги у клиента в «доступно».`).catch(() => {});
      continue;
    }
    if (cfg.dryRun) {
      set({ status: "dry-run", pay, fee, send });
      notify(`🧪 ТЕСТ (ничего не отправлено): вышел ${label} → отправили бы $${send.toFixed(2)} (комиссия $${fee.toFixed(2)})\n${where}`).catch(() => {});
      continue;
    }

    const id = crypto.randomUUID();
    const key = `hold-${entry.id}`;
    const body = { amount: Math.round(send * 100), coin: pair.coin, chain: pair.chain, withdrawal_address: details.address };
    const adjustmentId = customerBalances.add({
      steamId,
      amount: -pay,
      bucket: "available",
      note: `Автовыплата холда $${pay.toFixed(2)} ${pair.label} (#${id.slice(0, 8)})`,
      by: "hold-payout",
    }).id;
    const now = new Date().toISOString();
    const all = loadWd();
    all.push({ id, steamId: String(steamId), network: details.network, address: details.address, amount: pay, fee, send, key, body, closedSales: [], adjustmentId, source: "hold", entryId: entry.id, status: "requesting", createdAt: now, updatedAt: now });
    saveWd(all);
    set({ status: "sent", withdrawId: id, pay, fee, send });

    const r = await withdraw(apiKey, key, body);
    if (r.failed) {
      const w = updateWd(id, { status: "failed", error: r.error, code: r.code ?? null });
      undoDebit(w);
      set({ status: "failed", error: r.error });
      notify(
        `❌ Автовыплата холда не прошла: ${r.error}${r.code === 8 ? " (на балансе Skinbux не хватает денег)" : ""}${r.code === 49 ? " (Skinbux не принял адрес)" : ""}.\n` +
          `${label}: деньги у клиента в «доступно», заплати вручную: ${where}, $${send.toFixed(2)}`
      ).catch(() => {});
      continue;
    }
    if (r.ambiguous) {
      updateWd(id, { status: "unknown", error: r.error });
      notify(`⚠️ Автовыплата холда клиенту ${steamId} $${send.toFixed(2)}: Skinbux не ответил — повторю тем же запросом, двойной выплаты не будет. Вручную НЕ плати.`).catch(() => {});
      continue;
    }
    updateWd(id, { status: r.withdrawal?.status || "pending", withdrawalId: r.withdrawal?.id ?? null });
    notify(`💸 Выплачен холд автоматически: ${label}\n$${send.toFixed(2)} (${pair.label}, комиссия $${fee.toFixed(2)} с клиента)\n${details.address}\nSkinbux вывод #${r.withdrawal?.id ?? "?"}`).catch(() => {});
  }
}

// ---- Вивід за кнопкою клієнта ("Вивести" у профілі → Баланс) ----
// Клієнт сам обирає суму, мережу й адресу; гроші йдуть із нашого балансу
// Skinbux одразу на його гаманець. Тільки "доступно до виплати".
//
// Щоб власник потім не заплатив за ті самі угоди вдруге ("можно платить" чи
// автовиплата), вивід спершу закриває готові до виплати угоди клієнта
// (найстаріші першими, поки сума покриває борг угоди повністю), а решту
// списує поправкою балансу. Підсумок завжди: було A, стало A − вивід.
// Не вдалось у Skinbux — усе відкочуємо: угоди знову невиплачені, поправку
// прибираємо.
//
// Під тим самим замком, що й покупки (skinbuxPurchases.exclusive).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const payoutDetails = require("./payoutDetails");
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
 * Вивід за кнопкою. exclusive — замок покупок; getAvailable(steamId) —
 * "доступно" клієнта. Повертає запис виводу або кидає WithdrawError.
 */
function clientWithdraw(config, { steamId, network, address, amount, exclusive, getAvailable, notify = async () => {} }) {
  return exclusive(async () => {
    const cfg = settings(config);
    if (!cfg.clientWithdraw) throw new WithdrawError("DISABLED");
    const apiKey = process.env.SKINBUX_API_KEY;
    if (!apiKey) throw new WithdrawError("DISABLED");
    const pair = PAIRS[network];
    if (!pair) throw new WithdrawError("BAD_NETWORK");
    let details;
    try {
      details = payoutDetails.parse("crypto", { network, address });
    } catch (err) {
      throw new WithdrawError("BAD_ADDRESS", { message: err.message });
    }
    const sum = round2(Number(amount));
    const fee = round2(cfg.feeUsd[network] ?? 1);
    const send = round2(sum - fee);
    // Вивід від minUsd — сума, яку людина вводить, до вирахування комісії.
    if (!Number.isFinite(sum) || sum < cfg.minUsd || send <= 0) throw new WithdrawError("BAD_AMOUNT", { min: round2(cfg.minUsd) });
    const available = round2(getAvailable(steamId));
    if (sum > available + 0.001) throw new WithdrawError("INSUFFICIENT_BALANCE", { available });

    const id = crypto.randomUUID();
    const body = { amount: Math.round(send * 100), coin: pair.coin, chain: pair.chain, withdrawal_address: details.address };
    const { closed, adjustmentId } = debit(steamId, sum, `Вывод ${pair.label} $${sum.toFixed(2)} (#${id.slice(0, 8)})`);
    const now = new Date().toISOString();
    const all = loadWd();
    all.push({ id, steamId: String(steamId), network, address: details.address, amount: sum, fee, send, key: `wd-${id}`, body, closedSales: closed, adjustmentId, status: "requesting", createdAt: now, updatedAt: now });
    saveWd(all);

    const r = await withdraw(apiKey, `wd-${id}`, body);
    if (r.failed) {
      const w = updateWd(id, { status: "failed", error: r.error, code: r.code ?? null });
      undoDebit(w);
      if (r.code === 8) notify(`⚠️ Клиент ${steamId} хотел вывести $${send.toFixed(2)} (${pair.label}), но на балансе Skinbux не хватает денег.`).catch(() => {});
      throw new WithdrawError(r.code === 49 ? "BAD_ADDRESS" : r.code === 8 ? "SHOP_UNAVAILABLE" : "FAILED", { message: r.error });
    }
    if (r.ambiguous) {
      updateWd(id, { status: "unknown", error: r.error });
      notify(`⚠️ Вывод клиента ${steamId} $${send.toFixed(2)} (${pair.label}): Skinbux не ответил — повторю тем же запросом, двойного вывода не будет.`).catch(() => {});
      return loadWd().find((x) => x.id === id);
    }
    const w = updateWd(id, { status: r.withdrawal?.status || "pending", withdrawalId: r.withdrawal?.id ?? null });
    notify(
      `💸 Клиент ${steamId} вывел $${send.toFixed(2)} ${pair.label} (комиссия $${fee.toFixed(2)})\n${details.address}\nSkinbux вывод #${r.withdrawal?.id ?? "?"}`
    ).catch(() => {});
    return w;
  });
}

/** Стежимо за виводами клієнтів: повтор того самого запиту = поточний статус. */
async function syncClientWithdrawals({ notify = async () => {} } = {}) {
  const apiKey = process.env.SKINBUX_API_KEY;
  if (!apiKey) return;
  for (const w of loadWd()) {
    if (!["pending", "processing", "unknown", "requesting"].includes(w.status)) continue;
    const r = await withdraw(apiKey, w.key, w.body);
    if (r.failed) {
      // Відповідь є і це відмова — вивід не створено: повертаємо гроші.
      if (["unknown", "requesting"].includes(w.status)) {
        undoDebit(w);
        updateWd(w.id, { status: "failed", error: r.error });
      }
      continue;
    }
    if (!r.withdrawal) continue;
    const st = r.withdrawal.status;
    if (st === w.status) continue;
    updateWd(w.id, { status: st, withdrawalId: r.withdrawal.id ?? w.withdrawalId, txId: r.withdrawal.transaction_id || null });
    if (st === "failed" || st === "rejected") {
      undoDebit(w);
      notify(`❌ Skinbux ${st === "rejected" ? "отклонил" : "не смог выполнить"} вывод клиента ${w.steamId} $${w.send.toFixed(2)} — деньги вернулись ему на баланс.`).catch(() => {});
    }
  }
}

function listWithdrawals(steamId) {
  return loadWd()
    .filter((w) => w.steamId === String(steamId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { run, settings, pairFor, PAIRS, clientWithdraw, syncClientWithdrawals, listWithdrawals, WithdrawError };
