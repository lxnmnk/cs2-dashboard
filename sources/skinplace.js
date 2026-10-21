// Цены skin.place — сколько они платят за предмет.
//
// Общего прайса у skin.place нет: цены выкупа видны только в их платёжной
// форме, и только для конкретного инвентаря. Форма грузит его запросом
// /widget/inventory по трейд-ссылке — им и пользуемся, по одному аккаунту
// за раз и только когда цену спросили (см. skinplaceLookup.js).
//
// Трейд-ссылка, а не Steam ID: Steam прячет из публичного инвентаря предметы
// под защитой сделки, а по трейд-ссылке skin.place их видит.
//
// Авторизация. Запрос работает от имени залогиненного на skin.place
// пользователя: браузер прикладывает куку сессии и парный к ней
// X-XSRF-TOKEN (стандартная защита Laravel от подделки запросов с чужих
// сайтов). Без них сервер отвечает 405. Поэтому берём куку владельца из .env
// (SKINPLACE_COOKIE) и шлём запрос от его же сессии — это он сам, просто из
// скрипта. Куку в логи не пишем никогда: по ней можно действовать от его
// имени, включая баланс на skin.place.
//
// Лимит у них — 15 запросов в минуту (заголовок X-Ratelimit-Limit). Держим
// не чаще раза в 5 секунд и кэшируем инвентарь, чтобы повторный вопрос про
// тот же аккаунт не уходил к ним вообще.
const API = "https://api.skin.place/widget/inventory";
const MIN_GAP_MS = 5000;
const INVENTORY_TTL_MS = 10 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

// Куки держим в памяти и обновляем по Set-Cookie: Laravel меняет XSRF-TOKEN
// почти на каждый ответ, и со старым следующий запрос вернул бы ошибку.
let jar = null;

function loadJar() {
  if (jar) return jar;
  jar = new Map();
  for (const part of String(process.env.SKINPLACE_COOKIE || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return jar;
}

function cookieHeader() {
  return [...loadJar().entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function xsrfHeader() {
  const raw = loadJar().get("XSRF-TOKEN");
  return raw ? decodeURIComponent(raw) : null;
}

function absorbSetCookie(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at > 0) loadJar().set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
}

let lastCall = 0;
let queue = Promise.resolve();

/** Запросы к skin.place идут строго по одному и с паузой — их лимит общий. */
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

const inventoryCache = new Map(); // partner -> { at, items, limits }

/** Номер аккаунта для трейд-ссылки из SteamID64 — простая разница, без steamid.io. */
function steamId64ToPartner(steamId64) {
  return (BigInt(String(steamId64)) - 76561197960265728n).toString();
}

/**
 * Трейд-ссылка на аккаунт. Токен skin.place не проверяет — им нужен только
 * номер аккаунта, чтобы найти инвентарь; обмен по этой ссылке никто не шлёт.
 */
function tradeLinkFor(partner) {
  return `https://steamcommunity.com/tradeoffer/new/?partner=${partner}&token=qqfvz`;
}

/**
 * Инвентарь аккаунта с ценами skin.place.
 * Возвращает { items, limits } или бросает понятную ошибку.
 */
async function fetchInventory(partner) {
  const cached = inventoryCache.get(partner);
  if (cached && Date.now() - cached.at < INVENTORY_TTL_MS) return cached;

  const publicKey = process.env.SKINPLACE_PUBLIC_KEY;
  if (!publicKey) throw new Error("SKINPLACE_PUBLIC_KEY не задан в .env");
  if (!loadJar().size) throw new Error("SKINPLACE_COOKIE не задан в .env");

  const tradeLink = tradeLinkFor(partner);
  const query = `?token=${publicKey}&account=${process.env.SKINPLACE_ACCOUNT || "123"}`;
  const url =
    `${API}?project=csgo&public_key=${encodeURIComponent(publicKey)}` +
    `&trade_link=${encodeURIComponent(tradeLink)}&query_params=${encodeURIComponent(query)}`;

  return throttled(async () => {
    const headers = {
      Accept: "application/json, text/plain, */*",
      Referer: "https://skin.place/",
      Origin: "https://skin.place",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": USER_AGENT,
      Cookie: cookieHeader(),
    };
    const xsrf = xsrfHeader();
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;

    const res = await fetch(url, { headers });
    absorbSetCookie(res);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`skin.place ответил не JSON (HTTP ${res.status}) — возможно, проверка Cloudflare`);
    }

    // 405/401 у них означает "не залогинен": кука протухла.
    if (res.status === 401 || res.status === 405 || res.status === 419) {
      throw new Error(
        `skin.place не принял сессию (HTTP ${res.status}). Кука в SKINPLACE_COOKIE устарела — ` +
          "зайди на skin.place, скопируй куку заново и перезапусти сервер."
      );
    }
    if (res.status === 429) throw new Error("skin.place: превышен лимит запросов, попробуй через минуту");
    if (data.status !== "success") {
      throw new Error(`skin.place: ${data.error_message || "ошибка"} (${data.errorcode || res.status})`);
    }

    const entry = {
      at: Date.now(),
      items: Array.isArray(data.inventory) ? data.inventory : [],
      limits: {
        minDeposit: data.min_instant_deposit ?? null,
        maxDeposit: data.max_instant_deposit ?? null,
      },
    };
    inventoryCache.set(partner, entry);
    return entry;
  });
}

module.exports = { fetchInventory, steamId64ToPartner, tradeLinkFor };
