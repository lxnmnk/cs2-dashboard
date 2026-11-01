// Автовыставление предметов владельца на CSFloat по цене Youpin.
//
// Раз в 4 часа (server.js):
//   1. берём инвентарь CSFloat-аккаунта (GET /me/inventory);
//   2. цена лота = Youpin ask этого предмета из таблицы (для доплеров — цена
//      своей фазы);
//   3. если Skinbux выкупает за 99%+ от Youpin — на CSFloat не выставляем:
//      проще и быстрее сдать на Skinbux. Уже выставленный нами лот в таком
//      случае снимаем;
//   4. наши лоты переоцениваем, если Youpin поменялся.
//
// Трогаем только лоты, которые выставили сами (csfloatAutoListings.json).
// Лоты, выставленные руками, не меняем. Если наш лот сняли руками и предмет
// вернулся в инвентарь — второй раз его не выставляем, человек так решил.
//
// Эндпоинты CSFloat взяты не из официальной документации (она недоступна), а
// из открытого клиента: POST /listings {asset_id, type, price}, PATCH
// /listings/:id {price}, DELETE /listings/:id, GET /listings/:id. Цены — в
// центах, как и везде в их API.
const fs = require("fs");
const path = require("path");
const { withPhase } = require("./csfloatPurchases");

const BASE_URL = process.env.CSFLOAT_BASE_URL || "https://csfloat.com";
const STATE_FILE = path.join(__dirname, "csfloatAutoListings.json");

const DEFAULTS = {
  intervalHours: 4,
  // Skinbux bid >= столько % от Youpin ask — не выставляем.
  skinbuxSkipPercent: 99,
  // Дешевле — не выставляем: мелочь (граффити, кейсы, наклейки) не стоит лота.
  minPrice: 5,
  // Названия (подстрокой), которые не выставлять никогда.
  exclude: [],
};
const CALL_GAP_MS = 1500;

