const { parseItemName, stripPhaseSuffix } = require("./itemName");

/**
 * Сводит цены из всех источников в единую построчную таблицу и считает
 * лучшую связку "купить дешевле / продать дороже" с учётом комиссий.
 *
 * @param {Object} cs2shItems - результат fetchCs2ShLatest(): { name: {buff, youpin, csfloat} }
 * @param {Map}    csMoneyMap - результат fetchCsMoneyLatest(): name -> {ask, bid}
 * @param {Map}    skinbuxMap - результат fetchSkinbuxLatest(): name -> {ask, bid}
 * @param {Object} config     - config.json
 */
function buildRows(cs2shItems, csMoneyMap, skinbuxMap, config) {
  const rows = [];
  const names = new Set([
    ...Object.keys(cs2shItems),
    ...csMoneyMap.keys(),
    ...skinbuxMap.keys(),
  ]);

  for (const marketHashName of names) {
    // Фазовые строки (Doppler/Gamma Doppler по конкретной фазе) — синтетические
    // ключи вида "<market_hash_name> - <Phase>". Все источники дают реальные
    // цены по фазам (cs2.sh — в item.variants, см. sources/cs2sh.js; cs.money —
    // прямо в названии, см. sources/csmoney.js; skinbux — отдельным полем phase),
    // поэтому ищем везде по ТОЧНОМУ имени строки. lookupName (без суффикса) нужен
    // только для ссылок на площадки — сама фаза не часть настоящего market_hash_name.
    const { base: lookupName, phase } = stripPhaseSuffix(marketHashName);
    const cs2sh = cs2shItems[marketHashName] || {};
    const { baseName, wear } = parseItemName(marketHashName);

    // Нормализуем все источники в единый вид { ask, bid }
    const sourcePrices = {
      csfloat: {
        ask: cs2sh.csfloat?.ask ?? null,
        bid: cs2sh.csfloat?.bid ?? null,
      },
      buff: {
        ask: cs2sh.buff?.ask ?? null,
        bid: cs2sh.buff?.bid ?? null,
      },
      youpin: {
        ask: cs2sh.youpin?.ask ?? null,
        bid: cs2sh.youpin?.bid ?? null,
      },
      skinbux: skinbuxMap.get(marketHashName) || { ask: null, bid: null },
      csmoney: csMoneyMap.get(marketHashName) || { ask: null, bid: null },
    };

    // Если по предмету вообще нет ни одной цены — пропускаем
    const hasAnyPrice = Object.values(sourcePrices).some(
      (p) => p.ask != null || p.bid != null
    );
    if (!hasAnyPrice) continue;

    const best = findBestFlip(sourcePrices, config.sources);
    const lowestAsk = findLowestAsk(sourcePrices);

    rows.push({
      marketHashName,
      linkName: lookupName,
      name: baseName,
      wear: wear || "—",
      phase: phase || null,
      isStatTrak: marketHashName.includes("StatTrak™"),
      isSouvenir: marketHashName.startsWith("Souvenir "),
      isSticker: marketHashName.startsWith("Sticker | ") || marketHashName.startsWith("Sticker Slab | "),
      prices: withSpreads(sourcePrices),
      lowestAsk,
      bestBuySource: best?.buySource ?? null,
      bestBuySide: best?.buySide ?? null,
      bestBuyPrice: best?.buyPrice ?? null,
      bestSellSource: best?.sellSource ?? null,
      bestSellSide: best?.sellSide ?? null,
      bestSellPrice: best?.sellPrice ?? null,
      profitUsd: best?.profitUsd ?? null,
      profitPercent: best?.profitPercent ?? null,
    });
  }

  return rows;
}

/**
 * Самая низкая цена покупки (ask) предмета среди всех источников —
 * используется для фильтра "цена от X", независимо от того, есть ли
 * прибыльная связка для флипа.
 */
function findLowestAsk(sourcePrices) {
  let lowest = null;
  for (const data of Object.values(sourcePrices)) {
    if (data.ask != null && (lowest == null || data.ask < lowest)) {
      lowest = data.ask;
    }
  }
  return lowest;
}

/**
 * Добавляет spreadPercent = (ask - bid) / ask * 100 к каждому источнику,
 * где есть и ask, и bid. Большой спред обычно значит низкую ликвидность
 * или недостоверную цену на одной из сторон.
 */
function withSpreads(sourcePrices) {
  const result = {};
  for (const [source, data] of Object.entries(sourcePrices)) {
    let spreadPercent = null;
    if (data.ask != null && data.bid != null && data.ask > 0) {
      spreadPercent = round2(((data.ask - data.bid) / data.ask) * 100);
    }
    result[source] = { ...data, spreadPercent };
  }
  return result;
}

/**
 * Перебирает пары "точка покупки" (источник + сторона цены) x "точка продажи"
 * и находит связку с максимальной прибылью в долларах после комиссий.
 *
 * По умолчанию (без restrictBuy/restrictSell) покупка считается только по
 * ask, а продажа только по bid — это единственная пара, которая отражает
 * реальную механику "купить у продавца / продать по лучшему предложению",
 * и именно она используется для авторасчёта профита по умолчанию для каждой
 * строки таблицы.
 *
 * restrictBuy/restrictSell позволяют явно зафиксировать любую конкретную
 * связку источник+сторона (например "купить по csfloat bid, продать по
 * youpin ask") — не все такие связки экономически типичны, но пользователь
 * сам решает, что ему сравнивать.
 *
 * @param {{source:string, side:"ask"|"bid"}|null} restrictBuy
 * @param {{source:string, side:"ask"|"bid"}|null} restrictSell
 */
