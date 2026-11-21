// Автовыставление предметов владельца на CSFloat по цене Youpin.
//
// Раз в 4 часа (server.js):
//   1. берём инвентарь CSFloat-аккаунта (GET /me/inventory);
//   2. цена лота = Youpin ask этого предмета из таблицы (для доплеров — цена
//      своей фазы), но не ниже лучшего бай-ордера CSFloat под этот float;
//   3. если Skinbux выкупает за 99%+ от Youpin — на CSFloat не выставляем:
//      проще и быстрее сдать на Skinbux. Уже выставленный нами лот в таком
//      случае снимаем;
//   4. наши лоты переоцениваем, если Youpin поменялся.
//
// Трогаем только лоты, которые выставили сами (csfloatAutoListings.json).
// Лоты, выставленные руками, не меняем (кроме режима adopt). Если наш лот
// сняли руками или поменяли ему цену — больше его не трогаем, человек так
// решил.
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
  // Сувениры не выставляем вообще: средняя цена Youpin для них ничего не
  // значит — всё решают наклейки (так решил владелец).
  excludeSouvenir: true,
  // Цена лота не ниже лучшего бай-ордера CSFloat под этот предмет плюс
  // столько %. 0 — ровно по бай-ордеру.
  buyOrderMarkupPercent: 0,
  // Низкий флоат внутри своего износа (первые N% диапазона, напр. FT 0.150–0.173)
  // стоит дороже средней цены Youpin — такие не выставляем и чужие (ручные)
  // лоты с ними не трогаем: цену ставит человек. 0 — выключено.
  lowFloatSkipPercent: 10,
};

// Диапазоны флоата по износу.
const WEAR_RANGES = {
  "Factory New": [0, 0.07],
  "Minimal Wear": [0.07, 0.15],
  "Field-Tested": [0.15, 0.38],
  "Well-Worn": [0.38, 0.45],
  "Battle-Scarred": [0.45, 1],
};

/** Флоат в первых pct% своего износа — премиальный, цену ставит человек. */
function premiumFloat(item, pct) {
  if (!pct || !Number.isFinite(Number(item.float))) return false;
  const wear = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)/.exec(item.name || item.rowKey || "");
  if (!wear) return false;
  const [lo, hi] = WEAR_RANGES[wear[1]];
  return Number(item.float) < lo + ((hi - lo) * pct) / 100;
}
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
 * Всё, что CSFloat видит на аккаунте: инвентарь и выставленные лоты стола —
 * [{ marketHashName (с фазой доплера, как в трекере), float }]. Для сверки
 * трекера с инвентарём (tradeFloats.mergeInventories): Skinbux выставленные
 * на CSFloat предметы не показывает. Только чтение.
 */
async function ownedItems(apiKey) {
  const out = [];
  const add = (raw) => {
    const it = normalizeInventoryItem(raw);
    if (it.name && it.float != null) out.push({ marketHashName: it.rowKey, float: Number(it.float), source: "csfloat" });
  };
  const inv = await api(apiKey, "GET", "/me/inventory");
  for (const raw of Array.isArray(inv) ? inv : inv?.data || inv?.items || []) add(raw);
  const me = await api(apiKey, "GET", "/me");
  const steamId = me?.user?.steam_id;
  if (steamId) {
    const stall = await api(apiKey, "GET", `/users/${steamId}/stall?limit=999`).catch(() =>
      api(apiKey, "GET", `/users/${steamId}/stall?limit=40`)
    );
    for (const l of Array.isArray(stall) ? stall : stall?.data || []) if (l.item) add(l.item);
  }
  return out;
}

/**
 * Самый дорогой бай-ордер CSFloat, под который подходит этот предмет (с учётом
 * float-диапазонов ордеров), в долларах; 0 — ордеров нет. Висит наш лот —
 * спрашиваем ордера этого лота; нет — similar-orders с float предмета (то, что
 * показывает CSFloat в «Create Buy Order»). Ошибка — пробрасываем: без пола
 * цены не выставляем.
 */
async function topBuyOrder(apiKey, item, listingId) {
  let orders;
  if (listingId) {
    orders = await api(apiKey, "GET", `/listings/${listingId}/buy-orders?limit=1`);
  } else {
    const body = { market_hash_name: item.name };
    // CSFloat требует min_float < max_float — берём крошечный диапазон вокруг float.
    if (Number.isFinite(item.float)) {
      body.hybrid_properties = { min_float: Math.max(0, item.float - 1e-6), max_float: Math.min(1, item.float + 1e-6) };
    }
    orders = await api(apiKey, "POST", "/buy-orders/similar-orders?limit=1", body);
  }
  const list = Array.isArray(orders) ? orders : orders?.data || [];
  const best = Math.max(0, ...list.map((o) => Number(o.price) || 0));
  return best / 100;
}

/** Причина не выставлять, которая не зависит от рынка CSFloat, или null. */
function precheck(item, row, cfg) {
  if (cfg.exclude.some((s) => item.rowKey.includes(s))) return { skip: "в списке исключений" };
  if (cfg.excludeSouvenir && item.rowKey.startsWith("Souvenir ")) return { skip: "сувениры не выставляем" };
  const youpin = row?.prices?.youpin?.ask;
  if (youpin == null) return { skip: "нет цены Youpin", keep: true };
  if (youpin < cfg.minPrice) return { skip: `дешевле $${cfg.minPrice}`, keep: true };
  return null;
}

