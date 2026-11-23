// Поповнення балансу клієнта в USDT (ERC-20 / TRC-20).
//
// Гроші йдуть на депозитну адресу нашого мерчант-акаунта на Skinbux (панель →
// Top Up): Skinbux сам зараховує їх нам після підтверджень у мережі. Їхній
// API депозитів не віддає (тільки панель із 2FA), тому перевіряємо сам
// блокчейн: переказ USDT на цю адресу з потрібною кількістю підтверджень і є
// "гроші вже у Skinbux".
//
// Адреса одна на всіх, тож чий переказ — визначаємо сумою:
//   1. Клієнт просить "поповнити на $50" — видаємо рахунок на 50.37 USDT з
//      унікальними центами (серед відкритих рахунків тієї ж мережі) на
//      invoiceMinutes хвилин.
//   2. scan() раз на хвилину читає вхідні перекази на адресу; переказ рівно на
//      суму відкритого рахунку, зроблений у його вікні, — зараховуємо.
//   3. Зараховуємо в trade-баланс (тільки на скіни, вивести не можна) суму
//      мінус комісію мережі, яку Skinbux знімає при зарахуванні (feeUsd).
//   4. Переказ, що не збігся з жодним рахунком (біржа зрізала комісію, людина
//      помилилась у сумі), — повідомляємо власнику: зарахує руками через
//      поправки балансу (customerBalances.js).
//
// Мережі:
//   ERC-20 — eth_getLogs по контракту USDT через публічний RPC, лише блоки з
//            ercConfirmations підтвердженнями (Skinbux чекає 12);
//   TRC-20 — TronGrid /v1/accounts/{addr}/transactions/trc20, only_confirmed.
//
// Файл cryptoTopups.json — живі дані, на сервер поверх не заливати.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "cryptoTopups.json");
const USDT_ERC20 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ETH_RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
const TRONGRID = "https://api.trongrid.io";
const ETH_CHUNK = 500; // блоків на один eth_getLogs
const ETH_START_BACK = 400; // перший запуск: ~1.3 год назад
// Рахунок закритий для нових переказів після expiresAt, але переказ, надісланий
// вчасно, міг потрапити в блок пізніше — приймаємо ще стільки після.
const LATE_GRACE_MS = 30 * 60 * 1000;
// Стільки мережа може не читатись, перш ніж ми перестанемо видавати в ній
// нові рахунки: короткі збої публічних API — норма.
const READ_FAIL_HIDE_MS = 10 * 60 * 1000;

