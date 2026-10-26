// Список для бота автоперебития CSFloat buy order (csfloat-bot): предметы,
// которые выгодно купить по CSFloat ask и сдать на Skinbux — то же, что в
// таблице с Buy On = CSFloat Ask, Sell On = Skinbux. По ask, а не по bid: у
// bid полно мусора вроде ордера $17.50 на предмет за $10 000.
//
// Бот забирает его каждый тик (GET /api/bot/autobuy-feed), добавляет предметы
// к своему списку и ставит на них ордер не дороже
// min(Skinbux × (100 − маржа)%, Youpin bid × 105%). Цена Skinbux здесь же — от
// неё бот каждый тик пересчитывает потолок: снизил Skinbux цену — бот
// опускает ордер, перестал брать или предмет выпал из списка — паркует.
const { applyDisplayFilters, findBestFlip, normalizeSourceSide } = require("./pricingEngine");

const BUY = normalizeSourceSide("csfloat:ask");
const SELL = normalizeSourceSide("skinbux:bid");

// Бот ставит ордер на float-диапазон качества — предмет без качества (кейс,
// стикер, ванильный нож) ему не подходит.
const WEARS = new Set(["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred"]);

const DEFAULTS = {
  minPrice: 100,
  maxPrice: null,
  minProfitUsd: 1,
  minProfitPercent: 5,
  maxResults: 50,
  excludeStatTrak: false,
  excludeSouvenir: true,
  excludeStickers: true,
};

function buildAutobuyFeed(rows, config, updatedAt) {
  const cfg = { ...DEFAULTS, ...(config.autobuyFeed || {}) };
  const items = applyDisplayFilters(rows, {
    excludeStatTrak: cfg.excludeStatTrak,
    excludeSouvenir: cfg.excludeSouvenir,
    excludeStickers: cfg.excludeStickers,
    minPrice: cfg.minPrice,
    maxPrice: cfg.maxPrice,
  })
    .filter((r) => WEARS.has(String(r.wear).split(" · ")[0]))
    .map((r) => {
      const flip = findBestFlip(r.prices, config.sources, BUY, SELL);
      if (!flip || flip.profitPercent == null) return null;
      return {
        name: r.linkName,
        phase: r.phase || null,
        skinbuxCents: Math.round(flip.sellPrice * 100),
        csfloatAskCents: Math.round(flip.buyPrice * 100),
        profitUsd: flip.profitUsd,
        profitPercent: flip.profitPercent,
      };
    })
    .filter((it) => it && it.profitUsd >= cfg.minProfitUsd && it.profitPercent >= cfg.minProfitPercent)
    .sort((a, b) => b.profitUsd - a.profitUsd)
    .slice(0, cfg.maxResults);

  return { generatedAt: new Date().toISOString(), pricesUpdatedAt: updatedAt || null, count: items.length, items };
}

module.exports = { buildAutobuyFeed };