function settings(config) {
  return { ...DEFAULTS, ...(config.csfloatAutoList || {}) };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { listings: {}, skipAssets: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;

async function api(apiKey, method, urlPath, body) {
  const res = await fetch(`${BASE_URL}/api/v1${urlPath}`, {
    method,
    headers: { Authorization: apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // не JSON — ниже отдадим кусок текста в ошибке
  }
  if (!res.ok) {
    const err = new Error(`CSFloat ${res.status} ${method} ${urlPath}: ${data?.message || text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Предмет инвентаря -> { assetId, rowKey, name, float, tradable }. */
function normalizeInventoryItem(it) {
  const name = it.market_hash_name || it.item?.market_hash_name || "";
  const raw = it.item ? it : { item: it };
  return {
    assetId: String(it.asset_id ?? it.item?.asset_id ?? ""),
    rowKey: withPhase(name, raw),
    name,
    float: it.float_value ?? it.item?.float_value ?? null,
    tradable: it.tradable ?? it.item?.tradable ?? null,
  };
}

/**
 * asset_id всех открытых лотов на нашем столе — чтобы не выставлять второй
 * раз то, что уже висит (выставлено руками). Не получилось прочитать стол —
 * пустое множество: тогда CSFloat сам откажет на повторный лот.
 */
async function stallListings(apiKey) {
  const byAsset = new Map();
  try {
    const me = await api(apiKey, "GET", "/me");
    const steamId = me?.user?.steam_id;
    if (!steamId) return byAsset;
    const stall = await api(apiKey, "GET", `/users/${steamId}/stall?limit=999`).catch(() =>
      api(apiKey, "GET", `/users/${steamId}/stall?limit=40`)
    );
    const list = Array.isArray(stall) ? stall : stall?.data || [];
    for (const l of list) {
      const assetId = String(l.item?.asset_id ?? "");
      if (assetId && l.id) byAsset.set(assetId, { listingId: String(l.id), price: Math.round(Number(l.price)) / 100 });
    }
  } catch (err) {
    console.warn("[csfloat-autolist] стол не прочитался:", err.message);
  }
  return byAsset;
}

/**
 * Решение по одному предмету: { price } — выставить/переоценить по этой цене,
 * { skip } — не выставлять (и снять, если наш лот висит), с причиной.
 */
function decide(item, row, cfg) {
  if (cfg.exclude.some((s) => item.rowKey.includes(s))) return { skip: "в списке исключений" };
  const youpin = row?.prices?.youpin?.ask;
  if (youpin == null) return { skip: "нет цены Youpin", keep: true };
  if (youpin < cfg.minPrice) return { skip: `дешевле $${cfg.minPrice}`, keep: true };
  const skinbux = row.prices.skinbux?.bid;
  if (skinbux != null && skinbux >= youpin * (cfg.skinbuxSkipPercent / 100)) {
    return {
      skip: `Skinbux $${skinbux.toFixed(2)} = ${Math.round((skinbux / youpin) * 1000) / 10}% от Youpin $${youpin.toFixed(2)} — лучше сдать на Skinbux`,
    };
  }
  return { price: round2(youpin) };
}

/**
 * Один проход. apply=false — только план, на CSFloat ничего не меняется.
 * adopt=true — лоты, выставленные руками, тоже берём под себя: переоцениваем
 * по Youpin и снимаем по правилу Skinbux, как свои. Без него их только
 * показываем — с текущей ценой рядом с ценой Youpin.
 * Возвращает отчёт { at, apply, actions: [{ action, name, float, price, reason }] }.
 */
async function run(rows, config, { apply = false, adopt = false } = {}) {
  const apiKey = process.env.CSFLOAT_API_KEY;
  if (!apiKey) throw new Error("CSFLOAT_API_KEY не задан в .env");
  if (!rows.length) throw new Error("цены ещё не загружены");

  const cfg = settings(config);
  const index = new Map(rows.map((r) => [r.marketHashName, r]));
  const state = loadState();
  const actions = [];
  const note = (action, item, extra = {}) =>
    actions.push({ action, name: item.rowKey || item.name, float: item.float ?? null, ...extra });

  // 1. Наши лоты: что с ними стало с прошлого раза.
  for (const [assetId, tracked] of Object.entries(state.listings)) {
    let listing;
    try {
      listing = await api(apiKey, "GET", `/listings/${tracked.listingId}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      listing = null;
    }
    if (!listing || listing.state !== "listed") {
      tracked.gone = listing?.state || "removed";
    }
  }

  // 2. Инвентарь. Выставленные предметы в нём тоже бывают — их отличаем по
  //    нашему списку.
  const inventoryRaw = await api(apiKey, "GET", "/me/inventory");
  const inventory = (Array.isArray(inventoryRaw) ? inventoryRaw : inventoryRaw?.data || inventoryRaw?.items || [])
    .map(normalizeInventoryItem)
    .filter((it) => it.assetId && it.name);
  const inInventory = new Set(inventory.map((it) => it.assetId));
  const listedByHand = await stallListings(apiKey);

  for (const [assetId, tracked] of Object.entries(state.listings)) {
    if (!tracked.gone) continue;
    // Лот исчез, а предмет снова у нас — сняли руками: больше не выставляем.
    if (tracked.gone !== "sold" && inInventory.has(assetId)) {
      state.skipAssets[assetId] = { name: tracked.name, at: new Date().toISOString(), why: "лот сняли руками" };
      note("forget", tracked, { reason: "лот сняли руками — больше не выставляю" });
    } else {
      note("forget", tracked, { reason: tracked.gone === "sold" ? "продан" : "лота больше нет" });
    }
    if (apply) delete state.listings[assetId];
  }

  // 3. Каждый предмет: выставить, переоценить, снять или пропустить. Наши
  //    висящие лоты проверяем, даже если CSFloat не показывает их в инвентаре.
  const candidates = [...inventory];
  for (const [assetId, tracked] of Object.entries(state.listings)) {
    if (tracked.gone || inInventory.has(assetId)) continue;
    candidates.push({ assetId, rowKey: tracked.name, name: tracked.name, float: tracked.float ?? null, tradable: null });
  }
  for (const item of candidates) {
    let tracked = state.listings[item.assetId];
    let live = tracked && !tracked.gone;
    if (state.skipAssets[item.assetId]) continue;
    const hand = !live && listedByHand.get(item.assetId);
    if (hand && !adopt) {
      const v = decide(item, index.get(item.rowKey), cfg);
      note("skip", item, { reason: "уже выставлен руками", listedPrice: hand.price, youpinPrice: v.price ?? null });
      continue;
    }
    if (hand) {
      // Берём под себя: дальше он живёт как наш лот (в плане — только в памяти).
      const now = new Date().toISOString();
      tracked = { listingId: hand.listingId, name: item.rowKey, float: item.float, price: hand.price, adoptedAt: now, updatedAt: now };
      state.listings[item.assetId] = tracked;
      live = true;
    }
    // У CSFloat tradable бывает и false, и 0.
    if (!live && item.tradable != null && !item.tradable) {
      note("skip", item, { reason: "под трейдлоком" });
      continue;
    }

    const verdict = decide(item, index.get(item.rowKey), cfg);

    if (verdict.price != null) {
      if (live) {
        if (Math.abs(verdict.price - tracked.price) < 0.01) continue;
        note("reprice", item, { price: verdict.price, was: tracked.price });
        if (apply) {
          try {
            await api(apiKey, "PATCH", `/listings/${tracked.listingId}`, { price: Math.round(verdict.price * 100) });
            Object.assign(tracked, { price: verdict.price, updatedAt: new Date().toISOString() });
          } catch (err) {
            actions[actions.length - 1].error = err.message;
          }
          await sleep(CALL_GAP_MS);
        }
      } else {
        note("list", item, { price: verdict.price });
        if (apply) {
          try {
            const res = await api(apiKey, "POST", "/listings", {
              asset_id: item.assetId,
              type: "buy_now",
              price: Math.round(verdict.price * 100),
            });
            const listingId = res?.id ?? res?.listing?.id;
            if (!listingId) throw new Error("CSFloat не вернул id лота");
            state.listings[item.assetId] = {
              listingId: String(listingId),
              name: item.rowKey,
              float: item.float,
              price: verdict.price,
              listedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          } catch (err) {
            actions[actions.length - 1].error = err.message;
          }
          await sleep(CALL_GAP_MS);
        }
      }
    } else if (live && !verdict.keep) {
      note("delist", item, { price: tracked.price, reason: verdict.skip });
      if (apply) {
        try {
          await api(apiKey, "DELETE", `/listings/${tracked.listingId}`);
          delete state.listings[item.assetId];
        } catch (err) {
          actions[actions.length - 1].error = err.message;
        }
        await sleep(CALL_GAP_MS);
      }
    } else if (!live) {
      note("skip", item, { reason: verdict.skip });
    }
  }

  if (apply) saveState(state);
  return { at: new Date().toISOString(), apply, inventory: inventory.length, actions };
}

/** Короткая сводка для лога: сколько чего. */
function summary(report) {
  const count = (a) => report.actions.filter((x) => x.action === a && !x.error).length;
  const errors = report.actions.filter((x) => x.error).length;
  return `${report.apply ? "" : "план (ничего не менялось): "}выставлено ${count("list")}, переоценено ${count("reprice")}, снято ${count("delist")}, пропущено ${count("skip")}${errors ? `, ошибок ${errors}` : ""}`;
}

module.exports = { run, summary, settings, decide };
