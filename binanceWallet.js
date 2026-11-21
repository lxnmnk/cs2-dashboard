// Гаманець Binance власника — звідси платимо клієнтам у крипті.
//
// Skinbux дозволяє виводити лише на власний гаманець, не клієнтам напряму
// (відповідь підтримки, 21.11.2026). Тому гроші йдуть так:
//   Skinbux -> наш Binance (вивід на свій гаманець, руками власника)
//   Binance -> клієнт (тут, через API: POST /sapi/v1/capital/withdraw/apply).
//
// Ключ: BINANCE_API_KEY / BINANCE_API_SECRET у .env на сервері. Права —
// лише "Reading" і "Enable Withdrawals", без торгівлі; Binance вмикає вивід
// тільки з прив'язкою ключа до IP сервера. Білий список адрес на Binance має
// бути вимкнений: адреси клієнтів наперед не додаси.
//
// Комісію мережі Binance бере з самої суми виводу: amount = 100 -> клієнт
// отримає 100 − withdrawFee. Тому клієнту показуємо реальну комісію мережі
// (з /capital/config/getall), а не вигадану.
//
// Ідемпотентність: у кожного виводу свій withdrawOrderId ("sale-<id>",
// "wd-<uuid>", "hold-<id>"). Статус і чи взагалі вивід створено — шукаємо в
// історії саме за ним. Повторно той самий вивід НЕ відправляємо: таймаут —
// чекаємо, поки з'явиться в історії.
const crypto = require("crypto");

const BASE = "https://api.binance.com";
const TIMEOUT_MS = 20000;
const RECV_WINDOW = 10000;

// Мережа з payoutDetails.js -> монета й мережа Binance.
const NETWORKS = {
  "usdt-trc20": { coin: "USDT", network: "TRX", label: "USDT TRC-20" },
  "usdt-erc20": { coin: "USDT", network: "ETH", label: "USDT ERC-20" },
  "usdt-bep20": { coin: "USDT", network: "BSC", label: "USDT BEP-20" },
  "usdt-sol": { coin: "USDT", network: "SOL", label: "USDT Solana" },
  "usdc-trc20": { coin: "USDC", network: "TRX", label: "USDC TRC-20" },
  "usdc-erc20": { coin: "USDC", network: "ETH", label: "USDC ERC-20" },
  "usdc-bep20": { coin: "USDC", network: "BSC", label: "USDC BEP-20" },
};

// Статус виводу Binance (число) -> наш.
//   0 Email Sent, 2 Awaiting Approval, 4 Processing — ще йде;
//   6 Completed — дійшло; 1 Cancelled, 3 Rejected, 5 Failure — гроші на місці.
function mapStatus(code) {
  const n = Number(code);
  if (n === 6) return "paid";
  if (n === 3) return "rejected";
  if (n === 1 || n === 5) return "failed";
  if (n === 4) return "processing";
  return "pending";
}

function credentials() {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  return key && secret ? { key, secret } : null;
}

function configured() {
  return !!credentials();
}

