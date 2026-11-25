// Клиенты сайта (личный кабинет), которые вошли через Steam. Отдельно от
// users.json — там внутренние аккаунты владельца (lxnmnk/tarhun) для
// /arbitrage и /mytrades, тут — покупатели с публичных страниц.
const fs = require("fs");
const path = require("path");

const CUSTOMERS_FILE = path.join(__dirname, "customers.json");

function loadCustomers() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveCustomers(customers) {
  fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

// Заводит клиента при первом входе, на повторных — обновляет ник/аватар
// (они могут поменяться в Steam) и lastLoginAt.
function upsertBySteamId(steamId, profile) {
  const customers = loadCustomers();
  const now = new Date().toISOString();
  let customer = customers.find((c) => c.steamId === steamId);

  if (customer) {
    customer.displayName = profile.displayName;
    customer.avatar = profile.avatar;
    customer.profileUrl = profile.profileUrl;
    customer.lastLoginAt = now;
  } else {
    customer = {
      steamId,
      displayName: profile.displayName,
      avatar: profile.avatar,
      profileUrl: profile.profileUrl,
      createdAt: now,
      lastLoginAt: now,
    };
    customers.push(customer);
  }

  saveCustomers(customers);
  return customer;
}

function findBySteamId(steamId) {
  return loadCustomers().find((c) => c.steamId === steamId) || null;
}

// Ссылка на Steam-обмен клиента — нужна, чтобы Skinbux мог прислать ему
// автоматический трейд при продаже (see skinbuxTransactions.js). Не секрет
// (её и так можно случайно кому угодно скинуть, чтобы получить трейд),
// поэтому храним как есть, без шифрования.
const TRADE_URL_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/;

function isValidTradeUrl(url) {
  return typeof url === "string" && TRADE_URL_RE.test(url.trim());
}

// partner у trade-ссылке — это account id (младшие 32 бита SteamID64).
const STEAM64_BASE = 76561197960265728n;
function steamIdFromPartner(partner) {
  const s = String(partner ?? "");
  if (!/^\d{1,10}$/.test(s) || Number(s) <= 0 || Number(s) > 0xffffffff) return null;
  return String(STEAM64_BASE + BigInt(s));
}
function steamIdFromTradeUrl(url) {
  if (!isValidTradeUrl(url)) return null;
  return steamIdFromPartner(new URL(url.trim()).searchParams.get("partner"));
}

function setTradeUrl(steamId, tradeUrl) {
  if (!isValidTradeUrl(tradeUrl)) {
    throw new Error("Некоректне посилання на обмін Steam");
  }
  const customers = loadCustomers();
  const customer = customers.find((c) => c.steamId === steamId);
  if (!customer) throw new Error("Клієнт не знайдений");
  customer.tradeUrl = tradeUrl.trim();
  saveCustomers(customers);
  return customer;
}

// Все клиенты — для панели владельца (список балансов, подсказки по Steam ID).
function list() {
  return loadCustomers();
}

module.exports = { list, upsertBySteamId, findBySteamId, setTradeUrl, isValidTradeUrl, steamIdFromPartner, steamIdFromTradeUrl };