const DEFAULTS = {
  minUsd: 25,
  // Мінімальний депозит Skinbux: менший переказ вони можуть не зарахувати
  // зовсім, тож і клієнту такий не зараховуємо автоматично.
  skinbuxMinUsd: 25,
  maxUsd: 5000,
  invoiceMinutes: 60,
  ercConfirmations: 12,
  networks: {
    erc20: { address: "", feeUsd: 0.1 },
    trc20: { address: "", feeUsd: 1.5 },
  },
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function settings(config) {
  const c = config.cryptoTopup || {};
  return {
    ...DEFAULTS,
    ...c,
    networks: {
      erc20: { ...DEFAULTS.networks.erc20, ...(c.networks?.erc20 || {}) },
      trc20: { ...DEFAULTS.networks.trc20, ...(c.networks?.trc20 || {}) },
    },
  };
}

/**
 * Мережі, для яких задана адреса, — тільки їх показуємо клієнту. Мережу на
 * паузі (звірка з балансом Skinbux не зійшлась, див. verifyCredits) не
 * показуємо: нові гроші на адресу, яка, можливо, вже не наша, не приймаємо.
 * Мережу, яку ми давно не можемо прочитати, теж: переказ туди ніхто б не
 * побачив, і людина чекала б зарахування без кінця.
 * withPaused — для сервера: сканувати перекази треба й на паузі.
 */
function enabledNetworks(cfg, { withPaused = false, now = Date.now() } = {}) {
  const state = withPaused ? null : load();
  const hidden = (id) =>
    !!state && (!!state.paused[id] || (state.readFail[id] && now - new Date(state.readFail[id]).getTime() > READ_FAIL_HIDE_MS));
  return Object.entries(cfg.networks)
    .filter(([id, n]) => n.address && !hidden(id))
    .map(([id, n]) => ({ id, address: n.address, feeUsd: n.feeUsd }));
}

const EMPTY = () => ({ invoices: [], seen: {}, unmatched: [], eth: {}, tron: {}, snapshots: [], paused: {}, readFail: {} });

function load() {
  try {
    return { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return EMPTY();
  }
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

class TopupError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}

function isOpen(inv, now = Date.now()) {
  return inv.status === "waiting" && now <= new Date(inv.expiresAt).getTime() + LATE_GRACE_MS;
}

/**
 * Новий рахунок. Попередній відкритий рахунок клієнта в цій мережі
 * скасовуємо: два рахунки на одну людину лише плутають.
 */
function createInvoice(config, { steamId, network, amountUsd }) {
  const cfg = settings(config);
  const net = cfg.networks[network];
  if (!net?.address || !enabledNetworks(cfg).some((n) => n.id === network)) throw new TopupError("BAD_NETWORK");
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount < cfg.minUsd || amount > cfg.maxUsd) {
    throw new TopupError("BAD_AMOUNT", { min: cfg.minUsd, max: cfg.maxUsd });
  }

  const state = load();
  const now = Date.now();
  for (const inv of state.invoices) {
    if (inv.steamId === String(steamId) && inv.network === network && inv.status === "waiting" && now <= new Date(inv.expiresAt).getTime()) {
      inv.status = "replaced";
    }
  }
  // Унікальні центи серед ще живих рахунків цієї мережі на ту ж суму в
  // доларах. Зайняті всі 99 — беремо наступний долар.
  let dollars = null;
  let cents = null;
  for (let d = Math.floor(amount); d < Math.floor(amount) + 20; d++) {
    const busy = new Set(
      state.invoices
        .filter((i) => i.network === network && isOpen(i, now) && Math.floor(i.amount) === d)
        .map((i) => Math.round((i.amount - d) * 100))
    );
    const free = [];
    for (let c = 1; c <= 99; c++) if (!busy.has(c)) free.push(c);
    if (free.length) {
      dollars = d;
      cents = free[crypto.randomInt(free.length)];
      break;
    }
  }
  if (cents == null) throw new TopupError("BUSY");

  const inv = {
    id: crypto.randomUUID(),
    steamId: String(steamId),
    network,
    address: net.address,
    amount: round2(dollars + cents / 100),
    feeUsd: net.feeUsd,
    status: "waiting",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + cfg.invoiceMinutes * 60000).toISOString(),
  };
  state.invoices.push(inv);
  save(state);
  return inv;
}

function listFor(steamId) {
  return load()
    .invoices.filter((i) => i.steamId === String(steamId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Зараховане клієнту — у trade-баланс. */
function creditedFor(steamId) {
  return round2(
    load()
      .invoices.filter((i) => i.steamId === String(steamId) && i.status === "credited")
      .reduce((s, i) => s + (i.credited || 0), 0)
  );
}

function applyTo(balance, steamId) {
  const c = creditedFor(steamId);
  return c ? { ...balance, trade: round2((balance.trade || 0) + c) } : balance;
}

/** Для панелі: зараховане по всіх клієнтах. */
function totalsBySteamId() {
  const out = {};
  for (const i of load().invoices) {
    if (i.status === "credited") out[i.steamId] = round2((out[i.steamId] || 0) + (i.credited || 0));
  }
  return out;
}

// ---- Мережі ----
async function ethCall(method, params) {
  const res = await fetch(ETH_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null);
  if (!data || data.error) throw new Error(`ETH RPC ${method}: ${JSON.stringify(data?.error || res.status).slice(0, 200)}`);
  return data.result;
}

const hex = (n) => "0x" + n.toString(16);

/** Вхідні перекази USDT ERC-20 на адресу з потрібними підтвердженнями. */
async function ethTransfers(state, address, confirmations) {
  const head = parseInt(await ethCall("eth_blockNumber", []), 16);
  const safe = head - confirmations;
  let from = state.eth.lastBlock != null ? state.eth.lastBlock + 1 : safe - ETH_START_BACK;
  const out = [];
  const blockTimes = new Map();
  const topicTo = "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  while (from <= safe) {
    const to = Math.min(safe, from + ETH_CHUNK - 1);
    const logs = await ethCall("eth_getLogs", [{ address: USDT_ERC20, fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER_TOPIC, null, topicTo] }]);
    for (const l of logs || []) {
      const bn = parseInt(l.blockNumber, 16);
      if (!blockTimes.has(bn)) {
        const b = await ethCall("eth_getBlockByNumber", [l.blockNumber, false]);
        blockTimes.set(bn, parseInt(b.timestamp, 16) * 1000);
      }
      out.push({
        key: `erc20:${l.transactionHash}:${parseInt(l.logIndex, 16)}`,
        network: "erc20",
        tx: l.transactionHash,
        from: "0x" + String(l.topics[1] || "").slice(-40),
        micros: BigInt(l.data),
        at: blockTimes.get(bn),
      });
    }
    state.eth.lastBlock = to;
    from = to + 1;
  }
  return out;
}

/** Вхідні перекази USDT TRC-20 (лише підтверджені). */
async function tronTransfers(state, address) {
  const since = state.tron.lastTs != null ? state.tron.lastTs + 1 : Date.now() - 80 * 60000;
  const out = [];
  let url =
    `${TRONGRID}/v1/accounts/${address}/transactions/trc20?only_to=true&only_confirmed=true&limit=200` +
    `&contract_address=${USDT_TRC20}&order_by=block_timestamp,asc&min_timestamp=${since}`;
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {} });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      // Без ключа TronGrid постійно відповідає 429, і чекати тут марно.
      const hint = res.status === 429 && !process.env.TRONGRID_API_KEY ? " (нет TRONGRID_API_KEY в .env)" : "";
      throw new Error(`TronGrid ${res.status}${hint}`);
    }
    for (const t of data.data || []) {
      if (t.to !== address || t.token_info?.address !== USDT_TRC20) continue;
      out.push({ key: `trc20:${t.transaction_id}`, network: "trc20", tx: t.transaction_id, from: t.from, micros: BigInt(t.value), at: t.block_timestamp });
      state.tron.lastTs = Math.max(state.tron.lastTs || 0, t.block_timestamp);
    }
    url = data.meta?.links?.next || null;
  }
  if (state.tron.lastTs == null) state.tron.lastTs = since;
  return out;
}