class BinanceError extends Error {
  constructor(message, { status = null, code = null, ambiguous = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // ambiguous — невідомо, чи дійшов запит (таймаут, 5xx): вивід міг
    // створитись, перевіряємо історією, а не повтором.
    this.ambiguous = ambiguous;
  }
}

async function signed(method, path, params = {}) {
  const cred = credentials();
  if (!cred) throw new BinanceError("BINANCE_API_KEY / BINANCE_API_SECRET не заданы");
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
  query.set("recvWindow", String(RECV_WINDOW));
  query.set("timestamp", String(Date.now()));
  const signature = crypto.createHmac("sha256", cred.secret).update(query.toString()).digest("hex");
  const url = `${BASE}${path}?${query.toString()}&signature=${signature}`;
  let res;
  try {
    res = await fetch(url, { method, headers: { "X-MBX-APIKEY": cred.key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new BinanceError(`Binance не ответил: ${err.message}`, { ambiguous: true });
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const msg = data?.msg || `HTTP ${res.status}`;
  // -1007: "Timeout waiting for response from backend" — результат невідомий.
  const ambiguous = res.status >= 500 || data?.code === -1007;
  throw new BinanceError(msg, { status: res.status, code: data?.code ?? null, ambiguous });
}

// ---- Монети: залишок, комісія й мінімум по мережах ----
// Кеш на 10 хвилин: комісії Binance міняються рідко, а показуємо їх на кожному
// відкритті профілю.
const COINS_TTL_MS = 10 * 60 * 1000;
let coinsCache = null;

// Депозити Binance за замовчуванням падають у Funding, а не в Spot. Вивести
// можна з будь-якого (walletType 0 — Spot, 1 — Funding), тож читаємо обидва:
// getall дає вільне на Spot, get-funding-asset — на Funding.
async function coins({ force = false } = {}) {
  if (!force && coinsCache && Date.now() - coinsCache.at < COINS_TTL_MS) return coinsCache.list;
  const [list, funding] = await Promise.all([signed("GET", "/sapi/v1/capital/config/getall"), signed("POST", "/sapi/v1/asset/get-funding-asset")]);
  const fundingFree = {};
  for (const f of Array.isArray(funding) ? funding : []) fundingFree[f.asset] = Number(f.free) || 0;
  const merged = (Array.isArray(list) ? list : []).map((c) => ({ ...c, spotFree: Number(c.free) || 0, fundingFree: fundingFree[c.coin] || 0 }));
  coinsCache = { at: Date.now(), list: merged };
  return coinsCache.list;
}

// Один вивід бере гроші з одного гаманця: "вільно" — більший із двох.
const freeOf = (coin) => Math.max(coin?.spotFree || 0, coin?.fundingFree || 0);

/**
 * Умови виводу в мережу (id з NETWORKS): чи відкритий вивід, комісія,
 * мінімум і скільки монети вільно. null — такої мережі в Binance немає.
 */
async function quote(networkId, opts) {
  const n = NETWORKS[networkId];
  if (!n) return null;
  const coin = (await coins(opts)).find((c) => c.coin === n.coin);
  const net = coin?.networkList?.find((x) => x.network === n.network);
  if (!net) return null;
  return {
    enabled: !!net.withdrawEnable,
    fee: Number(net.withdrawFee) || 0,
    min: Number(net.withdrawMin) || 0,
    free: freeOf(coin),
    // Крок суми: більшість мереж — 0.01 чи дрібніше.
    step: Number(net.withdrawIntegerMultiple) || 0,
  };
}

/** Останній відомий quote без запиту — для швидких відповідей сторінкам. */
function cachedQuote(networkId) {
  if (!coinsCache) return null;
  const n = NETWORKS[networkId];
  const coin = coinsCache.list.find((c) => c.coin === n?.coin);
  const net = coin?.networkList?.find((x) => x.network === n.network);
  if (!net) return null;
  return { enabled: !!net.withdrawEnable, fee: Number(net.withdrawFee) || 0, min: Number(net.withdrawMin) || 0, free: freeOf(coin) };
}

/** Після виводу залишок змінився — наступний quote читаємо наново. */
function invalidate() {
  coinsCache = null;
}

// ---- Вивід ----
/**
 * Створити вивід. amount — скільки списати з Binance (клієнт отримає
 * amount − комісія мережі). Повертає { id }. Помилка — BinanceError;
 * ambiguous: true — невідомо, чи створено (шукати в історії за orderId).
 */
async function withdraw({ networkId, address, amount, orderId }) {
  const n = NETWORKS[networkId];
  if (!n) throw new BinanceError(`Мережа ${networkId} не підтримується`);
  // З якого гаманця: Funding, якщо там вистачає (туди падають депозити), інакше Spot.
  const coin = (await coins({ force: true })).find((c) => c.coin === n.coin);
  const walletType = (coin?.fundingFree || 0) + 0.000001 >= Number(amount) ? 1 : 0;
  const data = await signed("POST", "/sapi/v1/capital/withdraw/apply", {
    coin: n.coin,
    network: n.network,
    address,
    amount: Number(amount).toFixed(2),
    withdrawOrderId: orderId,
    walletType,
  });
  invalidate();
  return { id: data?.id ?? null };
}

/**
 * Знайти вивід за нашим orderId. since — коли ми його створювали (Binance
 * шукає за orderId лише у вікні до 7 днів). Повертає null, якщо не знайдено.
 */
async function findWithdrawal(orderId, since) {
  const start = since ? new Date(since).getTime() - 60 * 60 * 1000 : Date.now() - 6 * 86400000;
  const end = Math.min(Date.now(), start + 6.9 * 86400000);
  const list = await signed("GET", "/sapi/v1/capital/withdraw/history", { withdrawOrderId: orderId, startTime: Math.floor(start), endTime: Math.floor(end) });
  const w = (Array.isArray(list) ? list : []).find((x) => x.withdrawOrderId === orderId);
  if (!w) return null;
  return {
    id: w.id,
    status: mapStatus(w.status),
    rawStatus: w.status,
    amount: Number(w.amount),
    fee: Number(w.transactionFee),
    txId: w.txId || null,
    info: w.info || null,
  };
}

// ---- Адреса депозиту — куди Skinbux поповнює наш Binance ----
// Беремо з API самого Binance, а не з конфігу: так поповнення гарантовано
// йде на наш гаманець, а не на адресу, яку хтось вписав руками.
const depositCache = new Map();

/** Адреса депозиту монети coin ("USDT"/"USDC") у мережі network ("ETH"/"TRX"). */
async function depositAddress(coin, network) {
  const key = `${coin}-${network}`;
  if (depositCache.has(key)) return depositCache.get(key);
  const d = await signed("GET", "/sapi/v1/capital/deposit/address", { coin, network });
  if (!d?.address) throw new BinanceError(`Binance не дал адрес депозита ${coin} ${network}`);
  if (d.tag) throw new BinanceError(`Адрес депозита ${coin} ${network} требует memo — Skinbux его не передаёт`);
  depositCache.set(key, d.address);
  return d.address;
}

module.exports = { NETWORKS, configured, coins, quote, cachedQuote, invalidate, withdraw, findWithdrawal, depositAddress, mapStatus, BinanceError };
