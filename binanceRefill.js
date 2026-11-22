// Автопоповнення Binance з мерчант-балансу Skinbux.
//
// Клієнтам платимо з Binance (cryptoPayouts.js), а гроші заробляються на
// Skinbux. Skinbux дозволяє виводити лише на власний гаманець — наш Binance
// і є власним. Тож коли на Binance не вистачає монети для виплати, сервер
// сам виводить нестачу зі Skinbux на адресу депозиту нашого Binance:
//   USDT -> USDT ERC-20, USDC -> USDC ERC-20 (так вирішив власник).
// Адресу депозиту беремо з API Binance (binanceWallet.depositAddress), не з
// конфігу: так гроші гарантовано йдуть на наш гаманець.
//
// Одне поповнення на монету за раз: поки попереднє в дорозі (Skinbux ще
// виводить або Binance чекає підтверджень мережі), нове не запускаємо — інакше
// кожен прохід виплат виводив би ту саму нестачу знову.
//
// Скільки: нестача + extraUsd (комісія мережі, яку Skinbux бере із суми),
// округлено вгору, не менше minUsd. Ідемпотентність — як у Skinbux:
// Idempotency-Key "refill-<id>"; повтор того самого запиту не виведе вдруге,
// а поверне поточний статус.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const binance = require("./binanceWallet");
const skinbuxAccount = require("./skinbuxAccount");

const FILE = path.join(__dirname, "binanceRefills.json");
const URL = "https://api.skinbux.com/v1/account/withdrawals";
const TIMEOUT_MS = 45000;
// Після того як Skinbux вивів, Binance ще чекає підтверджень мережі.
// Стільки вважаємо поповнення "в дорозі", далі можна запускати нове.
const ARRIVAL_GRACE_MS = 40 * 60 * 1000;

// Монета Binance -> як виводити зі Skinbux і куди приймати на Binance.
const ROUTES = {
  USDT: { coin: "usdt", chain: "ethereum", binanceNetwork: "ETH", label: "USDT ERC-20" },
  USDC: { coin: "usdc", chain: "ethereum", binanceNetwork: "ETH", label: "USDC ERC-20" },
};