/** Переказ -> рахунок: точна сума, у вікні рахунку, у тій самій мережі. */
// Біржі й гаманці часто знімають свою комісію за вивід прямо з суми: клієнт
// просив 30.28, а дійшло 29.68. Такий переказ приймаємо, якщо він не менший
// за рахунок більш ніж на LOOSE_SHORT_PCT і під нього підходить РІВНО ОДИН
// відкритий рахунок у цій мережі — інакше не вгадати, чий він, і рішення за
// власником (повідомлення "без рахунку" + topup-match.js).
const LOOSE_SHORT_PCT = 10;

function inWindow(i, t) {
  return (
    i.status === "waiting" &&
    i.network === t.network &&
    t.at >= new Date(i.createdAt).getTime() - 2 * 60000 &&
    t.at <= new Date(i.expiresAt).getTime() + LATE_GRACE_MS
  );
}

/** Переказ -> { inv, loose } або null. Спершу точна сума, потім "трохи менше". */
function matchInvoice(state, t) {
  const usd = Number(t.micros) / 1e6;
  if (t.micros % 10000n === 0n) {
    const cents = Number(t.micros / 10000n);
    const exact = state.invoices.find((i) => inWindow(i, t) && Math.round(i.amount * 100) === cents);
    if (exact) return { inv: exact, loose: false };
  }
  const near = state.invoices.filter((i) => inWindow(i, t) && usd < i.amount && usd >= i.amount * (1 - LOOSE_SHORT_PCT / 100));
  return near.length === 1 ? { inv: near[0], loose: true } : null;
}

/** Зарахувати переказ на рахунок (і з scan(), і вручну — topup-match.js). */
function creditInvoice(inv, t, usd) {
  inv.status = "credited";
  inv.tx = t.tx;
  inv.received = round2(usd);
  inv.credited = round2(Math.max(0, usd - (inv.feeUsd || 0)));
  inv.creditedAt = new Date().toISOString();
}

// ---- Звірка з балансом Skinbux ----
// Skinbux не віддає депозитні адреси по API-ключу (лише панель з 2FA), тож
// перевірити "адреса досі наша" напряму не можна. Перевіряємо наслідок:
// після кожного зарахування клієнту доступний баланс Skinbux (/account/balance,
// працює по ключу) мав вирости на ту саму суму. Знімок балансу — щохвилини.
//   приріст = баланс зараз − баланс на момент створення рахунку
//           + витрачене на покупки з сайту за цей час (spentCentsBetween)
// Приріст ≥ 95% зарахованого — гроші дійшли. Не дійшли за VERIFY_MS — мережу
// на паузу і повідомлення власнику. Дійшли пізніше — пауза знімається сама.
// Хибна тривога можлива, якщо в ці хвилини ти сам вивів або витратив гроші
// в панелі Skinbux: тоді паузу знімає `node topup-resume.js <мережа>`.
const VERIFY_MS = 60 * 60 * 1000;
const VERIFY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_KEEP_MS = 26 * 60 * 60 * 1000;
const netName = (id) => (id === "trc20" ? "TRC-20" : "ERC-20");

