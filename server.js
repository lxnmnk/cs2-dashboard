require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const compression = require("compression");

const { fetchCs2ShLatest } = require("./sources/cs2sh");
const { fetchCsMoneyLatest, closeBrowser } = require("./sources/csmoney");
const { fetchSkinbuxLatest } = require("./sources/skinbux");
const { buildRows, filterAndSort, applyDisplayFilters, findBestFlip, normalizeSourceSide } = require("./pricingEngine");
const trades = require("./trades");
const users = require("./users");
const { runCsfloatBidScan } = require("./csfloatBidScan");
const { sendScanToTelegram } = require("./telegramNotifier");
const { computeSellQuote } = require("./sellQuote");
const priceOverrides = require("./priceOverrides");
const { getSteamImages } = require("./steamImages");
const { computeBuyQuote } = require("./buyQuote");
const tradeCatalog = require("./tradeCatalog");
const pricingSettings = require("./pricingSettings");
const { matchesSearchQuery, parseItemName } = require("./itemName");
const { startTelegramArbBot } = require("./telegramArbBot");
const steamAuth = require("./steamAuth");
const customers = require("./customers");
const balanceAdjustments = require("./balanceAdjustments");
const { fetchInventory } = require("./steamInventory");
const skinbuxInventory = require("./skinbuxInventory");
const skinbuxTx = require("./skinbuxTransactions");
const skinbuxSales = require("./skinbuxSales");
const crypto = require("crypto");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();

// gzip для всего текстового: стили, скрипты и JSON (инвентарь, витрина) раньше
// уходили несжатыми — nginx по умолчанию сжимает только HTML.
app.use(compression());
const PORT = process.env.PORT || 3000;

