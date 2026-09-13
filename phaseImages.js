// Картинки для фаз Doppler / Gamma Doppler (Phase 1-4, Ruby, Sapphire,
// Emerald, Black Pearl).
//
// Навіщо окремо: на площадці Steam у ножа з Doppler одна сторінка на всі фази
// (market_hash_name у них однаковий, фаза живе в самому предметі), тому
// steamImages.js діставав одну й ту саму іконку — і Phase 2 на сайті виглядав
// як Phase 1. Тут беремо іконку саме потрібної фази з відкритого довідника
// ByMykel/CSGO-API, де кожна фаза — окремий запис.
//
// Довідник тягнемо один раз і кладемо у phaseImageCache.json (іконки не
// змінюються). Якщо назви в кеші немає — пробуємо оновити його, але не частіше
// разу на годину, щоб не бити по чужому серверу на кожен запит.
const fs = require("fs");
const path = require("path");

const SOURCE_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json";
const CACHE_FILE = path.join(__dirname, "phaseImageCache.json");
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

let cache = loadCache();
// Довідник цілком (усі скіни, не тільки фази) — тримаємо лише в пам'яті:
// на диск пишемо тільки фази, щоб файл лишався маленьким. Потрібен, бо Steam
// ріже часті запити за іконками, і на вітрині частина карток лишалась без
// картинки взагалі.
let allSkins = null;
let lastRefresh = 0;
let refreshing = null;

function loadCache() {
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
 * Тягне довідник і лишає тільки записи з фазою. Ключ — наш синтетичний
 * market_hash_name із суфіксом (див. itemName.js): "... (Factory New) - Phase 2".
 */
async function refresh() {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const res = await fetch(SOURCE_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`довідник скінів відповів ${res.status}`);
    const skins = await res.json();

    const next = {};
    const everything = {};
    for (const skin of skins) {
      if (!skin?.name || !skin?.image) continue;
      everything[skin.name] = skin.image;
      if (skin.phase) next[`${skin.name} - ${skin.phase}`] = skin.image;
    }
    if (!Object.keys(next).length) throw new Error("у довіднику немає жодної фази");

    cache = next;
    allSkins = everything;
    saveCache();
    console.log(
      `[phase-images] Оновлено довідник: ${Object.keys(everything).length} скінів, з них фаз ${Object.keys(cache).length}`
    );
  })()
    .catch((err) => {
      console.warn(`[phase-images] Не вдалося оновити довідник: ${err.message}`);
    })
    .finally(() => {
      lastRefresh = Date.now();
      refreshing = null;
    });

  return refreshing;
}

/**
 * Базова адреса іконки (без розміру) для назви з суфіксом фази або null.
 * @param {string} marketHashName — "★ Karambit | Doppler (Factory New) - Phase 2"
 */
async function getPhaseImageBase(marketHashName) {
  if (cache[marketHashName]) return cache[marketHashName];

  // Назви немає — можливо, кеш старий (вийшла нова колекція). Пробуємо оновити,
  // але не частіше разу на годину: у звичайному випадку фази вже всі в кеші.
  if (Date.now() - lastRefresh > REFRESH_COOLDOWN_MS) await refresh();
  return cache[marketHashName] || null;
}

/**
 * Базова адреса іконки для звичайного market_hash_name (без фази) або null.
 * Довідник знає тільки скіни — наклейки, агентів, кейси там не шукати, для них
 * лишається сторінка Steam (steamImages.js).
 */
async function getSkinImageBase(marketHashName) {
  if (!allSkins && Date.now() - lastRefresh > REFRESH_COOLDOWN_MS) await refresh();
  return allSkins?.[marketHashName] || null;
}

module.exports = { getPhaseImageBase, getSkinImageBase, refresh, CACHE_FILE };
