// Периодический скан для внешнего бота автоперебития CSFloat buy order:
// по фиксированным фильтрам (config.csfloatBidScan) находит связку "купить
// через CSFloat buy order (bid) / продать на лучшей из доступных площадок",
// сохраняет снимок в JSON на диск и отправляет в Telegram (см. telegramNotifier.js).
//
// importItems — готовый массив в ТОЧНОМ формате Telegram-импорта csfloat-bot
// (tools/xlsx2json того проекта): { name, buff, youpin, phase? }. name/phase —
// реальный market_hash_name и фаза Doppler без синтетического суффикса, они
// уже так и хранятся в rows (r.linkName/r.phase). buff/youpin — это НЕ цены и
// не наши арбитражные проценты, а пороги риска для гейта покупки в самом боте
// (conditions.go: buffPct/youpinPct) — мы их не вычисляем из цен, а подставляем
// по качеству предмета (см. WEAR_TIER_PCT ниже, задано пользователем).
// Предметы без стандартного качества (WEAR_TIER_PCT не покрывает — кейсы и т.п.)
// в importItems не попадают, т.к. для них нет осмысленного значения.
const fs = require("fs");
const path = require("path");
const { applyDisplayFilters, findBestFlip, normalizeSourceSide } = require("./pricingEngine");

const OUTPUT_FILE = path.join(__dirname, "csfloat-bid-watchlist.json");

// Текущий список предметов, уже отслеживаемых ботом (экспорт из csfloat-bot,
// тот же формат [{name, buff, youpin, phase?}]) — сканы не предлагают то, что
// там уже есть. Перечитывается на каждом скане, так что для актуализации
// достаточно перезаписать файл (без рестарта сервера).
const EXISTING_WATCHLIST_FILE = path.join(__dirname, "existing-watchlist.json");

function loadExistingWatchlistKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(EXISTING_WATCHLIST_FILE, "utf8"));
    return new Set(raw.map((it) => `${it.name}|${it.phase || ""}`));
  } catch {
    return new Set(); // файла нет или он битый — просто не исключаем ничего
  }
}

const WEAR_TIER_PCT = {
  "Factory New": 8,
  "Minimal Wear": 7,
  "Field-Tested": 7,
  "Well-Worn": 8,
  "Battle-Scarred": 10,
};

// r.wear бывает "Factory New" или "Factory New · Phase 3" (см. itemName.js) —
// берём часть до " · ", чтобы фаза не мешала сопоставлению с таблицей выше.
function pctForWear(wear) {
  if (!wear) return null;
  const plain = wear.split(" · ")[0];
  return WEAR_TIER_PCT[plain] ?? null;
}

// Для некоторых раскрасок (Doppler, Tiger Tooth и т.п.) покупаем только
// определённые качества — см. config.csfloatBidScan.patternWearLimits.
// Ключ ищется как подстрока в названии (r.name без качества), поэтому
// "Marble Fade" совпадёт и с правилом "Fade", и с правилом "Marble Fade" —
// в текущей конфигурации это не конфликтует, т.к. у обоих одно и то же
// ограничение (Factory New). Если для предмета не нашлось ни одного
// совпадающего правила — качество ничем не ограничено.
function patternWearAllowed(name, wear, patternWearLimits) {
  if (!patternWearLimits) return true;
  const plainWear = wear ? wear.split(" · ")[0] : null;
  for (const [pattern, allowedWears] of Object.entries(patternWearLimits)) {
    if (name.includes(pattern)) {
      return plainWear != null && allowedWears.includes(plainWear);
    }
  }
  return true;
}

function runCsfloatBidScan(rows, config) {
  const cfg = config.csfloatBidScan || {};
  if (!cfg.enabled) return null;

  const displayFilters = {
    excludeStatTrak: !!cfg.excludeStatTrak,
    excludeSouvenir: !!cfg.excludeSouvenir,
    excludeStickers: !!cfg.excludeStickers,
    minPrice: cfg.minPrice ?? null,
    maxPrice: cfg.maxPrice ?? null,
    maxCsfloatSpreadPercent: cfg.maxCsfloatSpreadPercent ?? null,
    maxYoupinSpreadPercent: cfg.maxYoupinSpreadPercent ?? null,
    maxBuffSpreadPercent: cfg.maxBuffSpreadPercent ?? null,
    phase: cfg.phase || null,
  };

  const buyRestrict = normalizeSourceSide(cfg.buySource);
  const sellRestrict = normalizeSourceSide(cfg.sellSource);
  const existingKeys = loadExistingWatchlistKeys();

  let skippedNoWearTier = 0;
  let skippedAlreadyTracked = 0;
  let skippedPatternWear = 0;

  const details = applyDisplayFilters(rows, displayFilters)
    .filter((r) => {
      const already = existingKeys.has(`${r.linkName}|${r.phase || ""}`);
      if (already) skippedAlreadyTracked++;
      return !already;
    })
    .filter((r) => {
      const allowed = patternWearAllowed(r.name, r.wear, cfg.patternWearLimits);
      if (!allowed) skippedPatternWear++;
      return allowed;
    })
    .map((r) => {
      const flip = findBestFlip(r.prices, config.sources, buyRestrict, sellRestrict);
      if (!flip) return null;
      return {
        marketHashName: r.linkName,
        wear: r.wear,
        phase: r.phase,
        wearTierPct: pctForWear(r.wear),
        buySource: flip.buySource,
        buySide: flip.buySide,
        buyPrice: flip.buyPrice,
        sellSource: flip.sellSource,
        sellSide: flip.sellSide,
        sellPrice: flip.sellPrice,
        profitUsd: flip.profitUsd,
        profitPercent: flip.profitPercent,
      };
    })
    .filter(
      (r) =>
        r &&
        r.profitUsd != null &&
        r.profitUsd >= (cfg.minProfitUsd ?? 0) &&
        r.profitPercent != null &&
        r.profitPercent >= (cfg.minProfitPercent ?? 0)
    )
    .sort((a, b) => b.profitUsd - a.profitUsd)
    .slice(0, cfg.maxResults ?? 200);

  const importItems = [];
  for (const r of details) {
    if (r.wearTierPct == null) {
      skippedNoWearTier++;
      continue;
    }
    const item = { name: r.marketHashName, buff: r.wearTierPct, youpin: r.wearTierPct };
    if (r.phase) item.phase = r.phase;
    importItems.push(item);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    filters: {
      buySource: cfg.buySource,
      sellSource: cfg.sellSource,
      minProfitUsd: cfg.minProfitUsd ?? 0,
      minProfitPercent: cfg.minProfitPercent ?? 0,
      maxResults: cfg.maxResults ?? 200,
      ...displayFilters,
    },
    count: importItems.length,
    skippedNoWearTier,
    skippedAlreadyTracked,
    skippedPatternWear,
    // Готовый массив под Telegram-импорт в csfloat-bot — копируется как есть.
    importItems,
    // То же самое, но с ценами/профитом/источниками — для ручной проверки
    // перед импортом (details[i] соответствует importItems[i], если у строки
    // была найдена стандартная градация качества).
    details: details.filter((r) => r.wearTierPct != null),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

module.exports = { runCsfloatBidScan, OUTPUT_FILE };