// ---- Загрузка скриншотов предметов (public/uploads/skins/) ----
// Файлы отдаются публично (видны на витрине "Мої скіни в наявності" без
// логина), но сама загрузка — только владельцем сделки, см. роут ниже.
const UPLOADS_DIR = path.join(__dirname, "public", "uploads", "skins");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMAGE_TYPES[file.mimetype] || ".jpg";
      cb(null, `${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 МБ
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) return cb(new Error("Разрешены только JPG, PNG или WEBP"));
    cb(null, true);
  },
});

if (!process.env.SESSION_SECRET) {
  console.error(
    "SESSION_SECRET не задан в .env — сгенерируйте случайную строку (например: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\") и добавьте её в .env перед деплоем."
  );
  process.exit(1);
}

// ---- Состояние в памяти: последний успешный снапшот цен ----
let cache = {
  updatedAt: null,
  rows: [],
  error: null,
  isRefreshing: false,
};

async function refreshPrices() {
  if (cache.isRefreshing) return; // не запускаем параллельно
  cache.isRefreshing = true;

  try {
    console.log("[refresh] Загружаю цены...");

    const cs2shNeeded =
      config.sources.csfloat.enabled || config.sources.buff.enabled || config.sources.youpin.enabled;

    const [csMoneyResult, cs2shResult, skinbuxResult] = await Promise.allSettled([
      fetchCsMoneyLatest(),
      cs2shNeeded ? fetchCs2ShLatest(process.env.CS2SH_API_KEY) : Promise.resolve({}),
      config.sources.skinbux.enabled ? fetchSkinbuxLatest(process.env.SKINBUX_API_KEY) : Promise.resolve(new Map()),
    ]);

    const errors = [];
    if (csMoneyResult.status === "rejected") errors.push(`cs.money: ${csMoneyResult.reason.message}`);
    if (cs2shResult.status === "rejected") errors.push(`cs2.sh: ${cs2shResult.reason.message}`);
    if (skinbuxResult.status === "rejected") errors.push(`skinbux: ${skinbuxResult.reason.message}`);

    const csMoneyMap = csMoneyResult.status === "fulfilled" ? csMoneyResult.value : new Map();
    const cs2shItems = cs2shResult.status === "fulfilled" ? cs2shResult.value : {};
    const skinbuxMap = skinbuxResult.status === "fulfilled" ? skinbuxResult.value : new Map();

    const rows = buildRows(cs2shItems, csMoneyMap, skinbuxMap, config);

    cache = {
      updatedAt: new Date().toISOString(),
      rows,
      // Показываем ошибку только если вообще ничего не загрузилось; частичный сбой
      // одного источника не должен прятать данные остальных.
      error: rows.length === 0 && errors.length ? errors.join(" | ") : null,
      isRefreshing: false,
    };

    if (errors.length) {
      console.warn(`[refresh] Частичные ошибки: ${errors.join(" | ")}`);
    }
    console.log(`[refresh] Готово. Предметов с ценой: ${rows.length}`);
  } catch (err) {
    console.error("[refresh] Ошибка:", err.message);
    cache.error = err.message;
    cache.isRefreshing = false;
  }
}

// ---- Аутентификация ----
// Аккаунты общие на цены, но у каждого свой трекер сделок (см. trades.js).
// Открытой регистрации нет — учётки заводит владелец сервера через create-user.js.
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // Включите COOKIE_SECURE=true в .env, когда сайт будет за HTTPS —
      // иначе браузер не будет отправлять cookie обратно.
      secure: process.env.COOKIE_SECURE === "true",
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
    },
  })
);

// trade.html/sell-quote.html/buy-quote.html — отдельные публичные страницы
// для внешних людей (не аккаунтов сайта), см. sellQuote.js/buyQuote.js.
// Специально не завязаны на остальной интерфейс.
const PUBLIC_PATHS = new Set([
  "/",
  "/login.html",
  "/login.js",
  "/style.css",
  "/api/login",
  "/trade.html",
  "/sell-quote.html",
  "/buy-quote.html",
  "/trade-ru.html",
  "/sell-quote-ru.html",
  "/buy-quote-ru.html",
  "/trade-en.html",
  "/sell-quote-en.html",
  "/buy-quote-en.html",
  "/my-skins.html",
  "/my-skins-ru.html",
  "/my-skins-en.html",
  "/ru",
  "/en",
  "/sell",
  "/buy",
  "/my-skins",
  "/ru/sell",
  "/ru/buy",
  "/ru/my-skins",
  "/en/sell",
  "/en/buy",
  "/en/my-skins",
  "/trade",
  "/ru/trade",
  "/en/trade",
  "/my-skins.js",
  "/item-filters.js",
  "/item-aliases.js",
  "/nav-profile.js",
  "/account-inventory.js",
  "/account-deals.js",
  "/quote.css",
  "/quote-common.js",
  "/bg-map.jpg",
  "/api/public/item-search",
  "/api/public/sell-quote",
  "/api/public/buy-quote",
  "/api/public/my-skins",
  "/api/public/trade-catalog",
  "/api/public/trade-search",
  "/swap.js",
  "/account",
  "/ru/account",
  "/en/account",
  "/auth/steam",
  "/auth/steam/return",
  "/auth/logout",
  "/api/account/me",
  "/api/account/inventory",
  "/api/account/trade-url",
  "/api/account/sell",
  "/api/account/sales",
  "/api/webhooks/skinbux",
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/uploads/")) return next(); // скриншоты предметов — публичные файлы
  if (req.session?.username) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Не авторизован" });
  return res.redirect("/login.html");
});

// В /mytrades сидит не только владелец сайта — у друзей свои учётки со своим
// трекером сделок. Всё, что касается бизнеса целиком (цены для клиентов,
// продажи клиентов, выплаты), доступно только владельцу — и на сервере, а не
// только спрятанными кнопками, иначе это можно вызвать запросом напрямую.
const SITE_OWNER = "lxnmnk";

function requireSiteOwner(req, res, next) {
  if (req.session?.username === SITE_OWNER) return next();
  res.status(403).json({ ok: false, error: "Только для владельца сайта" });
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const verified = await users.verifyUser(username, password);
  if (!verified) {
    return res.status(401).json({ ok: false, error: "Неверный логин или пароль" });
  }
  req.session.username = verified;
  res.json({ ok: true, username: verified });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  res.json({ username: req.session.username, isSiteOwner: req.session.username === SITE_OWNER });
});

// Корень сайта — публичная клиентская страница (выбор Купити/Продати), а не
// внутренняя закрытая логином панель. Должен идти ДО express.static, иначе
// static сам отдаст public/index.html (внутренний арбитраж) на "/".
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "trade.html"));
});

// Чистые адреса внутренней панели вместо голых имён файлов — те же самые
// закрытые логином страницы (auth-gate выше их не пускает, если нет сессии;
// "/arbitrage" и "/mytrades" сюда не добавлены в PUBLIC_PATHS специально).
app.get("/arbitrage", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/mytrades", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "trades.html"));
});

// Старые адреса файлов — не отдаём напрямую, редиректим на чистые.
app.get("/index.html", (req, res) => res.redirect("/arbitrage"));
app.get("/trades.html", (req, res) => res.redirect("/mytrades"));

// Чистые адреса публичных страниц (trade*/sell-quote*/buy-quote*/my-skins*) —
// вместо голых имён файлов с языковым суффиксом. UA — без префикса ("/sell"),
// RU/EN — с префиксом ("/ru/sell", "/en/sell"); сам лендинг ("/", "/ru", "/en")
// уже задаёт язык, поэтому дальше по сайту суффикс не повторяется в самом слове.
const CLEAN_PUBLIC_ROUTES = {
  "/ru": "trade-ru.html",
  "/en": "trade-en.html",
  "/sell": "sell-quote.html",
  "/buy": "buy-quote.html",
  "/my-skins": "my-skins.html",
  "/ru/sell": "sell-quote-ru.html",
  "/ru/buy": "buy-quote-ru.html",
  "/ru/my-skins": "my-skins-ru.html",
  "/en/sell": "sell-quote-en.html",
  "/en/buy": "buy-quote-en.html",
  "/en/my-skins": "my-skins-en.html",
  "/trade": "swap.html",
  "/ru/trade": "swap-ru.html",
  "/en/trade": "swap-en.html",
};
for (const [route, file] of Object.entries(CLEAN_PUBLIC_ROUTES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, "public", file)));
}

// Старые адреса этих же страниц — редирект на чистые (ссылка на trade.html
// уже могла разойтись, например в рекламном посте в Telegram-группе).
const OLD_PUBLIC_REDIRECTS = {
  "/trade.html": "/",
  "/trade-ru.html": "/ru",
  "/trade-en.html": "/en",
  "/sell-quote.html": "/sell",
  "/buy-quote.html": "/buy",
  "/my-skins.html": "/my-skins",
  "/sell-quote-ru.html": "/ru/sell",
  "/buy-quote-ru.html": "/ru/buy",
  "/my-skins-ru.html": "/ru/my-skins",
  "/sell-quote-en.html": "/en/sell",
  "/buy-quote-en.html": "/en/buy",
  "/my-skins-en.html": "/en/my-skins",
};
for (const [oldPath, newPath] of Object.entries(OLD_PUBLIC_REDIRECTS)) {
  app.get(oldPath, (req, res) => res.redirect(newPath));
}

// ---- Личный кабинет клиента (вход через Steam, без паролей) ----
// Отдельная сессия от внутреннего логина (req.session.customer, не
// req.session.username) — клиент и владелец сайта не пересекаются.
app.get("/account", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"));
});
app.get("/ru/account", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "account-ru.html"));
});
app.get("/en/account", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "account-en.html"));
});

// Разом з профілем віддаємо баланс — цей роут смикає кожна сторінка сайту
// для шапки, тож окремий запит за балансом був би зайвим.
app.get("/api/account/me", (req, res) => {
  const customer = req.session.customer || null;
  if (!customer) return res.json({ customer: null });

  const balance = skinbuxSales.computeBalance(customer.steamId);
  res.json({
    customer,
    balance: {
      ...balance,
      availableUah: Math.round(balance.available * config.uahRate),
      holdUah: Math.round(balance.hold * config.uahRate),
      uahRate: config.uahRate,
    },
  });
});

// Цена выкупа для клиента: сначала смотрим, не задана ли на предмет ручная
// цена (priceOverrides.js), и только потом считаем по формуле. Через эту
// функцию должны идти ВСЕ места, где клиент видит цену, иначе в кабинете и
// в прайс-чекере окажутся разные числа.
function sellQuoteFor(marketHashName, row, opts) {
  const manual = priceOverrides.get(marketHashName);
  if (manual != null) return { ok: true, price: manual, manual: true };
  return computeSellQuote(row, opts);
}

// Doppler и Gamma Doppler стоят по-разному в зависимости от фазы, поэтому в
// прайсе они лежат под синтетическим ключом "<name> - <phase>" (см.
// sources/skinbux.js). В инвентаре же имя приходит без фазы, а фаза —
// отдельным полем, и поиск по голому имени не находил НИЧЕГО: у всех
// дopplerов не было цены, а ручная цена на "... - Phase 3" не привязывалась
// к реальному предмету клиента.
function priceKeyFor(item) {
  return item.phase ? `${item.marketHashName} - ${item.phase}` : item.marketHashName;
}

// Ціна клієнту за конкретний предмет з інвентарю. Для авто-ціни bid Skinbux
// беремо не з загального прайс-листа, а з інвентарю — там ціна саме цього
// предмета і свіжіша. Інакше показана клієнту ціна розходилась із тією, з якою
// Skinbux звіряє продаж: поки прайс-лист відставав, ми пропонували більше, ніж
// вони платять, і продаж падав (або проходив у мінус).
function quoteForItem(it, opts) {
  const priceKey = priceKeyFor(it);
  const row = cache.rows.find((r) => r.marketHashName === priceKey);
  const liveRow =
    row && it.skinbuxPriceCents != null
      ? { ...row, prices: { ...row.prices, skinbux: { ...row.prices?.skinbux, bid: it.skinbuxPriceCents / 100 } } }
      : row;
  return { row, quote: sellQuoteFor(priceKey, liveRow, opts) };
}

// Инвентарь клиента: основной источник — Skinbux, запасной — публичный
// инвентарь Steam. Steam отдаёт не все предметы (проверено: 61 из заявленных
// им же 71, причём среди пропавших были ножи, которые Skinbux спокойно
// принимает), поэтому спрашиваем в первую очередь тех, кто эти предметы и
// будет забирать. Если их API недоступен — не оставляем клиента без списка.
async function loadClientInventory(steamId, { force = false } = {}) {
  try {
    const items = await skinbuxInventory.fetchUserInventory(process.env.SKINBUX_API_KEY, steamId, { force });
    return { items, source: "skinbux" };
  } catch (err) {
    console.warn(`[account-inventory] Skinbux не отдал инвентарь (${err.message}) — беру из Steam`);
    // sellAccept тут неизвестен: Steam про приём предметов ничего не знает,
    // поэтому не помечаем ничего недоступным, чтобы не врать клиенту.
    const items = await fetchInventory(steamId, { force });
    return { items: items.map((it) => ({ ...it, sellAccept: true, skinbuxPriceCents: null, float: null, phase: null })), source: "steam" };
  }
}

// Инвентарь клиента через Steam (публичный, требует включённой приватности
// "Открыто для всех" в настройках Steam) — по каждому предмету считаем ту же
// цену выкупа, что и на "Продати" (см. sellQuote.js), только без ручного
// поиска: список сразу берётся из реального инвентаря.
app.get("/api/account/inventory", async (req, res) => {
  if (!req.session.customer) {
    return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  }
  // Первый снапшот цен после рестарта грузится не мгновенно (cs.money часто
  // отвечает 403 и уходит в headless-браузер), а без него computeSellQuote
  // вернёт ok:false вообще по каждому предмету — клиент видел бы инвентарь
  // со сплошным "ціна невідома" и чинил это только руками через F5.
  if (!cache.rows.length) {
    return res.json({ ok: false, error: "PRICES_NOT_READY" });
  }
  const tradeMode = req.query.mode === "trade";
  try {
    const { items: rawItems } = await loadClientInventory(req.session.customer.steamId, {
      force: req.query.refresh === "1",
    });
    // Предметы, которые в принципе никогда не торгуются (медали, монеты,
    // граффити), выкидываем — продать их нельзя в любом случае. А вот вещи во
    // временном трейд-бане показываем: раньше они пропадали молча, и клиент
    // решал, что сайт вообще не видит его инвентар.
    const items = rawItems
      .filter((it) => it.tradable || it.tradableAfter)
      .map((it) => {
        // У розділі Trade предмет клієнта беремо за 97% ціни Skinbux, а не
        // за 95%, як при звичайному викупі: там ми заробляємо ще й на своєму
        // боці обміну.
        const { quote } = quoteForItem(it, tradeMode ? { discount: 0.03 } : undefined);
        const { baseName, wear } = parseItemName(it.marketHashName);
        return {
          assetId: it.assetId,
          marketHashName: it.marketHashName,
          name: baseName,
          wear,
          icon: it.icon,
          tradable: it.tradable,
          tradableAfter: it.tradableAfter,
          // sellAccept: false — Skinbux этот предмет не принимает вообще.
          // Показываем его, но помечаем: раньше клиент узнавал об этом только
          // при попытке продать.
          sellAccept: it.sellAccept !== false,
          phase: it.phase ?? null,
          float: it.float ?? null,
          price: quote.ok ? quote.price : null,
        };
      })
      // Дороже — выше; без цены — в самый низ.
      .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
    res.json({ ok: true, items });
  } catch (err) {
    if (err.message === "STEAM_RATE_LIMITED") {
      // Без этой строки отказ по лимиту нигде не виден: в логах тишина, а
      // клиент показывает "Steam обмежує запити" — искать причину не по чему.
      console.warn(`[account-inventory] Steam ограничил запросы (429), кэша для ${req.session.customer.steamId} ещё нет`);
      return res.json({ ok: false, error: "STEAM_RATE_LIMITED" });
    }
    if (err.message === "PRIVATE_INVENTORY") {
      return res.json({ ok: false, error: "PRIVATE_INVENTORY" });
    }
    console.error("[account-inventory] Ошибка:", err.message);
    res.status(500).json({ ok: false, error: "Не удалось загрузить инвентарь" });
  }
});

// Клиент один раз сохраняет свою ссылку на Steam-обмен — без неё Skinbux
// некуда отправлять автоматический трейд при продаже.
app.post("/api/account/trade-url", (req, res) => {
  if (!req.session.customer) return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  try {
    const customer = customers.setTradeUrl(req.session.customer.steamId, (req.body || {}).tradeUrl);
    req.session.customer = customer;
    res.json({ ok: true, customer });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Продажа клієнтом кількох предметів одразу через Skinbux — предмет(и)
// реально йдуть у Steam-бота Skinbux, гроші по завершенню приходять на
// баланс Skinbux власника сайту (див. skinbuxTransactions.js). Ціну НЕ
// довіряємо клієнту — перераховуємо сервером по кожному assetId заново, щоб
// підмінений price з фронта не міг пройти.
app.post("/api/account/sell", async (req, res) => {
  const customer = req.session.customer;
  if (!customer) return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  if (!customer.tradeUrl) return res.status(400).json({ ok: false, error: "NO_TRADE_URL" });

  const assetIds = Array.isArray((req.body || {}).assetIds) ? req.body.assetIds : [];
  const expectedPrices = (req.body || {}).expectedPrices || {};
  if (!assetIds.length) return res.status(400).json({ ok: false, error: "Порожній список предметів" });

  try {
    // Для продажу — завжди свіжий інвентар, повз хвилинний кеш: у ньому
    // ціна Skinbux, а вона встигає змінитись, і тоді INVALID_PRICE.
    const { items: rawItems } = await loadClientInventory(customer.steamId, { force: true });
    const items = [];
    for (const assetId of assetIds) {
      const it = rawItems.find((r) => r.assetId === assetId);
      if (!it) throw new Error(`Предмет ${assetId} більше не знайдено в інвентарі`);
      // Предмети в трейд-бані тепер видно в списку, тож у продаж вони теж
      // можуть прилетіти — відмовляємо зрозумілою причиною, а не "не знайдено".
      if (!it.tradable) {
        throw new Error(`"${it.marketHashName}" ще в трейд-бані, його не можна продати`);
      }
      if (it.sellAccept === false) {
        throw new Error(`Skinbux не приймає "${it.marketHashName}"`);
      }

      const { row, quote } = quoteForItem(it);
      if (!quote.ok) throw new Error(`Немає ціни на "${it.marketHashName}"`);
      // Клієнт бачив у кошику певну ціну — дешевше за неї не продаємо, а
      // показуємо йому нову (PRICE_CHANGED). Інакше отримав би менше мовчки.
      const expected = Number(expectedPrices[assetId]);
      if (Number.isFinite(expected) && quote.price < expected - 0.005) throw skinbuxTx.priceChangedError();

      // quote.price — це наша (уцінена на 5%, див. sellQuote.js) ціна викупу
      // у КЛІЄНТА, її ми йому і платимо. У сам запит до Skinbux вона НЕ йде:
      // Skinbux звіряє переданий price зі своєю власною поточною ціною і
      // відхиляє з INVALID_PRICE при розбіжності — тому туди йде їхня ціна.
      // Беремо її з інвентарю: там ціна саме цього предмета, з урахуванням
      // фази, а не усереднений bid із загального прайс-листа.
      // row может отсутствовать: с ручной ценой quote.ok уже true, даже если
      // предмета нет в снапшоте цен — тогда полагаемся только на инвентарь.
      const skinbuxBid = row?.prices?.skinbux?.bid;
      const skinbuxCents = it.skinbuxPriceCents ?? (skinbuxBid != null ? Math.round(skinbuxBid * 100) : null);
      if (skinbuxCents == null) throw new Error(`Skinbux не дав ціни на "${it.marketHashName}"`);
      // Клієнту ніколи не платимо більше, ніж платить нам Skinbux: якщо їхня
      // ціна вже впала нижче показаної клієнту, продаж не проводимо.
      if (Math.round(quote.price * 100) > skinbuxCents) throw skinbuxTx.priceChangedError();

      // Skinbux хоче повний market_hash_name (з якістю в дужках), не "голу"
      // назву без wear. phase тепер приходить з їхнього ж інвентарю — раніше
      // ми слали null, бо зі Steam фазу Doppler не дістати.
      items.push({
        assetId: it.assetId,
        name: it.marketHashName,
        price: quote.price,
        skinbuxCents,
        phase: it.phase ?? null,
      });
    }

    // Skinbux хоче price цілим числом центів рядком (приклад в докладі: "7",
    // "109"), а не доларами з крапкою — інакше повертає INVALID_PRICE.
    const skinbuxItems = items.map((it) => ({
      assetId: it.assetId,
      name: it.name,
      phase: it.phase,
      price: String(it.skinbuxCents),
    }));
    const { result, items: soldItems } = await skinbuxTx.requestSellRepricing(
      process.env.SKINBUX_API_KEY,
      { items: skinbuxItems, steamId: customer.steamId, tradeUrl: customer.tradeUrl },
      { minCentsByAsset: Object.fromEntries(items.map((it) => [it.assetId, Math.round(it.price * 100)])) }
    );
    // Якщо Skinbux переназвав ціну — у журнал пишемо ту, за якою реально
    // продали, інакше профіт у /mytrades був би неправильний.
    for (const it of items) {
      const sold = soldItems.find((s) => s.assetId === it.assetId);
      if (sold) it.skinbuxCents = Number(sold.price);
    }

    const totalPrice = items.reduce((sum, it) => sum + Number(it.price), 0);
    skinbuxSales.record({
      id: result.id,
      steamId: customer.steamId,
      customerName: customer.displayName,
      items,
      totalPrice,
      offerId: result.offerId,
      expiresAt: result.expires_at,
      // steamId у відповіді — це бот Skinbux, а не клієнт (у запиті ми
      // передаємо клієнтський, у прикладах документації вони різні).
      botSteamId: result.steamId,
      botProfile: result.profileDetails,
    });

    res.json({ ok: true, totalPrice, ...result });
  } catch (err) {
    console.error("[account-sell] Ошибка:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Список угод клієнта для розділу "Мої угоди" в кабінеті — статус обміну і
// коли розблокуються гроші (unlockAt/unlocked рахує skinbuxSales.listByUser).
// Поки SKINBUX_WEBHOOK_SECRET не налаштований, вебхук (нижче) відхиляє всі
// вхідні запити — статус угоди сам ніколи не оновиться. Тому питаємо його
// самі, коли угоди хтось відкриває: клієнт у "Моїх угодах" або власник у
// панелі. "hold" теж опитуємо: саме з нього угода переходить у "completed".
async function refreshOpenSaleStatuses(sales) {
  for (const sale of sales) {
    if (!["created", "pending", "hold"].includes(sale.status)) continue;
    try {
      const result = await skinbuxTx.getTransactionStatus(process.env.SKINBUX_API_KEY, sale.id);
      // steamTradeId — так поле зветься саме у відповіді /transaction/status
      // (у вебхуку те саме значення приходить як steamOfferId).
      if (result?.status && result.status !== sale.status) {
        skinbuxSales.updateStatus(sale.id, result.status, result.steamTradeId);
      }
    } catch (err) {
      console.error(`[sales] Не вдалося перевірити статус угоди ${sale.id}:`, err.message);
    }
  }
}

app.get("/api/account/sales", async (req, res) => {
  if (!req.session.customer) return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  const steamId = req.session.customer.steamId;

  await refreshOpenSaleStatuses(skinbuxSales.loadAll().filter((s) => s.steamId === steamId));

  const sales = skinbuxSales.listByUser(steamId);
  res.json({ ok: true, sales, holdDays: skinbuxSales.HOLD_DAYS });
});

// Отметка "деньги клиенту выплачены" — только для владельца сайта.
// Без неё выплаченная сделка продолжала бы висеть в балансе клиента.
// Можна й поки гроші ще в холді у Skinbux: власник інколи платить клієнту
// раніше, і без цього сума так і світилась у клієнта, хоча її вже виплатили.
// Не прийняті й скасовані угоди платити нема за що.
app.post("/api/sales/:id/paid", requireSiteOwner, (req, res) => {
  const existing = skinbuxSales.loadAll().find((s) => String(s.id) === String(req.params.id));
  if (!existing) return res.status(404).json({ ok: false, error: "Угода не знайдена" });
  if (!["hold", "completed"].includes(existing.status)) {
    return res.status(400).json({ ok: false, error: `Угода ще не прийнята або скасована (статус: ${existing.status})` });
  }
  const sale = skinbuxSales.markPaid(req.params.id);
  console.log(`[sales] Угода ${sale.id} позначена як виплачена (статус Skinbux: ${sale.status})`);
  res.json({ ok: true, sale });
});

// Скасувати "виплачено" — якщо натиснув не на тій угоді.
app.post("/api/sales/:id/unpaid", requireSiteOwner, (req, res) => {
  const sale = skinbuxSales.unmarkPaid(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: "Угода не знайдена" });
  console.log(`[sales] З угоди ${sale.id} знято позначку "виплачено"`);
  res.json({ ok: true, sale });
});

// Вебхук от Skinbux — статус транзакции (created/pending/completed/
// cancelled/hold/reverted). Подпись: sha256(JSON.stringify(body) + secret) в
// base64, в заголовке x-auth. Без правильного секрета в .env отклоняем всё —
// иначе кто угодно может подделать "completed" и т.п.
app.post("/api/webhooks/skinbux", (req, res) => {
  const secret = process.env.SKINBUX_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[skinbux-webhook] SKINBUX_WEBHOOK_SECRET не задан в .env — вебхук отклонён");
    return res.status(500).json({ ok: false });
  }

  const signature = crypto
    .createHash("sha256")
    .update(JSON.stringify(req.body) + secret)
    .digest("base64");
  if (req.get("x-auth") !== signature) {
    console.error("[skinbux-webhook] Неверная подпись — запрос отклонён");
    return res.status(401).json({ ok: false });
  }

  const { id, status, steamOfferId } = req.body || {};
  skinbuxSales.updateStatus(id, status, steamOfferId);
  console.log(`[skinbux-webhook] Транзакция ${id} -> ${status}`);
  res.json({ ok: true });
});

// ?lang=ru/en едет в returnUrl Steam OpenID и повертається назад у
// query — так /auth/steam/return знає, на яку мовну версію /account
// повернути клієнта (Steam-логін проходить через один спільний colбек,
// не через /ru/... чи /en/...).
function accountUrlForLang(lang) {
  return lang === "ru" ? "/ru/account" : lang === "en" ? "/en/account" : "/account";
}

// Куда вернуть человека после входа (или неудачной попытки): туда, откуда
// начинал (next — только свои относительные адреса), иначе в кабинет.
function loginReturnUrl(req) {
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : null;
  return next || accountUrlForLang(req.query.lang);
}

function withLoginFailed(url) {
  return url + (url.includes("?") ? "&" : "?") + "login=failed";
}

app.get("/auth/steam", async (req, res) => {
  try {
    res.redirect(await steamAuth.getLoginUrl(req));
  } catch (err) {
    console.error(`[steam-auth] Не удалось отправить на Steam: ${err.message}`);
    res.redirect(withLoginFailed(loginReturnUrl(req)));
  }
});

app.get("/auth/steam/return", async (req, res) => {
  const backUrl = loginReturnUrl(req);
  const started = Date.now();
  const took = () => ((Date.now() - started) / 1000).toFixed(1) + "с";
  try {
    const steamId = await steamAuth.verifyReturn(req);
    const profile = await steamAuth.fetchSteamProfile(steamId);
    const customer = customers.upsertBySteamId(steamId, profile);
    req.session.customer = customer;
    console.log(`[steam-auth] Вход ${steamId} за ${took()}`);
    res.redirect(backUrl);
  } catch (err) {
    // Раньше тут молча возвращали на страницу — человек снова видел кнопку
    // "Войти" и думал, что сайт завис. Теперь страница покажет, что вход не
    // удался (см. nav-profile.js), а в логах видно причину и сколько ждали.
    console.error(`[steam-auth] Ошибка входа за ${took()}: ${err.message}`);
    res.redirect(withLoginFailed(backUrl));
  }
});

app.get("/auth/logout", (req, res) => {
  delete req.session.customer;
  res.redirect(accountUrlForLang(req.query.lang));
});

// Картинки не меняются — браузер держит их неделю и не перекачивает фон и
// скриншоты на каждом переходе. Стили и скрипты кешем не держим, чтобы
// обновления сайта доходили сразу (там браузер проверяет изменения по ETag).
const LONG_CACHE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".ico"]);
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (LONG_CACHE_EXT.has(path.extname(filePath).toLowerCase())) {
        res.setHeader("Cache-Control", "public, max-age=604800");
      }
    },
  })
);

// Текущий конфиг (для отображения/редактирования параметров в UI)
app.get("/api/config", (req, res) => {
  res.json(config);
});

// Обновить конфиг (комиссии, пороги прибыли) без перезапуска сервера
app.post("/api/config", (req, res) => {
  const incoming = req.body || {};
  Object.assign(config, incoming);
  fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(config, null, 2));
  res.json({ ok: true, config });
});

// Принудительное обновление цен
app.post("/api/refresh", async (req, res) => {
  await refreshPrices();
  res.json({ ok: !cache.error, updatedAt: cache.updatedAt, error: cache.error });
});

// Данные для таблицы: все строки + отдельно отфильтрованный топ прибыльных
app.get("/api/items", (req, res) => {
  const profitFilters = {
    minProfitUsd: parseFloat(req.query.minProfitUsd ?? config.filters.minProfitUsd),
    minProfitPercent: parseFloat(req.query.minProfitPercent ?? config.filters.minProfitPercent),
    maxResults: parseInt(req.query.maxResults ?? config.filters.maxResults, 10),
  };

  const displayFilters = {
    excludeStatTrak: parseBool(req.query.excludeStatTrak, config.filters.excludeStatTrak),
    excludeSouvenir: parseBool(req.query.excludeSouvenir, config.filters.excludeSouvenir),
    excludeStickers: parseBool(req.query.excludeStickers, config.filters.excludeStickers),
    minPrice: parseNullableFloat(req.query.minPrice, config.filters.minPrice),
    maxPrice: parseNullableFloat(req.query.maxPrice, config.filters.maxPrice),
    maxCsfloatSpreadPercent: parseNullableFloat(
      req.query.maxCsfloatSpreadPercent,
      config.filters.maxCsfloatSpreadPercent
    ),
    maxYoupinSpreadPercent: parseNullableFloat(
      req.query.maxYoupinSpreadPercent,
      config.filters.maxYoupinSpreadPercent
    ),
    maxBuffSpreadPercent: parseNullableFloat(
      req.query.maxBuffSpreadPercent,
      config.filters.maxBuffSpreadPercent
    ),
    phase: (req.query.phase || "").trim() || null,
  };

  const search = (req.query.search || "").toLowerCase().trim();
  let rows = cache.rows;
  if (search) {
    rows = rows.filter((r) => r.marketHashName.toLowerCase().includes(search));
  }

  rows = applyDisplayFilters(rows, displayFilters);

  // Ручной выбор связки "купить на X / продать на Y" — если задано хотя бы одно
  // из двух, пересчитываем профит под эту связку вместо автоматической лучшей.
  // Значение вида "csfloat:ask" — источник и конкретная сторона цены.
  const buySource = normalizeSourceSide(req.query.buySource);
  const sellSource = normalizeSourceSide(req.query.sellSource);
  if (buySource || sellSource) {
    rows = rows.map((r) => {
      const flip = findBestFlip(r.prices, config.sources, buySource, sellSource);
      return {
        ...r,
        bestBuySource: flip?.buySource ?? null,
        bestBuySide: flip?.buySide ?? null,
        bestBuyPrice: flip?.buyPrice ?? null,
        bestSellSource: flip?.sellSource ?? null,
        bestSellSide: flip?.sellSide ?? null,
        bestSellPrice: flip?.sellPrice ?? null,
        profitUsd: flip?.profitUsd ?? null,
        profitPercent: flip?.profitPercent ?? null,
      };
    });
  }

  res.json({
    updatedAt: cache.updatedAt,
    error: cache.error,
    total: rows.length,
    all: rows,
    topProfitable: filterAndSort(rows, profitFilters),
  });
});

// ---- Скан-вотчлист для внешнего бота автоперебития CSFloat buy order ----
// Фильтры берутся из config.csfloatBidScan; результат пишется на диск
// (csfloat-bid-watchlist.json) и кешируется здесь же для отдачи по GET.
let lastCsfloatBidScan = null;

async function runScheduledCsfloatBidScan() {
  lastCsfloatBidScan = runCsfloatBidScan(cache.rows, config);
  if (!lastCsfloatBidScan) return;

  console.log(`[csfloat-bid-scan] Готово. Новых кандидатов: ${lastCsfloatBidScan.count}`);

  try {
    const result = await sendScanToTelegram(lastCsfloatBidScan, {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    });
    if (!result.sent) console.warn(`[csfloat-bid-scan] Telegram пропущен: ${result.reason}`);
  } catch (err) {
    console.error(`[csfloat-bid-scan] Ошибка отправки в Telegram: ${err.message}`);
  }
}

app.get("/api/csfloat-bid-scan", (req, res) => {
  res.json(lastCsfloatBidScan || { generatedAt: null, count: 0, items: [] });
});

// Ручной запуск вне расписания — удобно для проверки, не дожидаясь 12 часов.
app.post("/api/csfloat-bid-scan/run", async (req, res) => {
  await runScheduledCsfloatBidScan();
  res.json(lastCsfloatBidScan || { ok: false, error: "csfloatBidScan отключён в config.json" });
});

// ---- Публичные страницы-котировщики (sell-quote.html/buy-quote.html) —
// без логина ----
// Отдельные от /api/item-search и /api/items эндпоинты: не отдают ничего,
// кроме названия предмета и уже посчитанной итоговой цены — сырые цены
// источников (buff/youpin/skinbux) наружу не уходят.
app.get("/api/public/item-search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json([]);

  const matches = [];
  for (const r of cache.rows) {
    if (matchesSearchQuery(r.marketHashName, q)) {
      matches.push({ marketHashName: r.marketHashName, name: r.name, wear: r.wear });
      if (matches.length >= 20) break;
    }
  }
  res.json(matches);
});

// Картинка предмета (см. steamImages.js) добавляется только когда цена
// реально посчиталась — незачем ходить в Steam за иконкой для предмета,
// который всё равно покажет "нестабильная цена".
app.get("/api/public/sell-quote", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name обязателен" });

  const row = cache.rows.find((r) => r.marketHashName === name);
  const quote = sellQuoteFor(name, row);
  if (quote.ok) {
    const images = await getSteamImages(name);
    quote.image = images?.thumb || null;
    quote.imageFull = images?.full || null;
  }
  res.json(quote);
});

app.get("/api/public/buy-quote", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name обязателен" });

  const row = cache.rows.find((r) => r.marketHashName === name);
  const quote = computeBuyQuote(row, { markup: pricingSettings.get().buyMarkup });
  if (quote.ok) {
    const images = await getSteamImages(name);
    quote.image = images?.thumb || null;
    quote.imageFull = images?.full || null;
  }
  res.json(quote);
});

// Вітрина розділу Trade — те, що клієнт може взяти в обмін. Список фіксований
// (tradeCatalog.js), ціна рахується з актуального прайсу, позиції без ціни на
// Youpin просто не показуємо, щоб не було карток без суми.
app.get("/api/public/trade-catalog", async (req, res) => {
  const items = [];
  for (const marketHashName of tradeCatalog.ITEMS) {
    const row = cache.rows.find((r) => r.marketHashName === marketHashName);
    const quote = computeBuyQuote(row, { markup: pricingSettings.get().tradeMarkup });
    if (!quote.ok) continue;
    const { baseName, wear } = parseItemName(marketHashName);
    items.push({ marketHashName, name: baseName, wear, price: quote.price });
  }

  // Картинки Steam кешуються на диск назавжди (steamImages.js), тож довгим цей
  // запит буде лише перший раз.
  const images = await Promise.all(items.map((it) => getSteamImages(it.marketHashName)));
  items.forEach((it, i) => {
    it.icon = images[i]?.full || null;
  });

  items.sort((a, b) => b.price - a.price);
  res.json({ ok: true, items });
});

// Пошук по ВСЬОМУ каталогу цін для розділу Trade: вітрина показує популярне,
// але дістати ми можемо будь-який скін, тому за назвою шукаємо серед усіх
// предметів зі знайомою ціною, а не лише серед списку вітрини.
app.get("/api/public/trade-search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ ok: true, items: [] });

  const matches = [];
  for (const row of cache.rows) {
    if (!matchesSearchQuery(row.marketHashName, q)) continue;
    const quote = computeBuyQuote(row, { markup: pricingSettings.get().tradeMarkup });
    if (!quote.ok) continue;
    const { baseName, wear } = parseItemName(row.marketHashName);
    matches.push({ marketHashName: row.marketHashName, name: baseName, wear, price: quote.price });
  }

  // Дорожче — вище: за запитом "керамбит" людині потрібен ніж, а не однойменні
  // графіті за два центи, які інакше опинялись першими.
  matches.sort((x, y) => y.price - x.price);
  const items = matches.slice(0, 24);

  const images = await Promise.all(items.map((it) => getSteamImages(it.marketHashName)));
  items.forEach((it, i) => {
    it.icon = images[i]?.full || null;
  });

  res.json({ ok: true, items });
});

// Публичная витрина "Мої скіни в наявності" (my-skins.html) — реальные
// холдинги владельца сайта, включая предметы в трейд-бане. Владелец
// зафиксирован намеренно (это не персональный трекер, а витрина бизнеса).
const MY_SKINS_OWNER = SITE_OWNER;

app.get("/api/public/my-skins", async (req, res) => {
  res.json(await trades.listPublicHoldings(MY_SKINS_OWNER, config));
});

// Продажи клиентов через сайт — кто, что, когда и почём. Живут отдельно от
// trades.json (там мои собственные покупки/продажи), поэтому в панели это
// отдельная таблица. Профит считаем как разницу между тем, что платит нам
// Skinbux, и тем, что мы должны клиенту.
// Свои аккаунты в "Продажах клиентов" не показываем: продажи с них — это не
// клиенты, а наши собственные сделки, и они только путают прибыль по клиентам.
// Сами записи не трогаем — у владельца аккаунта они видны в его кабинете.
const CLIENT_SALES_HIDDEN_STEAM_IDS = new Set([
  "76561199060089261", // lxnmnk
  "76561198158130074", // TARHUN
]);

app.get("/api/client-sales", requireSiteOwner, async (req, res) => {
  const clientSales = () => skinbuxSales.loadAll().filter((s) => !CLIENT_SALES_HIDDEN_STEAM_IDS.has(String(s.steamId)));

  // Невиплачені угоди перепитуємо в Skinbux — інакше в панелі висів старий
  // статус, поки клієнт сам не відкрив "Мої угоди".
  await refreshOpenSaleStatuses(clientSales().filter((s) => !s.paidAt));

  const sales = clientSales()
    .map((sale) => {
      // skinbuxCents есть у новых записей; у старых сохранялся skinbuxBid в
      // долларах — поддерживаем оба, чтобы история не поехала.
      const skinbuxTotal = (sale.items || []).reduce((sum, it) => {
        if (it.skinbuxCents != null) return sum + Number(it.skinbuxCents) / 100;
        if (it.skinbuxBid != null) return sum + Number(it.skinbuxBid);
        return sum;
      }, 0);

      return {
        id: sale.id,
        steamId: sale.steamId,
        customerName: sale.customerName,
        items: (sale.items || []).map((it) => it.name),
        totalPrice: sale.totalPrice,
        skinbuxTotal: Math.round(skinbuxTotal * 100) / 100,
        profit: Math.round((skinbuxTotal - sale.totalPrice) * 100) / 100,
        status: sale.status,
        paidAt: sale.paidAt || null,
        unlockAt: skinbuxSales.unlockAtOf(sale),
        createdAt: sale.createdAt,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, sales });
});

// Автодополнение названия предмета при добавлении сделки — ищем по подстроке
// среди актуального снапшота цен, чтобы название совпадало с реальным
// market_hash_name (и подхватывало фазы Doppler/Gamma Doppler).
// ---- Наценки (только владелец сайта) ----
// Меняются из панели, чтобы не лезть в код ради процента.
app.get("/api/pricing-settings", requireSiteOwner, (req, res) => {
  const s = pricingSettings.get();
  res.json({
    ok: true,
    buyMarkupPercent: Math.round(s.buyMarkup * 10000) / 100,
    tradeMarkupPercent: Math.round(s.tradeMarkup * 10000) / 100,
  });
});

app.post("/api/pricing-settings", requireSiteOwner, (req, res) => {
  try {
    const next = pricingSettings.setFromPercents(req.body || {});
    console.log(
      `[pricing] Купівля youpin +${(next.buyMarkup * 100).toFixed(2)}%, вітрина Trade youpin +${(next.tradeMarkup * 100).toFixed(2)}%`
    );
    res.json({
      ok: true,
      buyMarkupPercent: Math.round(next.buyMarkup * 10000) / 100,
      tradeMarkupPercent: Math.round(next.tradeMarkup * 10000) / 100,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- Ручные цены выкупа (только владелец сайта) ----
// Отдаём вместе с расчётной ценой, чтобы в панели было видно, от чего
// отличается ручная — иначе легко поставить сумму выше той, что платит
// Skinbux, и уйти в минус на сделке.
app.get("/api/price-overrides", requireSiteOwner, (req, res) => {
  const items = priceOverrides.list().map((entry) => {
    const row = cache.rows.find((r) => r.marketHashName === entry.marketHashName);
    const auto = computeSellQuote(row);
    return { ...entry, autoPrice: auto.ok ? auto.price : null };
  });
  res.json({ ok: true, items });
});

app.post("/api/price-overrides", requireSiteOwner, (req, res) => {
  try {
    const { marketHashName, price, note } = req.body || {};
    const entry = priceOverrides.set(marketHashName, price, note);
    console.log(`[price-override] "${marketHashName}" -> $${entry.price}`);
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Удаление ручной цены = возврат к расчётной (bid скинбакса минус 5%).
app.delete("/api/price-overrides", requireSiteOwner, (req, res) => {
  const { marketHashName } = req.body || {};
  const removed = priceOverrides.remove(marketHashName);
  if (!removed) return res.status(404).json({ ok: false, error: "Ручной цены на этот предмет нет" });
  console.log(`[price-override] "${marketHashName}" -> обратно на расчётную`);
  res.json({ ok: true });
});

app.get("/api/item-search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json([]);

  const matches = [];
  for (const r of cache.rows) {
    if (matchesSearchQuery(r.marketHashName, q)) {
      matches.push({ marketHashName: r.marketHashName, name: r.name, wear: r.wear });
      if (matches.length >= 20) break;
    }
  }
  res.json(matches);
});

// ---- Трекер сделок ("Мои сделки") — цены общие, но каждый видит и правит
// только свои сделки (owner = username из сессии) ----
app.get("/api/trades", (req, res) => {
  res.json(trades.listTrades({ owner: req.session.username, rows: cache.rows, config }));
});

// Сколько денег с продаж сейчас в холде/доступно/зависло по каждой площадке
// (см. trades.js computeBalances — прикидка по истории продаж, не реальный
// счёт, площадки не дают API для этого). Поверх расчёта накладываются ручные
// поправки владельца (balanceAdjustments.js) — например, если он часть денег
// уже вывел или потратил не через наш трекер.
app.get("/api/balances", (req, res) => {
  const raw = trades.computeBalances(req.session.username, config.sources);
  const adjustments = balanceAdjustments.getAdjustments(req.session.username);
  res.json(balanceAdjustments.applyAdjustments(raw, adjustments));
});

// Ручная правка баланса конкретного поля (active/hold/frozen) на площадке —
// value это то число, которое владелец хочет видеть, а не сама поправка;
// разницу с текущим "чистым" расчётом мы сохраняем сами (см. balanceAdjustments.js).
app.post("/api/balances/:source/adjust", (req, res) => {
  const { field, value } = req.body || {};
  if (!["active", "hold", "frozen"].includes(field)) {
    return res.status(400).json({ ok: false, error: "Некорректное поле" });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return res.status(400).json({ ok: false, error: "Некорректное значение" });
  }

  const raw = trades.computeBalances(req.session.username, config.sources);
  const rawValue = raw[req.params.source]?.[field] ?? 0;
  balanceAdjustments.setAdjustment(req.session.username, req.params.source, field, num, rawValue);

  const adjustments = balanceAdjustments.getAdjustments(req.session.username);
  res.json({ ok: true, balances: balanceAdjustments.applyAdjustments(raw, adjustments) });
});

// Перекинуть часть активного (не в холде/заморозке) баланса с одной площадки
// на другую — например "$1000 на Skinbux не в холде, вывожу их в Crypto".
// Это тоже просто цифры в наших поправках, никакого реального вывода денег
// не происходит — только чтобы дашборд отражал, что деньги теперь "лежат"
// в другом месте.
app.post("/api/balances/transfer", (req, res) => {
  const { fromSource, toSource, amount } = req.body || {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, error: "Некорректная сумма" });
  }
  if (!fromSource || !toSource || fromSource === toSource) {
    return res.status(400).json({ ok: false, error: "Некорректные площадки" });
  }

  const raw = trades.computeBalances(req.session.username, config.sources);
  const merged = balanceAdjustments.applyAdjustments(raw, balanceAdjustments.getAdjustments(req.session.username));

  const fromActive = merged[fromSource]?.active ?? 0;
  if (amt > fromActive) {
    return res.status(400).json({ ok: false, error: `На ${fromSource} нет столько на активном балансе (доступно $${fromActive.toFixed(2)})` });
  }

  const rawFromActive = raw[fromSource]?.active ?? 0;
  const rawToActive = raw[toSource]?.active ?? 0;
  const toActive = merged[toSource]?.active ?? 0;

  balanceAdjustments.setAdjustment(req.session.username, fromSource, "active", fromActive - amt, rawFromActive);
  balanceAdjustments.setAdjustment(req.session.username, toSource, "active", toActive + amt, rawToActive);

  const updatedAdjustments = balanceAdjustments.getAdjustments(req.session.username);
  res.json({ ok: true, balances: balanceAdjustments.applyAdjustments(raw, updatedAdjustments) });
});

app.post("/api/trades", (req, res) => {
  try {
    const trade = trades.addTrade({
      ...req.body,
      owner: req.session.username,
      rows: cache.rows,
      sourcesConfig: config.sources,
    });
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/trades/:id/sell", (req, res) => {
  try {
    const trade = trades.sellTrade(req.params.id, req.session.username, req.body || {}, config.sources);
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/trades/:id/unlock-at", (req, res) => {
  try {
    const trade = trades.setUnlockAt(req.params.id, req.session.username, (req.body || {}).unlockAt || null);
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/trades/:id/buy-date", (req, res) => {
  try {
    const trade = trades.setBuyDate(req.params.id, req.session.username, (req.body || {}).buyDate);
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/trades/:id", (req, res) => {
  try {
    trades.deleteTrade(req.params.id, req.session.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// Скриншот предмета — вызывается только владельцем сделки (req.session.username
// уже проверен auth-gate'ом выше, findOwnedTrade внутри setTradeImage
// дополнительно не даст прицепить фото к чужой сделке).
app.post("/api/trades/:id/image", (req, res) => {
  upload.single("image")(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ ok: false, error: uploadErr.message });
    if (!req.file) return res.status(400).json({ ok: false, error: "Файл не получен" });

    try {
      const imagePath = `/uploads/skins/${req.file.filename}`;
      const trade = trades.setTradeImage(req.params.id, req.session.username, imagePath);
      res.json({ ok: true, trade });
    } catch (err) {
      fs.unlink(req.file.path, () => {}); // не оставляем файл-сироту при ошибке
      res.status(400).json({ ok: false, error: err.message });
    }
  });
});

function parseBool(value, fallback) {
  if (value === undefined) return !!fallback;
  return value === "true" || value === "1";
}

function parseNullableFloat(value, fallback) {
  if (value === undefined) return fallback ?? null;
  if (value === "" || value === "null") return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

app.listen(PORT, async () => {
  console.log(`CS2 price dashboard: http://localhost:${PORT}`);
  await refreshPrices(); // первая загрузка сразу при старте
  const intervalMs = (config.refreshIntervalMinutes || 5) * 60 * 1000;
  setInterval(refreshPrices, intervalMs);

  if (config.csfloatBidScan?.enabled) {
    runScheduledCsfloatBidScan(); // первый скан сразу после первой загрузки цен
    const scanIntervalMs = (config.csfloatBidScan.intervalHours || 12) * 60 * 60 * 1000;
    setInterval(runScheduledCsfloatBidScan, scanIntervalMs);
  }

  startTelegramArbBot(() => cache.rows, config);
});

// Корректно закрываем headless-браузер (если открывался) при остановке сервера,
// чтобы не оставался висящий процесс Chrome.
process.on("SIGINT", async () => {
  console.log("\n[*] Останавливаюсь...");
  await closeBrowser().catch(() => {});
  process.exit(0);
});
