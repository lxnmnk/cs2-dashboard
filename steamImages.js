// Автоматична картинка предмета по market_hash_name — використовується як
// зображення за замовчуванням на вітрині "Мої скіни в наявності", якщо
// власник не завантажив свій скріншот вручну (пріоритет: trade.image ->
// авто-картинка Steam). Результати кешуються на диск безстроково (картинка
// скіна не змінюється), щоб не бити по Steam при кожному відкритті сторінки.
//
// ⚠️ Раніше тут використовувався пошуковий API market/search/render — він
// НЕ повертає предмети, у яких зараз немає жодного активного лоту на
// продаж (типово для дорогих ножів/рукавиць — Pandora's Box, Superconductor
// у рідкісних якостях і т.п.), хоча предмет реально існує. Тому зараз
// ходимо напряму на сторінку лістингу (market/listings/730/<name>) — вона
// існує завжди, навіть для дорогих предметів (Steam для них редіректить на
// групову "кошикову" сторінку на кшталт G18A62720B54E3003, але іконка на
// ній все одно справжня) — і дістаємо іконку прямо з HTML.
const fs = require("fs");
const path = require("path");
const { stripPhaseSuffix } = require("./itemName");

const CACHE_FILE = path.join(__dirname, "steamImageCache.json");
const ICON_RE = /href="(https:\/\/community\.[^"]*\/economy\/image\/[^"/]+)"/;

let cache = loadCache();

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * @param {string} marketHashName
 * @returns {Promise<{thumb: string, full: string} | null>}
 */
async function getSteamImages(marketHashName) {
  // Синтетичний суфікс " - Phase N" (див. itemName.js) Steam не знає —
  // шукаємо по справжньому market_hash_name без нього.
  const { base: queryName } = stripPhaseSuffix(marketHashName);

  if (cache[queryName]) return cache[queryName];

  try {
    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(queryName)}`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;

    const html = await res.text();
    const iconBase = html.match(ICON_RE)?.[1];
    if (!iconBase) return null;

    const images = {
      thumb: `${iconBase}/96fx96f`,
      full: `${iconBase}/512fx512f`,
    };
    cache[queryName] = images;
    saveCache();
    return images;
  } catch {
    return null; // Steam недоступний/мережа лягла — просто без картинки цього разу
  }
}

module.exports = { getSteamImages };
