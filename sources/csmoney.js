// Источник: cs.money — два публичных эндпоинта, ключ не требуется.
//   instantsell/price/all — цена мгновенного выкупа cs.money у вас (bid)
//   min_price/market/all  — минимальная цена среди активных лотов маркета (ask)
//
// У cs.money стоит защита Cloudflare, которая блокирует обычные запросы
// из Node.js (403), даже с браузерными заголовками — она смотрит на
// TLS-отпечаток клиента, который у Node всегда отличается от настоящего
// Chrome. Поэтому: сначала пробуем быстрый прямой запрос (вдруг не заблокирован
// в этот раз), а если словили 403 — открываем страницу через headless Chrome
// (puppeteer), у которого TLS-отпечаток настоящий, и Cloudflare его пропускает.
const puppeteer = require("puppeteer");
const { DOPPLER_PHASES } = require("../itemName");

const INSTANTSELL_URL = "https://cs.money/api/public/v1/instantsell/price/all";
const MIN_PRICE_URL = "https://cs.money/api/min_price/market/all";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * cs.money вставляет фазу Doppler/Gamma Doppler прямо в название перед
 * качеством, без разделителя: "Glock-18 | Gamma Doppler Phase 1 (Factory New)".
 * Причём у cs.money вообще НЕТ усреднённой цены без фазы для этих предметов —
 * только по конкретным фазам. Приводим формат к единому виду с skinbux
 * ("... (Factory New) - Phase 1"), чтобы фазовые строки из разных источников
 * схлопывались в одну строку таблицы, а не создавали дубли.
 */
function normalizePhaseName(rawName) {
  const match = rawName.match(/^(.*)\s\(([^)]+)\)$/);
  if (!match) return rawName;
  const [, beforeParen, wear] = match;

  for (const phase of DOPPLER_PHASES) {
    if (beforeParen.endsWith(` ${phase}`)) {
      const base = beforeParen.slice(0, -(phase.length + 1));
      return `${base} (${wear}) - ${phase}`;
    }
  }

  return rawName;
}

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

// instantsell/price/all: { items: [{ name, price }, ...] }
function bidMapFromInstantsell(data) {
  const map = new Map();
  for (const item of data.items || []) {
    const price = parseFloat(item.price);
    if (!Number.isNaN(price)) {
      map.set(normalizePhaseName(item.name), price);
    }
  }
  return map;
}

// min_price/market/all: { "<name>": { price, marketCount, ... }, ... } — плоский
// объект, а не массив; price — минимальная цена среди активных лотов (ask).
function askMapFromMinPrice(data) {
  const map = new Map();
  for (const [name, entry] of Object.entries(data || {})) {
    const price = parseFloat(entry?.price);
    if (!Number.isNaN(price)) {
      map.set(normalizePhaseName(name), price);
    }
  }
  return map;
}

async function fetchViaHttp(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://cs.money/",
      Origin: "https://cs.money",
    },
  });

  if (!res.ok) {
    throw new Error(`прямой запрос ${url}: cs.money ответил ${res.status}`);
  }

  return res.json();
}

async function fetchViaBrowser(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    if (!response || !response.ok()) {
      throw new Error(`headless-браузер ${url}: cs.money ответил ${response ? response.status() : "нет ответа"}`);
    }

    // Chrome показывает "сырой" JSON-ответ внутри <pre> — читаем текст страницы целиком
    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
  } finally {
    await page.close();
  }
}

async function fetchJson(url) {
  try {
    return await fetchViaHttp(url);
  } catch (err) {
    console.warn(`[csmoney] ${err.message} — пробую через headless-браузер...`);
    return await fetchViaBrowser(url);
  }
}

/**
 * Возвращает Map<market_hash_name, { ask, bid }>. Оба эндпоинта тянутся
 * параллельно и независимо — если один из двух недоступен, второй всё равно
 * отдаёт свою сторону цены (частичные данные лучше, чем ничего), ошибка
 * бросается только если недоступны оба сразу.
 */
async function fetchCsMoneyLatest() {
  const [instantsellResult, minPriceResult] = await Promise.allSettled([
    fetchJson(INSTANTSELL_URL),
    fetchJson(MIN_PRICE_URL),
  ]);

  if (instantsellResult.status === "rejected") {
    console.warn(`[csmoney] сторона bid (instantsell) недоступна: ${instantsellResult.reason.message}`);
  }
  if (minPriceResult.status === "rejected") {
    console.warn(`[csmoney] сторона ask (min_price) недоступна: ${minPriceResult.reason.message}`);
  }
  if (instantsellResult.status === "rejected" && minPriceResult.status === "rejected") {
    throw new Error(`оба эндпоинта cs.money недоступны: ${instantsellResult.reason.message} | ${minPriceResult.reason.message}`);
  }

  const bidMap = instantsellResult.status === "fulfilled" ? bidMapFromInstantsell(instantsellResult.value) : new Map();
  const askMap = minPriceResult.status === "fulfilled" ? askMapFromMinPrice(minPriceResult.value) : new Map();

  const names = new Set([...bidMap.keys(), ...askMap.keys()]);
  const map = new Map();
  for (const name of names) {
    map.set(name, { ask: askMap.get(name) ?? null, bid: bidMap.get(name) ?? null });
  }
  return map;
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { fetchCsMoneyLatest, closeBrowser };
