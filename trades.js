// Трекер сделок ("Мои сделки"): что купил / что продал, с учётом trade-lock
// (после покупки предмет нельзя продать N дней — см. config.portfolio.tradeLockDays)
// и текущей лучшей цены продажи по live-данным арбитражного движка.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getSteamImages } = require("./steamImages");

const TRADES_FILE = path.join(__dirname, "trades.json");

function loadTrades() {
  if (!fs.existsSync(TRADES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// Сделка принадлежит только одному владельцу (owner = username сессии) — все
// операции ниже фильтруют/проверяют это поле, чтобы пользователи не видели
// и не могли изменить чужие сделки. Цены (rows) при этом общие на всех.
function findOwnedTrade(allTrades, id, owner) {
  const trade = allTrades.find((t) => t.id === id && t.owner === owner);
  if (!trade) throw new Error("Сделка не найдена");
  return trade;
}

function addTrade({ marketHashName, name, wear, buySource, buyPrice, buyDate, unlockAt, owner, rows, sourcesConfig }) {
  if (!owner) throw new Error("owner обязателен");
  if (!marketHashName) throw new Error("marketHashName обязателен");
  // buySource — площадка з config.sources або будь-яка своя назва, вписана руками.
  const source = typeof buySource === "string" ? buySource.trim() : "";
  if (!source) throw new Error("buySource обязателен");
  if (source.length > 40) throw new Error("Название площадки слишком длинное");
  const price = Number(buyPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("buyPrice должен быть положительным числом");

  const trades = loadTrades();
  const trade = {
    id: crypto.randomUUID(),
    owner,
    marketHashName,
    name: name || marketHashName,
    wear: wear || "—",
    buySource: source,
    buyPrice: price,
    buyDate: buyDate ? new Date(buyDate).toISOString() : new Date().toISOString(),
    // Точное время "Tradable After" со страницы инвентаря Steam, если известно —
    // Steam округляет trade-hold не строго до +7 суток от покупки (сдвиг на
    // десятки минут — видимо, до ближайшей отметки по своему графику), поэтому
    // при наличии точного значения используем его вместо приблизительного
    // buyDate + config.portfolio.tradeLockDays.
    customUnlockAt: unlockAt ? new Date(unlockAt).toISOString() : null,
    status: "holding",
    sellSource: null,
    sellPrice: null,
    sellDate: null,
    // Снапшот лучших цен продажи на момент покупки — чтобы через неделю можно
    // было сравнить "было / стало", не дожидаясь пересчёта заново. Если rows
    // не передали (или предмета ещё нет в кэше цен) — просто null, не критично.
    buySnapshot: rows ? snapshotSellPrices(rows.find((r) => r.marketHashName === marketHashName), sourcesConfig) : null,
  };
  trades.push(trade);
  saveTrades(trades);
  return trade;
}

// sellSource может быть как площадкой из config.sources, так и любым своим
// названием (продал где-то ещё) — во втором случае правил холда мы не знаем,
// поэтому их можно задать вручную через sellHoldDays, см. computeBalances.
function sellTrade(id, owner, { sellSource, sellPrice, sellDate, sellSide, sellHoldDays }, sourcesConfig) {
  const source = typeof sellSource === "string" ? sellSource.trim() : "";
  if (!source) throw new Error("sellSource обязателен");
  if (source.length > 40) throw new Error("Название площадки слишком длинное");

  const price = Number(sellPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("sellPrice должен быть положительным числом");

  let holdDays = null;
  if (sellHoldDays !== undefined && sellHoldDays !== null && sellHoldDays !== "") {
    holdDays = Number(sellHoldDays);
    if (!Number.isFinite(holdDays) || holdDays < 0 || holdDays > 365) {
      throw new Error("Холд должен быть числом от 0 до 365 дней");
    }
  }

  const trades = loadTrades();
  const trade = findOwnedTrade(trades, id, owner);
  if (trade.status === "sold") throw new Error("Сделка уже отмечена как проданная");

  trade.status = "sold";
  trade.sellSource = source;
  // bid/ask — на некоторых площадках (сейчас CS.Money) от этого зависят
  // правила холда денег, см. computeBalances.
  trade.sellSide = sellSide || null;
  trade.sellHoldDays = holdDays;
  // sellPrice приходит как цена продажи на площадке; комиссию вычитаем здесь,
  // чтобы прибыль и баланс считались по деньгам, которые реально пришли.
  // Цену до комиссии и сам процент храним рядом — для сверки.
  const feeRate = sellFeeRate(sourcesConfig?.[source], trade.sellSide, price);
  trade.sellGrossPrice = price;
  trade.sellFeeRate = feeRate;
  trade.sellFeeApplied = true;
  trade.sellPrice = round2(price * (1 - feeRate));
  trade.sellDate = sellDate ? new Date(sellDate).toISOString() : new Date().toISOString();

  saveTrades(trades);
  return trade;
}

function setUnlockAt(id, owner, unlockAt) {
  const trades = loadTrades();
  const trade = findOwnedTrade(trades, id, owner);

  trade.customUnlockAt = unlockAt ? new Date(unlockAt).toISOString() : null;
  saveTrades(trades);
  return trade;
}

function setBuyDate(id, owner, buyDate) {
  if (!buyDate) throw new Error("buyDate обязателен");
  const trades = loadTrades();
  const trade = findOwnedTrade(trades, id, owner);

  trade.buyDate = new Date(buyDate).toISOString();
  saveTrades(trades);
  return trade;
}

function deleteTrade(id, owner) {
  const trades = loadTrades();
  findOwnedTrade(trades, id, owner); // бросит, если не найдена или чужая
  saveTrades(trades.filter((t) => t.id !== id));
}

/**
 * Привязывает загруженный скриншот к сделке (imagePath — относительный
 * публичный путь вида "/uploads/skins/xxx.jpg", файл уже сохранён на диск
 * до вызова этой функции, см. server.js). Если у сделки уже была картинка —
 * старый файл удаляется, чтобы не копился мусор при повторной загрузке.
 */
function setTradeImage(id, owner, imagePath) {
  const trades = loadTrades();
  const trade = findOwnedTrade(trades, id, owner);

  if (trade.image) {
    const oldPath = path.join(__dirname, "public", trade.image);
    fs.unlink(oldPath, () => {}); // не критично, если не удалилось
  }

  trade.image = imagePath;
  saveTrades(trades);
  return trade;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Все способы продать прямо сейчас на площадках, которые вообще включены
 * (enabled). Buff163 тоже показывается здесь как вариант для сравнения —
 * canSell:false в конфиге влияет только на автоматический флип-скан
 * (pricingEngine.js findBestFlip), сюда это ограничение не распространяется.
 * На каждой площадке может быть до двух вариантов:
 *   side: "bid" — инстант-выкуп самой площадкой, гарантированные деньги,
 *                 с учётом её комиссии продажи
 *   side: "ask" — цена, за которую можно выставить лот самому (CSFloat/
 *                 Youpin898/CS.Money — у них есть реальный ask с рынка),
 *                 БЕЗ вычета комиссии — это ориентир по листингу, а не
 *                 гарантированная выплата (могут перебить ценой/не купить)
 * Отсортировано по убыванию цены — options[0] всегда самый выгодный вариант
 * (может быть как bid, так и ask). Клиент сам решает в интерфейсе, какие
 * площадки и какие варианты ему интересны (см. модалку в public/trades.js).
 */
// Какими сторонами площадку предлагаем для продажи. CS.Money — только instant:
// продажа лотом идёт с комиссией 5% (3% от $1000) и не гарантирована.
const SELL_SIDES = { csmoney: ["bid"] };

// Комиссия площадки при продаже: CSFloat 2% и Buff 1.5% — с любой стороны
// (sellFee), лот на CS.Money — ступенчато (askSellFeeTiers), остальные 0%.
// Своя площадка, вписанная руками, — 0%: её правил мы не знаем.
function sellFeeRate(cfg, side, price) {
  if (!cfg) return 0;
  if (side === "ask" && cfg.askSellFeeTiers) return tieredFee(price, cfg.askSellFeeTiers);
  return cfg.sellFee || 0;
}

function findAllSellOptions(row, sourcesConfig) {
  if (!row) return [];
  const options = [];

  for (const [source, price] of Object.entries(row.prices)) {
    const cfg = sourcesConfig[source];
    if (!cfg?.enabled) continue;

    for (const side of ["bid", "ask"]) {
      const gross = price[side];
      if (gross == null) continue;
      if (SELL_SIDES[source] && !SELL_SIDES[source].includes(side)) continue;
      // price — сколько реально придёт после комиссии, gross — цена на площадке.
      const feeRate = sellFeeRate(cfg, side, gross);
      options.push({ source, side, gross: round2(gross), feeRate, price: round2(gross * (1 - feeRate)) });
    }
  }

  return options.sort((a, b) => b.price - a.price);
}

// Снимок лучшей instant-цены (bid) и лучшей рыночной цены (ask) на момент
// покупки — те же два числа, что видны в модалке "Sell here" в момент добавления
// сделки. sourcesConfig может быть не передан (напр. старый вызов без cache) —
// тогда просто ничего не снимаем, а не падаем.
function snapshotSellPrices(row, sourcesConfig) {
  if (!row || !sourcesConfig) return null;
  const options = findAllSellOptions(row, sourcesConfig);
  const bestBid = options.find((o) => o.side === "bid") || null;
  const bestAsk = options.find((o) => o.side === "ask") || null;
  if (!bestBid && !bestAsk) return null;
  return { capturedAt: new Date().toISOString(), bestBid, bestAsk };
}

/**
 * Дополняет сделку производными полями для отображения:
 *  - unlockAt/isLocked/daysLeft — блокировка на продажу после покупки
 *  - для holding: sellOptions — цена и прибыль по каждой площадке отдельно;
 *    profitUsd/profitPercent — по самому выгодному варианту (для сводки сверху)
 *  - для sold: зафиксированная (realized) прибыль
 */
function enrichTrade(trade, { rows, config }) {
  let unlockAt;
  if (trade.customUnlockAt) {
    unlockAt = new Date(trade.customUnlockAt);
  } else {
    const lockDays = config.portfolio?.tradeLockDays ?? 7;
    unlockAt = new Date(new Date(trade.buyDate).getTime() + lockDays * 24 * 60 * 60 * 1000);
  }

  const now = new Date();
  const isLocked = trade.status === "holding" && now < unlockAt;
  const msLeft = unlockAt.getTime() - now.getTime();
  const daysLeft = isLocked ? Math.ceil(msLeft / (24 * 60 * 60 * 1000)) : 0;
  const hoursLeft = isLocked ? Math.ceil(msLeft / (60 * 60 * 1000)) : 0;

  const result = { ...trade, unlockAt: unlockAt.toISOString(), isLocked, daysLeft, hoursLeft };

  if (trade.status === "sold") {
    result.profitUsd = round2(trade.sellPrice - trade.buyPrice);
    result.profitPercent = trade.buyPrice > 0 ? round2((result.profitUsd / trade.buyPrice) * 100) : null;
    return result;
  }

  const row = rows.find((r) => r.marketHashName === trade.marketHashName);
  const options = findAllSellOptions(row, config.sources).map((o) => ({
    source: o.source,
    side: o.side,
    gross: o.gross,
    feeRate: o.feeRate,
    price: o.price,
    profitUsd: round2(o.price - trade.buyPrice),
    profitPercent: trade.buyPrice > 0 ? round2(((o.price - trade.buyPrice) / trade.buyPrice) * 100) : null,
  }));

  // Сводка сверху (карточки на странице) считается только по гарантированным
  // (bid) вариантам — ask не гарантирован, не хотим завышать "прибыль сейчас".
  const bidOptions = options.filter((o) => o.side === "bid");

  result.priceFound = !!row;
  result.sellOptions = options;
  result.profitUsd = bidOptions[0]?.profitUsd ?? null;
  result.profitPercent = bidOptions[0]?.profitPercent ?? null;

  return result;
}

/**
 * @param {string} owner  - username сессии; возвращаются только его сделки
 * @param {Array}  rows   - cache.rows текущего снапшота цен (для расчёта currentBestSell)
 * @param {Object} config - config.json
 */
function listTrades({ owner, rows, config }) {
  return loadTrades()
    .filter((t) => t.owner === owner)
    .map((t) => enrichTrade(t, { rows, config }))
    .sort((a, b) => new Date(b.buyDate) - new Date(a.buyDate));
}

// Тиры комиссии CS.Money за продажу игроку (ask) — заданы как [{maxPrice, fee}],
// отсортированы по возрастанию maxPrice, null = "и выше". Берём первый тир,
// под который подходит цена.
function tieredFee(price, tiers) {
  if (!tiers) return 0;
  for (const tier of tiers) {
    if (tier.maxPrice == null || price < tier.maxPrice) return tier.fee;
  }
  return 0;
}

/**
 * Сколько денег с проданных предметов сейчас "лежит" на каждой площадке —
 * посчитано ИСКЛЮЧИТЕЛЬНО по истории продаж в trades.json (sellSource/
 * sellSide/sellPrice/sellDate), без учёта покупок/выводов на самих
 * площадках — это не полноценный учёт счёта, а прикидка "сколько я туда
 * продал и сколько из этого уже можно тронуть". Правила по каждому
 * источнику — sources[x].instantPercent/holdDays в config.json (или
 * sources[x].balanceBySide.{bid,ask}, если правила разные в зависимости от
 * того, как именно продал — сейчас так только у CS.Money).
 *   active  — доступно прямо сейчас (сразу + то, что отсидело holdDays)
 *   hold    — ждёт holdDays с момента продажи, станет active само
 *   frozen  — источники без holdDays (buff/youpin): условие освобождения
 *             (не использовал ли покупатель свой frozen balance) нам не
 *             видно, поэтому эта часть считается зависшей навсегда
 * nextUnlockAt — ближайшая дата, когда что-то из hold перейдёт в active
 * (null, если hold пуст).
 */
function computeBalances(owner, sourcesConfig) {
  const now = new Date();
  const balances = {};

  for (const t of loadTrades()) {
    if (t.owner !== owner || t.status !== "sold") continue;
    const cfg = sourcesConfig[t.sellSource];

    // Площадка, которой нет в config.sources — это своя, введённая руками при
    // продаже. Правил комиссий и холда мы про неё не знаем, поэтому деньги
    // считаем доступными сразу, а если при продаже указали срок холда —
    // держим их до его окончания.
    const rule = !cfg
      ? { instantPercent: t.sellHoldDays ? 0 : 100, holdDays: t.sellHoldDays ?? null }
      : // Источники с разными правилами для bid/ask (сейчас только CS.Money).
        // Если сторона продажи не сохранена (старые записи до этой фичи) —
        // консервативно считаем это ask: дольше холд, меньше сразу доступно,
        // чтобы не завысить баланс.
        cfg.balanceBySide
        ? cfg.balanceBySide[t.sellSide] || cfg.balanceBySide.ask
        : cfg;
    // Источники без instantPercent/holdDays вообще (например ручной "trade" —
    // прямой Steam-трейд, или "gabenmarket") — это не биржевой счёт, пропускаем.
    if (!rule || rule.instantPercent == null) continue;

    let sellPrice = t.sellPrice;
    // Новые записи хранят сумму уже после комиссии (sellFeeApplied) — второй
    // раз не вычитаем. Старые — как раньше.
    if (!t.sellFeeApplied && cfg?.askSellFeeTiers && (t.sellSide === "ask" || (cfg.balanceBySide && !t.sellSide))) {
      sellPrice = round2(sellPrice * (1 - tieredFee(sellPrice, cfg.askSellFeeTiers)));
    }

    if (!balances[t.sellSource]) {
      balances[t.sellSource] = { active: 0, hold: 0, frozen: 0, nextUnlockAt: null };
    }
    const b = balances[t.sellSource];

    const instantAmount = round2(sellPrice * (rule.instantPercent / 100));
    const restAmount = round2(sellPrice - instantAmount);
    b.active += instantAmount;

    if (restAmount <= 0) continue;

    if (rule.holdDays == null) {
      b.frozen += restAmount;
      continue;
    }

    const unlockAt = new Date(new Date(t.sellDate).getTime() + rule.holdDays * 24 * 60 * 60 * 1000);
    if (now >= unlockAt) {
      b.active += restAmount;
    } else {
      b.hold += restAmount;
      if (!b.nextUnlockAt || unlockAt < new Date(b.nextUnlockAt)) {
        b.nextUnlockAt = unlockAt.toISOString();
      }
    }
  }

  // "Steam" — это не кошелёк, а стоимость скинов, которые прямо сейчас лежат
  // в инвентаре Steam: всё, что куплено и ещё не продано (status: "holding"),
  // независимо от того, где куплено — после покупки предмет физически
  // оказывается в Steam. Совпадает с "Invested Now" в сводке сверху.
  const steamValue = loadTrades()
    .filter((t) => t.owner === owner && t.status === "holding")
    .reduce((sum, t) => sum + t.buyPrice, 0);
  if (steamValue > 0) {
    balances.steam = { active: round2(steamValue), hold: 0, frozen: 0, nextUnlockAt: null };
  }

  for (const b of Object.values(balances)) {
    b.active = round2(b.active);
    b.hold = round2(b.hold);
    b.frozen = round2(b.frozen);
  }

  return balances;
}

const MY_SKINS_MARKUP = 0.06;

/**
 * Публичная витрина "Мої скіни в наявності" (my-skins.html) — то, что
 * реально куплено и лежит на руках у владельца сайта (status: "holding"),
 * ВКЛЮЧАЯ предметы ещё в трейд-бане (клиент видит их заранее и может
 * забронировать). Цена = цена покупки + 6% — фиксированная наценка, не
 * связанная с текущим рынком (в отличие от sellQuote.js/buyQuote.js).
 * Наружу отдаём только то, что нужно витрине — buyDate/buySource и т.п.
 * не показываем.
 *
 * Картинка: если владелец загрузил свой скриншот вручную (trade.image) —
 * используем его, иначе подтягиваем автоматически по названию со Steam
 * Community Market (см. steamImages.js). Поэтому функция асинхронная.
 */
async function listPublicHoldings(owner, config) {
  const lockDays = config.portfolio?.tradeLockDays ?? 7;
  const now = new Date();

  const holdings = loadTrades().filter((t) => t.owner === owner && t.status === "holding");

  const items = await Promise.all(
    holdings.map(async (t) => {
      const unlockAt = t.customUnlockAt
        ? new Date(t.customUnlockAt)
        : new Date(new Date(t.buyDate).getTime() + lockDays * 24 * 60 * 60 * 1000);

      const auto = t.image ? null : await getSteamImages(t.marketHashName);

      return {
        marketHashName: t.marketHashName,
        wear: t.wear,
        price: round2(t.buyPrice * (1 + MY_SKINS_MARKUP)),
        isLocked: now < unlockAt,
        unlockAt: unlockAt.toISOString(),
        image: t.image || auto?.thumb || null,
        imageFull: t.image || auto?.full || null,
      };
    })
  );

  return items.sort((a, b) => a.marketHashName.localeCompare(b.marketHashName));
}

module.exports = {
  addTrade,
  sellTrade,
  setUnlockAt,
  setBuyDate,
  deleteTrade,
  listTrades,
  listPublicHoldings,
  setTradeImage,
  computeBalances,
};