const DEFAULTS = { enabled: false, extraUsd: 5, minUsd: 20 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${round2(n).toFixed(2)}`;

function settings(config) {
  return { ...DEFAULTS, ...(config.binanceRefill || {}) };
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
function update(id, patch) {
  const all = load();
  const r = all.find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: new Date().toISOString() });
  save(all);
  return r;
}

async function skinbuxWithdraw(key, body) {
  let res;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { "x-api-key": process.env.SKINBUX_API_KEY, "Content-Type": "application/json", "Idempotency-Key": key },
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
 * Поповнення монети, яке ще в дорозі (null — немає). Skinbux уже вивів, але
 * депозиту ще не видно на Binance — теж "в дорозі", до ARRIVAL_GRACE_MS.
 * Щойно Binance показав депозит (зараховано, навіть якщо ще підтверджується),
 * гроші вже у "вільно" — можна рахувати наступну нестачу.
 */
async function inFlight(coin) {
  for (const r of load()) {
    if (r.coin !== coin) continue;
    if (["requesting", "unknown", "pending", "processing"].includes(r.status)) return r;
    if (r.status !== "completed" || r.arrivedAt) continue;
    if (Date.now() - new Date(r.completedAt || r.updatedAt).getTime() >= ARRIVAL_GRACE_MS) continue;
    let arrived = null;
    try {
      const route = ROUTES[coin];
      arrived = (await binance.recentDeposits(coin, r.createdAt)).find(
        (d) => d.network === route.binanceNetwork && [1, 6].includes(d.status) && d.amount <= r.amount + 0.001 && d.amount >= r.amount * 0.9
      );
    } catch {
      return r; // Binance не відповів — вважаємо, що ще в дорозі
    }
    if (!arrived) return r;
    update(r.id, { arrivedAt: arrived.at, arrivedAmount: arrived.amount });
  }
  return null;
}

/**
 * Потрібно needUsd монети coin на Binance. Якщо вільного менше і поповнення
 * не в дорозі — виводимо нестачу зі Skinbux. Повертає { started, inFlight, reason }.
 */
async function ensure(config, coin, needUsd, { notify = async () => {} } = {}) {
  const cfg = settings(config);
  const route = ROUTES[coin];
  if (!cfg.enabled || !route || !process.env.SKINBUX_API_KEY || !binance.configured()) return { started: false, reason: "off" };
  if (await inFlight(coin)) return { started: false, inFlight: true };

  // Депозит падає у Funding, а один вивід бере гроші з одного гаманця, тож
  // нестачу рахуємо від Funding: інакше гроші на Spot "зараховувались" би
  // і поповнення виходило меншим, ніж треба для виводу з Funding.
  const coinInfo = (await binance.coins({ force: true })).find((c) => c.coin === coin);
  const free = coinInfo?.fundingFree || 0;
  const short = round2(needUsd - free);
  if (short <= 0) return { started: false, reason: "enough" };
  const amount = Math.ceil(Math.max(short + cfg.extraUsd, cfg.minUsd));

  const skinbux = await skinbuxAccount.fetchBalance(process.env.SKINBUX_API_KEY);
  if (skinbux.available + 0.001 < amount) {
    return { started: false, reason: "skinbux-empty", skinbuxAvailable: skinbux.available, amount };
  }

  const address = await binance.depositAddress(coin, route.binanceNetwork);
  const id = crypto.randomUUID();
  const key = `refill-${id}`;
  const body = { amount: Math.round(amount * 100), coin: route.coin, chain: route.chain, withdrawal_address: address };
  const now = new Date().toISOString();
  const all = load();
  all.push({ id, coin, label: route.label, amount, address, key, body, need: round2(needUsd), freeBefore: round2(free), status: "requesting", createdAt: now, updatedAt: now });
  save(all);

  const r = await skinbuxWithdraw(key, body);
  if (r.failed) {
    update(id, { status: "failed", error: r.error, code: r.code ?? null });
    notify(`❌ Не смог пополнить Binance со Skinbux (${money(amount)} ${route.label}): ${r.error}. Выплаты ждут — пополни Binance вручную.`).catch(() => {});
    return { started: false, reason: "failed" };
  }
  if (r.ambiguous) {
    update(id, { status: "unknown", error: r.error });
    return { started: true };
  }
  update(id, { status: r.withdrawal?.status || "pending", withdrawalId: r.withdrawal?.id ?? null });
  notify(`🔄 Пополняю Binance: вывел со Skinbux ${money(amount)} ${route.label} на свой Binance (не хватало ${money(short)} для выплат). Деньги придут через несколько минут — выплаты уйдут сами.`).catch(() => {});
  return { started: true };
}

/** Стежимо за поповненнями в дорозі: повтор того самого запиту = поточний статус. */
async function sync({ notify = async () => {} } = {}) {
  if (!process.env.SKINBUX_API_KEY) return;
  for (const rec of load()) {
    if (!["requesting", "unknown", "pending", "processing"].includes(rec.status)) continue;
    const r = await skinbuxWithdraw(rec.key, rec.body);
    if (r.failed && ["requesting", "unknown"].includes(rec.status)) {
      // Відповідь є і це відмова — вивід не створено.
      update(rec.id, { status: "failed", error: r.error });
      notify(`❌ Пополнение Binance со Skinbux (${money(rec.amount)} ${rec.label}) не создано: ${r.error}.`).catch(() => {});
      continue;
    }
    if (!r.withdrawal) continue;
    const st = r.withdrawal.status;
    if (st === rec.status) continue;
    const done = ["completed", "paid", "success"].includes(st);
    update(rec.id, { status: done ? "completed" : st, txId: r.withdrawal.transaction_id || null, ...(done ? { completedAt: new Date().toISOString() } : {}) });
    if (st === "failed" || st === "rejected") {
      notify(`❌ Skinbux ${st === "rejected" ? "отклонил" : "не смог выполнить"} пополнение Binance (${money(rec.amount)} ${rec.label})${r.withdrawal.failure_reason ? `: ${r.withdrawal.failure_reason}` : ""}. Выплаты ждут — пополни Binance вручную.`).catch(() => {});
    }
  }
}

module.exports = { ROUTES, settings, ensure, sync, inFlight };