function findBestFlip(sourcePrices, sourcesConfig, restrictBuy = null, restrictSell = null) {
  const buyPoints = restrictBuy
    ? pointsFor(sourcePrices, "ask", restrictBuy)
    : pointsForSide(sourcePrices, "ask");
  const sellPoints = restrictSell
    ? pointsFor(sourcePrices, "bid", restrictSell)
    : pointsForSide(sourcePrices, "bid");

  let best = null;

  for (const buy of buyPoints) {
    const buyCfg = sourcesConfig[buy.source];
    if (!buyCfg?.enabled || !buyCfg.canBuy) continue;

    const buyPrice = buy.value * (1 + (buyCfg.buyFee || 0));

    for (const sell of sellPoints) {
      if (sell.source === buy.source) continue;
      const sellCfg = sourcesConfig[sell.source];
      if (!sellCfg?.enabled) continue;
      // canSell ограничивает только автоподбор лучшей связки (restrictSell не
      // задан) — например Buff163 (canSell:false, недоступен пользователю для
      // продажи по региону/аккаунту). Если пользователь САМ явно выбрал
      // площадку продажи (ручное сравнение "Sell On" в интерфейсе/боте), это
      // ограничение не применяется — он просто хочет посмотреть цифры.
      if (!restrictSell && !sellCfg.canSell) continue;

      const sellPrice = sell.value * (1 - (sellCfg.sellFee || 0));
      const profitUsd = sellPrice - buyPrice;

      if (!best || profitUsd > best.profitUsd) {
        best = {
          buySource: buy.source,
          buySide: buy.side,
          buyPrice: round2(buy.value),
          sellSource: sell.source,
          sellSide: sell.side,
          sellPrice: round2(sell.value),
          profitUsd: round2(profitUsd),
          profitPercent: buyPrice > 0 ? round2((profitUsd / buyPrice) * 100) : null,
        };
      }
    }
  }

  return best;
}

// Все источники по одной стороне цены (обычное поведение по умолчанию).
function pointsForSide(sourcePrices, side) {
  const points = [];
  for (const [source, data] of Object.entries(sourcePrices)) {
    if (data[side] != null) points.push({ source, side, value: data[side] });
  }
  return points;
}

// Одна конкретная точка источник+сторона (ручной выбор пользователя).
// defaultSide используется, если сторона в restrict не задана явно.
function pointsFor(sourcePrices, defaultSide, restrict) {
  const side = restrict.side || defaultSide;
  const value = sourcePrices[restrict.source]?.[side];
  if (value == null) return [];
  return [{ source: restrict.source, side, value }];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * "csfloat:ask" -> { source: "csfloat", side: "ask" }; "any"/пусто/null -> null.
 * Общий парсер строки "источник:сторона", используемый и UI-фильтрами
 * Buy On/Sell On, и конфигом периодических сканов (см. csfloatBidScan.js).
 */
function normalizeSourceSide(value) {
  if (!value || value === "any") return null;
  const [source, side] = value.split(":");
  if (!source || (side !== "ask" && side !== "bid")) return null;
  return { source, side };
}

/**
 * Общие фильтры отображения — применяются и к "топ прибыльных", и к "все предметы".
 *   excludeStatTrak         - выкинуть все StatTrak™ предметы
 *   excludeSouvenir         - выкинуть все Souvenir-предметы
 *   excludeStickers         - выкинуть стикеры (Sticker | ..., Sticker Slab | ...);
 *                             капсулы наклеек (контейнеры) под это не попадают
 *   maxCsfloatSpreadPercent - выкинуть предметы, где спред ask/bid на CSFloat больше X%
 *   maxYoupinSpreadPercent  - то же для Youpin898
 *   maxBuffSpreadPercent    - то же для Buff163
 *   phase                   - оставить только строки конкретной фазы Doppler/Gamma Doppler
 *                             (сейчас фазы даёт только skinbux, см. sources/skinbux.js)
 * Если спред у источника не посчитан (нет ask или bid), фильтр по спреду
 * этого источника не применяется — не выкидываем предмет из-за нехватки данных.
 */
function applyDisplayFilters(rows, filters) {
  return rows.filter((r) => {
    if (filters.excludeStatTrak && r.isStatTrak) return false;
    if (filters.excludeSouvenir && r.isSouvenir) return false;
    if (filters.excludeStickers && r.isSticker) return false;

    if (filters.phase && r.phase !== filters.phase) return false;

    if (filters.minPrice != null) {
      if (r.lowestAsk == null || r.lowestAsk < filters.minPrice) return false;
    }

    if (filters.maxPrice != null) {
      if (r.lowestAsk == null || r.lowestAsk > filters.maxPrice) return false;
    }

    if (filters.maxCsfloatSpreadPercent != null) {
      const s = r.prices.csfloat.spreadPercent;
      if (s != null && s > filters.maxCsfloatSpreadPercent) return false;
    }

    if (filters.maxYoupinSpreadPercent != null) {
      const s = r.prices.youpin.spreadPercent;
      if (s != null && s > filters.maxYoupinSpreadPercent) return false;
    }

    if (filters.maxBuffSpreadPercent != null) {
      const s = r.prices.buff.spreadPercent;
      if (s != null && s > filters.maxBuffSpreadPercent) return false;
    }

    return true;
  });
}

/**
 * Применяет фильтры из config.json и сортирует по убыванию прибыли.
 */
function filterAndSort(rows, filters) {
  return rows
    .filter(
      (r) =>
        r.profitUsd != null &&
        r.profitUsd >= filters.minProfitUsd &&
        r.profitPercent != null &&
        r.profitPercent >= filters.minProfitPercent
    )
    .sort((a, b) => b.profitUsd - a.profitUsd)
    .slice(0, filters.maxResults);
}

module.exports = { buildRows, filterAndSort, applyDisplayFilters, findBestFlip, normalizeSourceSide };