function verifyCredits(state, now, spentCentsBetween, notify) {
  const snaps = state.snapshots;
  if (!snaps.length) return;
  const cur = snaps[snaps.length - 1];
  for (const inv of state.invoices) {
    if (inv.status !== "credited" || inv.verified || inv.verifyGaveUp) continue;
    const created = new Date(inv.createdAt).getTime();
    const start = [...snaps].reverse().find((s) => s.at <= created);
    // Немає знімка до рахунку (звірку щойно ввімкнули) — нема з чим порівняти.
    if (!start) {
      inv.verified = "no-baseline";
      continue;
    }
    const spent = spentCentsBetween(new Date(start.at).toISOString(), new Date(cur.at).toISOString()) || 0;
    const grown = cur.cents - start.cents + spent;
    const need = Math.round((inv.received || inv.amount) * 100 * 0.95 - (inv.feeUsd || 0) * 100);
    const age = now - new Date(inv.creditedAt).getTime();
    if (grown >= need) {
      inv.verified = new Date(now).toISOString();
      const p = state.paused[inv.network];
      if (p && p.invoiceId === inv.id) {
        delete state.paused[inv.network];
        notify(`✅ Пополнения ${netName(inv.network)} снова включены: $${inv.received.toFixed(2)} дошли до Skinbux (с опозданием).`).catch(() => {});
      }
    } else if (age > VERIFY_MS && !inv.verifyAlerted) {
      inv.verifyAlerted = new Date(now).toISOString();
      if (!state.paused[inv.network]) state.paused[inv.network] = { since: inv.verifyAlerted, invoiceId: inv.id };
      notify(
        `🛑 Пополнения ${netName(inv.network)} на паузе: клиенту ${inv.steamId} зачислено $${inv.credited.toFixed(2)} (TX ${inv.tx}), ` +
          `но баланс Skinbux за час вырос только на $${(grown / 100).toFixed(2)}.\n` +
          `Проверь в панели Skinbux → Top Up, что адрес ${netName(inv.network)} не поменялся и депозит есть.\n` +
          `Если ты сам выводил/тратил деньги на Skinbux и всё в порядке — на сервере: node topup-resume.js ${inv.network}`
      ).catch(() => {});
    } else if (age > VERIFY_GIVE_UP_MS) {
      inv.verifyGaveUp = true;
    }
  }
}

/**
 * Вручну прив'язати переказ "без рахунку" до клієнта (topup-match.js).
 * who — id рахунку або Steam ID (тоді беремо його останній відкритий/
 * прострочений рахунок у мережі переказу). Зараховує фактичну суму переказу.
 */
function manualMatch(tx, who) {
  const state = load();
  const rec = state.unmatched.find((u) => u.tx.toLowerCase() === String(tx).toLowerCase());
  if (!rec) throw new Error("Перевода с таким TX нет среди «без счёта»");
  let inv = state.invoices.find((i) => i.id === who);
  if (!inv) {
    inv = state.invoices
      .filter((i) => i.steamId === String(who) && i.network === rec.network && ["waiting", "expired", "replaced"].includes(i.status))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  }
  if (!inv) throw new Error("Не нашёл счёт клиента в этой сети — проверь Steam ID");
  creditInvoice(inv, { tx: rec.tx }, rec.amount);
  inv.manual = true;
  state.unmatched = state.unmatched.filter((u) => u !== rec);
  save(state);
  return inv;
}

/** Зняти паузу з мережі вручну (topup-resume.js). */
function resume(network) {
  const state = load();
  const was = state.paused[network] || null;
  delete state.paused[network];
  // Рахунок, через який стала пауза, більше не перевіряємо — інакше він
  // поставив би її знову.
  if (was) {
    const inv = state.invoices.find((i) => i.id === was.invoiceId);
    if (inv) inv.verified = "manual";
  }
  save(state);
  return was;
}

/**
 * Один прохід: нові перекази по всіх мережах, зарахування, прострочені
 * рахунки, звірка з балансом Skinbux. notify(text) — повідомлення власнику.
 * getAvailableCents() — доступний баланс Skinbux у центах;
 * spentCentsBetween(fromIso, toIso) — витрачене на покупки з сайту.
 */