/**
 * Решение по одному предмету: { price } — выставить/переоценить по этой цене,
 * { skip } — не выставлять (и снять, если наш лот висит), с причиной.
 * Цена = Youpin ask, но не ниже лучшего бай-ордера CSFloat (bid) + наценка:
 * продавать дешевле, чем за предмет уже готовы заплатить, — дарить разницу.
 */
function decide(item, row, cfg, bid = 0) {
  const pre = precheck(item, row, cfg);
  if (pre) return pre;
  const youpin = row.prices.youpin.ask;
  const floor = bid > 0 ? bid * (1 + cfg.buyOrderMarkupPercent / 100) : 0;
  const price = round2(Math.max(youpin, floor));
  const basis = floor > youpin ? `бай-ордер CSFloat $${bid.toFixed(2)}` : `Youpin $${youpin.toFixed(2)}`;
  const skinbux = row.prices.skinbux?.bid;
  if (skinbux != null && skinbux >= price * (cfg.skinbuxSkipPercent / 100)) {
    return {
      skip: `Skinbux $${skinbux.toFixed(2)} = ${Math.round((skinbux / price) * 1000) / 10}% от цены лота $${price.toFixed(2)} (${basis}) — лучше сдать на Skinbux`,
    };
  }
  return { price, basis };
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
    } else if (Number.isFinite(Number(listing.price)) && Math.round(Number(listing.price)) !== Math.round(tracked.price * 100)) {
      // Цену поменяли руками — это решение человека: лот больше не наш,
      // не переоцениваем и не снимаем (и режим all второй раз его не возьмёт).
      const handPrice = Math.round(Number(listing.price)) / 100;
      state.skipAssets[assetId] = { name: tracked.name, at: new Date().toISOString(), why: `цену поменяли руками на $${handPrice}` };
      note("forget", tracked, { price: handPrice, was: tracked.price, reason: "цену поменяли руками — больше не трогаю" });
      delete state.listings[assetId];
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
    // Лот исчез не продажей (сняли руками, отменили продажу — refunded) —
    // это решение человека: больше не выставляем. Не важно, видно ли предмет
    // в инвентаре: его могли сразу перевыставить руками или он ещё в трейде.
    if (tracked.gone !== "sold") {
      const why = tracked.gone === "refunded" ? "продажу отменили" : "лот сняли руками";
      state.skipAssets[assetId] = { name: tracked.name, at: new Date().toISOString(), why };
      note("forget", tracked, { reason: `${why} — больше не выставляю` });
    } else {
      // Продан — но покупку ещё могут отменить (продавец отменил продажу,
      // покупатель не принял трейд). Тогда тот же asset_id вернётся в
      // инвентарь, а лота мы уже не отслеживаем и увидеть "refunded" не
      // сможем — без этой отметки бот выставлял бы его снова (так дважды
      // продались перчатки, и отмена стоила штраф 4%). После завершённого
      // трейда asset_id в инвентаре больше не встречается, отметка безвредна.
      state.skipAssets[assetId] = { name: tracked.name, at: new Date().toISOString(), why: "продан — если продажу отменили, заново не выставляю" };
      note("forget", tracked, { reason: "продан" });
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
    if (state.skipAssets[item.assetId]) {
      note("skip", item, { reason: state.skipAssets[item.assetId].why });
      continue;
    }
    // Премиальный флоат: не выставляем, не берём под себя ручной лот и не
    // переоцениваем свой (средняя цена Youpin его недооценивает).
    if (premiumFloat(item, cfg.lowFloatSkipPercent)) {
      note("skip", item, { reason: `низкий флоат ${Number(item.float).toFixed(4)} — цену ставлю не я` });
      continue;
    }
    // Исключения владельца (config csfloatAutoList.exclude): не выставляем и
    // не берём под себя даже в режиме all — иначе ручной лот такого предмета
    // режим adopt снял бы как «исключённый». Наш собственный лот снимется
    // ниже, через precheck.
    if (!live && cfg.exclude.some((s) => item.rowKey.includes(s))) {
      note("skip", item, { reason: "в списке исключений — не трогаю" });
      continue;
    }
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

    const row = index.get(item.rowKey);
    let verdict = precheck(item, row, cfg);
    if (!verdict) {
      let bid;
      try {
        bid = await topBuyOrder(apiKey, item, live ? tracked.listingId : null);
      } catch (err) {
        // Без пола цены не выставляем и не переоцениваем: лучше пропустить
        // проход, чем отдать дешевле бай-ордера.
        note("skip", item, { reason: "бай-ордера CSFloat не прочитались — не трогаю", error: err.message });
        await sleep(CALL_GAP_MS);
        continue;
      }
      await sleep(CALL_GAP_MS);
      verdict = decide(item, row, cfg, bid);
    }

    if (verdict.price != null) {
      if (live) {
        if (Math.abs(verdict.price - tracked.price) < 0.01) continue;
        note("reprice", item, { price: verdict.price, was: tracked.price, reason: verdict.basis });
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
        note("list", item, { price: verdict.price, reason: verdict.basis });
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
            // Предмет уже в трейде — значит, его купили (в т.ч. по лоту, который
            // мы перестали отслеживать). Если продажу отменят, не выставляем.
            if (/is being traded/i.test(err.message)) {
              state.skipAssets[item.assetId] = { name: item.rowKey, at: new Date().toISOString(), why: "был в трейде (продан) — заново не выставляю" };
            }
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

module.exports = { run, summary, settings, decide, api, topBuyOrder, ownedItems };