async function scan(config, { notify = async () => {}, getAvailableCents = null, spentCentsBetween = () => 0 } = {}) {
  const cfg = settings(config);
  const state = load();
  const transfers = [];
  const errors = [];
  const readOk = (id) => delete state.readFail[id];
  const readFailed = (id) => {
    if (!state.readFail[id]) state.readFail[id] = new Date().toISOString();
  };
  if (cfg.networks.erc20.address) {
    try {
      transfers.push(...(await ethTransfers(state, cfg.networks.erc20.address, cfg.ercConfirmations)));
      readOk("erc20");
    } catch (err) {
      readFailed("erc20");
      errors.push(`ERC-20: ${err.message}`);
    }
  }
  if (cfg.networks.trc20.address) {
    try {
      transfers.push(...(await tronTransfers(state, cfg.networks.trc20.address)));
      readOk("trc20");
    } catch (err) {
      readFailed("trc20");
      errors.push(`TRC-20: ${err.message}`);
    }
  }

  const credited = [];
  for (const t of transfers.sort((a, b) => a.at - b.at)) {
    if (state.seen[t.key]) continue;
    state.seen[t.key] = new Date().toISOString();
    const usd = Number(t.micros) / 1e6;
    // Менше мінімуму Skinbux: вони можуть не зарахувати цей переказ (так
    // сталося з 24.97 при рахунку 25.57 — гаманець зрізав $0.60). Клієнту не
    // зараховуємо, власнику пишемо окремо: розбиратись зі Skinbux.
    if (usd < cfg.skinbuxMinUsd) {
      const near = matchInvoice(state, t);
      state.unmatched.push({ network: t.network, tx: t.tx, from: t.from, amount: round2(usd), at: new Date(t.at).toISOString(), belowMin: true });
      notify(
        `⚠️ Пришёл USDT ${t.network === "erc20" ? "ERC-20" : "TRC-20"} $${usd.toFixed(2)} — меньше минимума Skinbux ($${cfg.skinbuxMinUsd}). ` +
          `Skinbux может его не зачислить, поэтому клиенту${near ? ` ${near.inv.steamId} (счёт $${near.inv.amount.toFixed(2)})` : ""} НЕ зачислено.\n` +
          `Проверь в панели Skinbux → Top Up → Deposit history. Если Skinbux зачислил — на сервере: node topup-match.js ${t.tx} <Steam ID>\nTX ${t.tx}`
      ).catch(() => {});
      continue;
    }
    const match = matchInvoice(state, t);
    if (match) {
      const inv = match.inv;
      creditInvoice(inv, t, usd);
      if (match.loose) inv.loose = true;
      credited.push(inv);
      notify(
        `💵 Пополнение USDT ${t.network === "erc20" ? "ERC-20" : "TRC-20"}: $${inv.received.toFixed(2)} → клиенту ${inv.steamId} на trade-баланс $${inv.credited.toFixed(2)}` +
          (match.loose ? `\n(счёт был на $${inv.amount.toFixed(2)} — пришло меньше, похоже, биржа сняла комиссию; зачислено по факту)` : "") +
          `\nTX ${t.tx}`
      ).catch(() => {});
    } else {
      const rec = { network: t.network, tx: t.tx, from: t.from, amount: round2(usd), at: new Date(t.at).toISOString() };
      state.unmatched.push(rec);
      notify(
        `❓ Пришёл USDT ${t.network === "erc20" ? "ERC-20" : "TRC-20"} $${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} без подходящего счёта (сумма не совпала или счёт истёк).\nОт ${t.from}\nTX ${t.tx}\nЕсли это клиент — зачисли вручную в «Балансах клиентов» (кошелёк trade).`
      ).catch(() => {});
    }
  }

  const now = Date.now();
  // Поки мережа не читається, рахунки в ній не закриваємо: переказ, зроблений
  // вчасно, інакше після відновлення лишився б "без рахунку".
  for (const inv of state.invoices) {
    if (inv.status === "waiting" && !isOpen(inv, now) && !state.readFail[inv.network]) inv.status = "expired";
  }

  // Звірка: знімок балансу Skinbux і перевірка зарахованого. Не вдалось
  // прочитати баланс — просто пропускаємо раз, паузу через це не ставимо.
  if (getAvailableCents) {
    try {
      const cents = await getAvailableCents();
      if (Number.isFinite(cents)) {
        state.snapshots.push({ at: now, cents });
        state.snapshots = state.snapshots.filter((s) => now - s.at <= SNAPSHOT_KEEP_MS);
        verifyCredits(state, now, spentCentsBetween, notify);
      }
    } catch (err) {
      errors.push(`баланс Skinbux: ${err.message}`);
    }
  }
  save(state);
  return { transfers: transfers.length, credited: credited.length, errors };
}

module.exports = {
  settings,
  enabledNetworks,
  createInvoice,
  listFor,
  creditedFor,
  applyTo,
  totalsBySteamId,
  scan,
  resume,
  manualMatch,
  matchInvoice,
  TopupError,
  _FILE: FILE,
};
