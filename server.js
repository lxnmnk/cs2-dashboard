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
const { sendScanToTelegram, sendOwnerMessage } = require("./telegramNotifier");
const payoutDetails = require("./payoutDetails");
const { computeSellQuote } = require("./sellQuote");
const priceOverrides = require("./priceOverrides");
const { getSteamImages } = require("./steamImages");
const { computeBuyQuote } = require("./buyQuote");
const tradeCatalog = require("./tradeCatalog");
const pricingSettings = require("./pricingSettings");
const { localizedAlt } = require("./skinNamesI18n");
const { matchesSearchQuery, parseItemName } = require("./itemName");
const { startTelegramArbBot } = require("./telegramArbBot");
const steamAuth = require("./steamAuth");
const customers = require("./customers");
const balanceAdjustments = require("./balanceAdjustments");
const customerBalances = require("./customerBalances");
const { fetchInventory } = require("./steamInventory");
const skinbuxInventory = require("./skinbuxInventory");
const skinbuxTx = require("./skinbuxTransactions");
const skinbuxSales = require("./skinbuxSales");
const csfloatPurchases = require("./csfloatPurchases");
const skinbuxSalesImport = require("./skinbuxSalesImport");
const tradeFloats = require("./tradeFloats");
const debts = require("./debts");
const promoCodes = require("./promoCodes");
const { categoryOf, weaponOf, CATEGORY_ORDER, WEAPONS } = require("./itemCategory");
const capital = require("./capital");
const capitalBank = require("./capitalBank");
const csfloatAccount = require("./csfloatAccount");
const skinbuxAccount = require("./skinbuxAccount");
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
      // Выключенный источник не дёргаем вообще: у cs.money это не бесплатно —
      // каждая попытка поднимает headless-браузер и ждёт таймауты.
      config.sources.csmoney.enabled ? fetchCsMoneyLatest() : Promise.resolve(new Map()),
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

// ---- Партнерські посилання: gaben.market/sicarios ----
// Ловимо тільки те, що справді є кодом: усе інше йде далі своїм шляхом, тож
// сторінки й файли ця перевірка не перекриває. Код лягає в сесію (30 днів,
// стільки ж живе cookie сесії) — людина, що прийшла сьогодні й продала скін
// за тиждень, усе одно зарахується партнеру.
app.get(/^\/([a-zA-Z0-9_-]{3,20})$/, (req, res, next) => {
  const code = req.params[0];
  const promo = promoCodes.find(code);
  if (!promo) return next();

  promoCodes.countClick(promo.code);
  req.session.promo = promo.code;
  res.redirect("/");
});

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
  "/sell-offer-modal.js",
  "/quote.css",
  "/quote-common.js",
  "/bg-map.jpg",
  "/favicon.svg",
  "/api/public/item-search",
  "/api/public/sell-quote",
  "/api/public/buy-quote",
  "/api/public/catalog",
  "/catalog.js",
  "/api/public/rate",
  "/currency.js",
  "/api/public/my-skins",
  "/landing.js",
  "/api/public/trade-catalog",
  "/api/public/trade-search",
  "/swap.js",
  "/account",
  "/ru/account",
  "/en/account",
  "/profile",
  "/ru/profile",
  "/en/profile",
  "/profile.js",
  "/deal-card.js",
  "/auth/steam",
  "/auth/steam/return",
  "/auth/logout",
  "/api/account/me",
  "/api/account/inventory",
  "/api/account/trade-url",
  "/api/account/promo",
  "/api/account/sell",
  "/api/account/trade-sell",
  "/api/account/sales",
  "/api/webhooks/skinbux",
]);

// Сторінки внутрішньої панелі: тільки з них незалогіненого шлемо на вхід.
const PANEL_PATHS = new Set([
  "/mytrades",
  "/arbitrage",
  "/capital",
  "/index.html",
  "/trades.html",
  "/capital.html",
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/uploads/")) return next(); // скриншоты предметов — публичные файлы
  if (req.session?.username) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Не авторизован" });
  // Форма входу — для нас, а не для клієнтів. Людина, що відкрила мертве
  // партнерське посилання чи просто помилилась в адресі, має потрапити на
  // головну сайту, а не на логін персоналу. На логін ведуть тільки сторінки
  // самої панелі.
  return res.redirect(PANEL_PATHS.has(req.path) ? "/login.html" : "/");
});

// Инвестору — только капитал. Стоит сразу после входа и ДО всех роутов и
// express.static, поэтому закрывает и страницы, и файлы, и API разом.
app.use((req, res, next) => {
  if (!isInvestor(req)) return next();
  // Публичные страницы сайта инвестору так же открыты, как любому гостю, —
  // запрет касается внутренней панели, а не витрины.
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (INVESTOR_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ ok: false, error: "Доступна только страница капитала" });
  return res.redirect("/capital");
});

// В /mytrades сидит не только владелец сайта — у друзей свои учётки со своим
// трекером сделок. Всё, что касается бизнеса целиком (цены для клиентов,
// продажи клиентов, выплаты), доступно только владельцу — и на сервере, а не
// только спрятанными кнопками, иначе это можно вызвать запросом напрямую.
const SITE_OWNER = "lxnmnk";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function requireSiteOwner(req, res, next) {
  if (req.session?.username === SITE_OWNER) return next();
  res.status(403).json({ ok: false, error: "Только для владельца сайта" });
}

// ---- Инвесторы ----
// Учётка с ролью "investor" видит ровно одну страницу — капитал. Ни сделок,
// ни цен, ни клиентов: человек вложил деньги и смотрит, сколько стоит бизнес
// и какая часть его. Запрет серверный, а не спрятанные ссылки в меню: иначе
// /mytrades открылся бы прямым адресом.
const INVESTOR_PATHS = new Set([
  "/capital",
  "/capital.html",
  "/capital.js",
  "/api/capital",
  "/api/capital/history",
  "/api/me",
  "/api/logout",
  // Оформление страницы: без него она приедет голым текстом.
  "/style.css",
  "/favicon.svg",
  "/bg-map.jpg",
  "/auth-ui.js",
]);

function isInvestor(req) {
  return !!req.session?.username && users.roleOf(req.session.username) === "investor";
}

function requireCapitalAccess(req, res, next) {
  if (req.session?.username === SITE_OWNER || isInvestor(req)) return next();
  res.status(403).json({ ok: false, error: "Нет доступа" });
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const verified = await users.verifyUser(username, password);
  if (!verified) {
    return res.status(401).json({ ok: false, error: "Неверный логин или пароль" });
  }
  req.session.username = verified;
  res.json({ ok: true, username: verified, role: users.roleOf(verified) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  res.json({
    username: req.session.username,
    isSiteOwner: req.session.username === SITE_OWNER,
    role: users.roleOf(req.session.username),
  });
});

// Страница капитала — только владельцу. Стоит ДО express.static: public/
// раздаётся любому вошедшему в панель (там есть аккаунты друзей), и без
// этой проверки файл открылся бы по прямому адресу в обход роута /capital.
app.get(["/capital.html", "/capital.js"], requireCapitalAccess, (req, res) => {
  res.sendFile(path.join(__dirname, "public", req.path.slice(1)));
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
  "/ru/sell": "sell-quote-ru.html",
  "/ru/buy": "buy-quote-ru.html",
  "/en/sell": "sell-quote-en.html",
  "/en/buy": "buy-quote-en.html",
  "/trade": "swap.html",
  "/ru/trade": "swap-ru.html",
  "/en/trade": "swap-en.html",
  // Вітрина "Наші скіни" повернулась: у каталозі на /buy весь прайс під
  // замовлення, а тут те, що лежить на руках і їде сьогодні.
  "/my-skins": "my-skins.html",
  "/ru/my-skins": "my-skins-ru.html",
  "/en/my-skins": "my-skins-en.html",
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
// Профіль клієнта: хто ти, посилання на обмін, твої угоди і баланс. Окрема
// сторінка замість кружка в шапці — туди ж переїхало посилання на обмін зі
// сторінки продажу.
app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"));
});
app.get("/ru/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile-ru.html"));
});
app.get("/en/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile-en.html"));
});

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

  // Поправки владельца поверх расчёта по журналу: частичные выплаты, бонусы,
  // расчёты мимо сайта — см. customerBalances.js.
  const balance = customerBalances.apply(skinbuxSales.computeBalance(customer.steamId), customer.steamId);
  res.json({
    customer,
    balance: {
      ...balance,
      availableUah: Math.round(balance.available * config.uahRate),
      holdUah: Math.round(balance.hold * config.uahRate),
      tradeUah: Math.round(balance.trade * config.uahRate),
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
  // Скидка от цены Skinbux — из панели (Pricing), а не зашитые 5%.
  return computeSellQuote(row, opts || { discount: pricingSettings.get().sellDiscount });
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
/**
 * Знижка для цього відвідувача з урахуванням промокоду: бонус клієнта ми
 * платимо зі своєї маржі, тобто просто зменшуємо власну знижку. Одна функція
 * на показ цін і на сам продаж — інакше в кошику було б одне число, а при
 * продажу інше.
 */
function discountFor(req, { tradeMode = false } = {}) {
  const settings = pricingSettings.get();
  const base = tradeMode ? settings.tradeDiscount : settings.sellDiscount;
  const promo = promoCodes.find(req.session?.promo);
  if (!promo) return { discount: base, promo: null };
  // Знижка тут — частка (0.05 = 5%), а бонус коду задається у відсотках.
  // Без ділення на 100 код з'їдав би всю знижку одразу: клієнт отримував би
  // повну ціну Skinbux, а ми — нуль.
  return { discount: Math.max(0, base - promo.bonusPercent / 100), promo };
}

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
        const { quote } = quoteForItem(it, { discount: discountFor(req, { tradeMode }).discount });
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
          // Официальные русские/украинские названия — чтобы фильтр в браузере
          // находил предмет по "Красная линия" и т.п.
          searchAlt: localizedAlt(it.marketHashName),
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
// Автопродаж предметів клієнта на Skinbux. Один код на два випадки, щоб
// перевірки цін не розʼїхались:
//   tradeMode = false — кабінет, "Продати скіни": платимо Skinbux − 5%,
//                       гроші лягають у холд і потім виводяться;
//   tradeMode = true  — розділ Trade, сторона клієнта: беремо за Skinbux − 3%,
//                       гроші лягають у trade-баланс (skinbuxSales kind).
// Куди людина хоче отримати гроші. Список закритий: усе, що прийшло з
// браузера і не збіглося, зберігаємо як null, а не записуємо в журнал чуже.
const PAYOUT_METHODS = new Set(["card", "crypto"]);

async function sellCustomerItems(req, res, { tradeMode }) {
  const customer = req.session.customer;
  if (!customer) return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  if (!customer.tradeUrl) return res.status(400).json({ ok: false, error: "NO_TRADE_URL" });

  const assetIds = Array.isArray((req.body || {}).assetIds) ? req.body.assetIds : [];
  const expectedPrices = (req.body || {}).expectedPrices || {};
  if (!assetIds.length) return res.status(400).json({ ok: false, error: "Порожній список предметів" });

  // Реквізити виплати. В обміні грошей немає — клієнт отримує наші скіни,
  // тому там їх не питаємо і не вимагаємо.
  const method = PAYOUT_METHODS.has(String(req.body?.payoutMethod)) ? String(req.body.payoutMethod) : null;
  let details = null;
  if (!tradeMode) {
    if (!method) return res.status(400).json({ ok: false, error: "Обери спосіб виплати" });
    try {
      details = payoutDetails.parse(method, req.body?.payoutDetails);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }

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
        throw new Error(`Ми не приймаємо "${it.marketHashName}"`);
      }

      const { row, quote } = quoteForItem(it, { discount: discountFor(req, { tradeMode }).discount });
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
      if (skinbuxCents == null) throw new Error(`Немає ціни на "${it.marketHashName}" — напиши в Telegram, порахуємо вручну`);
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
      kind: tradeMode ? "trade" : "sell",
      // Спосіб виплати — те, що людина обрала в кошику. Виплачуємо руками,
      // тож це просто підказка власнику, куди слати гроші.
      payoutMethod: method,
      payoutDetails: details,
      // Хто привів цього клієнта — за цим рахується звіт по партнерах.
      promoCode: promoCodes.find(req.session?.promo)?.code || null,
    });

    res.json({ ok: true, totalPrice, ...result });
  } catch (err) {
    console.error(`[${tradeMode ? "trade-sell" : "account-sell"}] Ошибка:`, err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

// ---- Промокод у кошику ----
// Той самий код, що й у посиланні: хто прийшов за посиланням, уже має його в
// сесії, а хто почув на стрімі — вводить руками. Відповідь каже, який бонус
// застосовано, щоб кошик одразу перечитав ціни.
app.get("/api/account/promo", (req, res) => {
  const promo = promoCodes.find(req.session?.promo);
  res.json({ ok: true, promo: promo ? { code: promo.code, bonusPercent: promo.bonusPercent } : null });
});

app.post("/api/account/promo", (req, res) => {
  const raw = String(req.body?.code || "").trim();
  if (!raw) {
    delete req.session.promo;
    return res.json({ ok: true, promo: null });
  }
  const promo = promoCodes.find(raw);
  if (!promo) return res.status(400).json({ ok: false, error: "PROMO_NOT_FOUND" });

  req.session.promo = promo.code;
  res.json({ ok: true, promo: { code: promo.code, bonusPercent: promo.bonusPercent } });
});

// ---- Партнери й промокоди (панель власника) ----
app.get("/api/promo-codes", requireSiteOwner, (req, res) => {
  res.json({ ok: true, codes: promoCodes.report(skinbuxSales.loadAll()) });
});

app.post("/api/promo-codes", requireSiteOwner, (req, res) => {
  try {
    res.json({ ok: true, code: promoCodes.upsert(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/promo-codes/:code", requireSiteOwner, (req, res) => {
  try {
    promoCodes.remove(req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/account/sell", (req, res) => sellCustomerItems(req, res, { tradeMode: false }));
app.post("/api/account/trade-sell", (req, res) => sellCustomerItems(req, res, { tradeMode: true }));

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

// Коли гроші за угоду вийшли з холду Skinbux, їх можна переказувати клієнту —
// і про це треба сказати власнику, а не чекати, поки він сам відкриє панель.
// Повідомлення несе все, що потрібно для переказу: суму, банк, картку, ім'я.
// Позначка notifiedPayableAt не дає надіслати те саме двічі.
// Куди слати "можна платити". За замовчуванням — той самий бот, що надсилає
// скани CSFloat (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID). Якщо для виплат
// зручніший окремий бот або окремий чат, задається парою
// TELEGRAM_PAYOUT_BOT_TOKEN/TELEGRAM_PAYOUT_CHAT_ID — міняти код не треба.
function payoutBotCredentials() {
  return {
    botToken: process.env.TELEGRAM_PAYOUT_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_PAYOUT_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
  };
}

async function notifyPayableSales() {
  const pending = skinbuxSales.payableNow().filter((sale) => !sale.notifiedPayableAt);
  if (!pending.length) return;

  for (const sale of pending) {
    const uah = Math.round((Number(sale.totalPrice) || 0) * config.uahRate);
    const lines = [
      `💸 Можно платить — сделка #${sale.id}`,
      `Клиент: ${sale.customerName || "—"} (${sale.steamId})`,
      sale.payoutDetails?.method === "card"
        ? `Сумма: $${Number(sale.totalPrice).toFixed(2)} ≈ ${uah.toLocaleString("uk-UA")} ₴`
        : `Сумма: $${Number(sale.totalPrice).toFixed(2)}`,
      `Куда: ${payoutDetails.describe(sale.payoutDetails) || "реквизиты не указаны — спроси в Telegram"}`,
      `Предметы: ${(sale.items || []).map((it) => it.name).join(", ")}`,
      "",
      "После перевода отметь выплату в My Trades → Client Sales.",
    ];

    try {
      const result = await sendOwnerMessage(lines.join("\n"), payoutBotCredentials());
      if (!result.sent) {
        console.warn(`[payout] Угода ${sale.id} готова до виплати, але сповіщення не надіслано: ${result.reason}`);
        continue;
      }
      skinbuxSales.markNotifiedPayable(sale.id);
      // Реквізити в лог не пишемо — тільки те, за чим угоду можна знайти.
      console.log(`[payout] Угода ${sale.id} готова до виплати, власнику надіслано`);
    } catch (err) {
      console.error(`[payout] Не вдалося сповістити про угоду ${sale.id}:`, err.message);
    }
  }
}

// Сам по собі статус угоди не оновлюється: вебхук Skinbux вимкнений, а
// refreshOpenSaleStatuses смикається тільки коли хтось відкриває сторінку.
// Тому раз на чверть години перечитуємо незакриті угоди самі — щоб
// "гроші вийшли з холду" приходило в Telegram без участі людини.
const SALES_WATCH_MINUTES = 15;

function scheduleSalesWatch() {
  const tick = async () => {
    try {
      await refreshOpenSaleStatuses(skinbuxSales.loadAll().filter((s) => !s.paidAt));
      await notifyPayableSales();
    } catch (err) {
      console.error("[payout] Перевірка угод не вдалася:", err.message);
    }
  };
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, SALES_WATCH_MINUTES * 60 * 1000).unref?.();
}

// Останні реквізити клієнта — щоб у кошику не вписувати картку заново.
app.get("/api/account/payout", (req, res) => {
  if (!req.session.customer) return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  const last = skinbuxSales.lastPayout(req.session.customer.steamId);
  res.json({ ok: true, method: last?.method || null, details: last?.details || null });
});

app.get("/api/account/sales", async (req, res) => {
  if (!req.session.customer) return res.status(401).json({ ok: false, error: "NOT_LOGGED_IN" });
  const steamId = req.session.customer.steamId;

  await refreshOpenSaleStatuses(skinbuxSales.loadAll().filter((s) => s.steamId === steamId));
  await notifyPayableSales();

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

// ---- Каталог "Купити скіни" ----
// Вітрина з усього прайсу: ціна = youpin ask + націнка з панелі, тобто те
// саме, що рахує сторінка перевірки ціни. Склад ми не тримаємо — купуємо під
// замовлення, тому в каталозі один рядок на предмет, а не окремі лоти.
//
// Сторінками, бо предметів з ціною близько сорока тисяч: віддати їх разом —
// це десятки мегабайт і секунди очікування.
const CATALOG_PAGE_SIZE = 24;

/**
 * Чи варто взагалі показувати предмет у каталозі.
 *
 * Критерій простий і перевіряється сам собою: на предмет має бути автобай —
 * тобто хтось на ринку вже готовий його викупити, — і різниця між нашою ціною
 * й цим автобаєм має бути в межах config.catalog.maxSpread.
 *
 * Навіщо: у прайсі повно позицій із цінником, але без ринку — сувенірні стволи
 * по $154 869, наліпки з однією вигаданою пропозицією. Вони чесно мають ask,
 * тому в каталог лізли першими за ціною, а купити їх ніхто не купить і
 * продати назад теж. Автобай відрізняє реальний ринок від намальованого.
 */
function bestBidOf(row) {
  let best = null;
  for (const price of Object.values(row.prices || {})) {
    const bid = price?.bid;
    if (bid == null) continue;
    if (best == null || bid > best) best = bid;
  }
  return best;
}

function isLiquid(row, ourPrice) {
  const bid = bestBidOf(row);
  if (bid == null || !(ourPrice > 0)) return false;
  const maxSpread = config.catalog?.maxSpread ?? 0.3;
  return (ourPrice - bid) / ourPrice <= maxSpread;
}

// Вітрина на головній — не весь каталог, а короткий список найліквіднішого:
// те, що продається в будь-який день і за передбачувану ціну. Людина, яка
// вперше відкрила сайт, має побачити впізнавані речі, а не випадковий
// предмет із сорока тисяч.
//
// Список заданий руками власником і навмисно вузький. StatTrak і Souvenir
// сюди не йдуть: їхня ціна гуляє сильніше, а продаються вони довше.
const FEATURED_KNIVES = new Set([
  "★ Bayonet",
  "★ Butterfly Knife",
  "★ Flip Knife",
  "★ Karambit",
  "★ M9 Bayonet",
  "★ Stiletto Knife",
]);
// Gamma Doppler сюди теж потрапляє: для вітрини це той самий попит.
const FEATURED_KNIFE_SKINS = new Set(["Doppler", "Gamma Doppler", "Tiger Tooth", "Freehand", "Marble Fade", "Black Laminate"]);
const FEATURED_GUNS = new Set(["AK-47", "M4A4", "M4A1-S"]);
const FEATURED_GUN_SKINS = new Set(["Printstream", "Neo-Noir", "Neon Rider", "Neon Revolution"]);

// Рідкісні фази доплера (рубін, сапфір, смарагд, чорна перлина) пускаємо у
// вітрину, але тільки доступні: дорога фаза чекає покупця тижнями, і в ряду
// "ось що йде в будь-який день" їй не місце. Поріг у гривнях, бо саме в них
// на нього дивляться; у долари переводимо за тим самим курсом, що й усі
// ціни на сайті.
const FEATURED_RARE_PHASES = new Set(["Ruby", "Sapphire", "Emerald", "Black Pearl"]);
const FEATURED_RARE_PHASE_MAX_UAH = 80000;

function isRarePhase(marketHashName) {
  const { phase } = parseItemName(marketHashName);
  return !!phase && FEATURED_RARE_PHASES.has(phase);
}

function isFeatured(marketHashName) {
  if (marketHashName.includes("StatTrak\u2122") || marketHashName.startsWith("Souvenir ")) return false;
  // baseName — назва без якості й без синтетичного суфікса фази.
  const { baseName } = parseItemName(marketHashName);
  const [weapon, skin] = baseName.split(" | ");
  if (!skin) return false;
  if (FEATURED_KNIVES.has(weapon)) return FEATURED_KNIFE_SKINS.has(skin);
  if (FEATURED_GUNS.has(weapon)) return FEATURED_GUN_SKINS.has(skin);
  return false;
}

function catalogItems(query) {
  const q = String(query.q || "").trim();
  const category = String(query.category || "").trim();
  // Конкретна зброя всередині категорії: у фільтрі можна обрати не всі ножі,
  // а тільки Karambit і Butterfly.
  const weapons = new Set(String(query.weapon || "").split(",").filter(Boolean));
  const wears = new Set(String(query.wear || "").split(",").filter(Boolean));
  const special = String(query.special || "").trim();
  const min = parseFloat(query.min);
  const max = parseFloat(query.max);
  // У розділі Trade наша сторона коштує дорожче (своя націнка), тому каталог
  // уміє рахувати обома — інакше в обміні показувались би ціни купівлі.
  const settings = pricingSettings.get();
  const markup = query.mode === "trade" ? settings.tradeMarkup : settings.buyMarkup;

  const items = [];
  for (const row of cache.rows) {
    const name = row.marketHashName;
    if (query.featured === "1" && !isFeatured(name)) continue;
    if (q && !matchesSearchQuery(name, q)) continue;
    if (category && categoryOf(name) !== category) continue;
    if (weapons.size && !weapons.has(weaponOf(name))) continue;

    // У допплерів фаза приклеєна до якості ("Factory New · Phase 2") — тоді
    // ні код якості, ні сама фаза на картці не показувались, і два різні ножі
    // виглядали однаково. Розділяємо.
    const { baseName, wear: wearRaw, phase } = parseItemName(name);
    const wear = phase && wearRaw ? wearRaw.replace(` · ${phase}`, "") : wearRaw;
    if (wears.size && !wears.has(WEAR_BY_CODE_REVERSE[wear] || "")) continue;

    const isStatTrak = name.includes("StatTrak™");
    const isSouvenir = name.startsWith("Souvenir ");
    if (special === "stattrak" && !isStatTrak) continue;
    if (special === "souvenir" && !isSouvenir) continue;
    if (special === "normal" && (isStatTrak || isSouvenir)) continue;

    const quote = computeBuyQuote(row, { markup });
    if (!quote.ok) continue;
    // Рідкісну фазу показуємо у вітрині тільки до порога: дорожче — це вже
    // не "купи сьогодні", а місяць очікування покупця.
    if (query.featured === "1" && isRarePhase(name) && quote.price * config.uahRate > FEATURED_RARE_PHASE_MAX_UAH) continue;
    if (!isLiquid(row, quote.price)) continue;
    if (Number.isFinite(min) && quote.price < min) continue;
    if (Number.isFinite(max) && quote.price > max) continue;

    items.push({ marketHashName: name, name: baseName, wear, phase: phase || null, price: quote.price });
  }

  items.sort((a, b) => (query.sort === "price_asc" ? a.price - b.price : b.price - a.price));
  return items;
}

// Износ -> код для фильтра ("Factory New" -> "FN").
const WEAR_BY_CODE_REVERSE = {
  "Factory New": "FN",
  "Minimal Wear": "MW",
  "Field-Tested": "FT",
  "Well-Worn": "WW",
  "Battle-Scarred": "BS",
};

// Курс гривні для перемикача валют (public/currency.js). Один на весь сайт,
// щоб ціна в гривні не відрізнялась від сторінки до сторінки.
app.get("/api/public/rate", (req, res) => {
  res.json({ uahRate: config.uahRate });
});

app.get("/api/public/catalog", async (req, res) => {
  if (!cache.rows.length) return res.json({ ok: false, error: "PRICES_NOT_READY" });

  const all = catalogItems(req.query);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const items = all.slice((page - 1) * CATALOG_PAGE_SIZE, page * CATALOG_PAGE_SIZE);

  // Картинки тягнемо тільки для цієї сторінки — на сорок тисяч предметів це
  // були б десятки тисяч запитів до Steam.
  const images = await Promise.all(items.map((it) => getSteamImages(it.marketHashName)));
  items.forEach((it, i) => {
    it.icon = images[i]?.full || null;
  });

  res.json({
    ok: true,
    items,
    page,
    pages: Math.max(1, Math.ceil(all.length / CATALOG_PAGE_SIZE)),
    total: all.length,
    categories: CATEGORY_ORDER,
    // Списки зброї для випадайок у вкладках — беремо звідти ж, звідки
    // визначаємо категорію, щоб вони не розійшлись.
    weapons: WEAPONS,
  });
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
    items.push({ marketHashName, name: baseName, wear, price: quote.price, searchAlt: localizedAlt(marketHashName) });
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
// Фильтры панели (public/item-filters.js) должны отработать здесь, до того как
// ответ обрежется до двух десятков самых дорогих совпадений. Иначе получается
// так: на "m9" в прайсе сотни предметов, в верхушку попадают ножи от $1400, и
// фильтр "до $750" на клиенте не оставляет ничего — человек видит "ничего не
// нашли", хотя дешёвые M9 в прайсе есть.
const WEAR_BY_CODE = {
  FN: "Factory New",
  MW: "Minimal Wear",
  FT: "Field-Tested",
  WW: "Well-Worn",
  BS: "Battle-Scarred",
};

function parseSearchFilters(query) {
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const set = (v) =>
    new Set(
      String(v || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  return { min: num(query.min), max: num(query.max), wears: set(query.wear), special: set(query.special) };
}

function matchesSearchFilters(marketHashName, wear, price, filters) {
  if (filters.min != null && !(price >= filters.min)) return false;
  if (filters.max != null && !(price <= filters.max)) return false;

  if (filters.wears.size) {
    const ok = [...filters.wears].some((code) => WEAR_BY_CODE[code] && (wear || "").startsWith(WEAR_BY_CODE[code]));
    if (!ok) return false;
  }

  if (filters.special.size) {
    const isStatTrak = marketHashName.includes("StatTrak™");
    const isSouvenir = marketHashName.startsWith("Souvenir ");
    const ok =
      (filters.special.has("stattrak") && isStatTrak) ||
      (filters.special.has("souvenir") && isSouvenir) ||
      (filters.special.has("normal") && !isStatTrak && !isSouvenir);
    if (!ok) return false;
  }

  return true;
}

app.get("/api/public/trade-search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ ok: true, items: [] });

  const filters = parseSearchFilters(req.query);
  const matches = [];
  for (const row of cache.rows) {
    if (!matchesSearchQuery(row.marketHashName, q)) continue;
    const quote = computeBuyQuote(row, { markup: pricingSettings.get().tradeMarkup });
    if (!quote.ok) continue;
    const { baseName, wear } = parseItemName(row.marketHashName);
    if (!matchesSearchFilters(row.marketHashName, wear, quote.price, filters)) continue;
    matches.push({ marketHashName: row.marketHashName, name: baseName, wear, price: quote.price, searchAlt: localizedAlt(row.marketHashName) });
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
  const holdings = await trades.listPublicHoldings(MY_SKINS_OWNER, config, cache.rows);
  res.json(holdings.map((h) => ({ ...h, searchAlt: localizedAlt(h.marketHashName) })));
});

// Продажи клиентов через сайт — кто, что, когда и почём. Живут отдельно от
// trades.json (там мои собственные покупки/продажи), поэтому в панели это
// отдельная таблица. Профит считаем как разницу между тем, что платит нам
// Skinbux, и тем, что мы должны клиенту.
// Свои аккаунты в "Продажах клиентов" не показываем: продажи с них — это не
// клиенты, а наши собственные сделки, и они только путают прибыль по клиентам.
// Список общий с расчётом банка (capitalBank.js), поэтому лежит в skinbuxSales.
// Свои собственные продажи в списке клиентских не показываем — это не клиент,
// а мы сами. А вот продажи друга через наш аккаунт показываем: за них мы ему
// должны, и пока в панели не было строки "вернул", долг копился без конца и
// в банке выходил втрое больше настоящего.
const CLIENT_SALES_HIDDEN_STEAM_IDS = new Set([skinbuxSales.OWNER_STEAM_ID]);

app.get("/api/client-sales", requireSiteOwner, async (req, res) => {
  const clientSales = () => skinbuxSales.loadAll().filter((s) => !CLIENT_SALES_HIDDEN_STEAM_IDS.has(String(s.steamId)));

  // Невиплачені угоди перепитуємо в Skinbux — інакше в панелі висів старий
  // статус, поки клієнт сам не відкрив "Мої угоди".
  await refreshOpenSaleStatuses(clientSales().filter((s) => !s.paidAt));
  await notifyPayableSales();

  const sales = clientSales()
    .map((sale) => {
      // skinbuxCents есть у новых записей; у старых сохранялся skinbuxBid в
      // долларах — поддерживаем оба, чтобы история не поехала.
      const skinbuxTotal = (sale.items || []).reduce((sum, it) => {
        if (it.skinbuxCents != null) return sum + Number(it.skinbuxCents) / 100;
        if (it.skinbuxBid != null) return sum + Number(it.skinbuxBid);
        return sum;
      }, 0);

      // Продажа друга: деньги принадлежат ему целиком, нашей маржи тут нет,
      // и в сводку по клиентам она идти не должна.
      const partner = skinbuxSales.PARTNER_STEAM_IDS[String(sale.steamId)] || null;

      return {
        id: sale.id,
        steamId: sale.steamId,
        customerName: partner || sale.customerName,
        partner,
        // Записи до появи обміну — це завжди звичайний викуп.
        kind: sale.kind || "sell",
        items: (sale.items || []).map((it) => it.name),
        // Другу возвращаем всё, что пришло за его предметы.
        totalPrice: partner ? Math.round(skinbuxTotal * 100) / 100 : sale.totalPrice,
        skinbuxTotal: Math.round(skinbuxTotal * 100) / 100,
        profit: partner ? 0 : Math.round((skinbuxTotal - sale.totalPrice) * 100) / 100,
        status: sale.status,
        paidAt: sale.paidAt || null,
        unlockAt: skinbuxSales.unlockAtOf(sale),
        // Куди переказувати гроші — те, що клієнт вписав у кошику. Показуємо
        // повністю: саме з цього рядка власник і робить переказ.
        payout: sale.payoutDetails ? payoutDetails.describe(sale.payoutDetails) : null,
        createdAt: sale.createdAt,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Ручные продажи за клиента: сделку заводишь сам в add trade, в поле
  // Bought On пишешь gaben.market. Через сайт она не проходила, записи в
  // журнале нет — берём её из трекера, чтобы клиентские сделки были в одном
  // списке, а не в двух местах.
  const manual = trades
    .listRawTrades(req.session.username)
    .filter((t) => skinbuxAccount.boughtFromClient(t))
    .map((t) => ({
      id: t.id.slice(0, 8),
      steamId: null,
      customerName: null,
      manual: true,
      kind: "manual",
      items: [t.marketHashName],
      // "Должны клиенту" — это то, что мы за предмет заплатили.
      totalPrice: round2(t.buyPrice),
      skinbuxTotal: t.status === "sold" ? round2(t.sellPrice) : 0,
      profit: t.status === "sold" ? round2(t.sellPrice - t.buyPrice) : 0,
      status: t.status === "sold" ? "completed" : "holding",
      paidAt: null,
      unlockAt: null,
      createdAt: t.buyDate,
    }));

  res.json({ ok: true, sales: [...sales, ...manual].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// Автодополнение названия предмета при добавлении сделки — ищем по подстроке
// среди актуального снапшота цен, чтобы название совпадало с реальным
// market_hash_name (и подхватывало фазы Doppler/Gamma Doppler).
// ---- Наценки (только владелец сайта) ----
// Меняются из панели, чтобы не лезть в код ради процента.
// В панели всё в процентах, храним дробью.
function pricingPercents(p) {
  const pct = (v) => Math.round(v * 10000) / 100;
  return {
    buyMarkupPercent: pct(p.buyMarkup),
    sellDiscountPercent: pct(p.sellDiscount),
    tradeMarkupPercent: pct(p.tradeMarkup),
    tradeDiscountPercent: pct(p.tradeDiscount),
  };
}

app.get("/api/pricing-settings", requireSiteOwner, (req, res) => {
  res.json({ ok: true, ...pricingPercents(pricingSettings.get()) });
});

app.post("/api/pricing-settings", requireSiteOwner, (req, res) => {
  try {
    const p = pricingPercents(pricingSettings.setFromPercents(req.body || {}));
    console.log(
      `[pricing] Купівля: youpin +${p.buyMarkupPercent}% | продаж: Skinbux −${p.sellDiscountPercent}% | трейд: наші youpin +${p.tradeMarkupPercent}%, клієнта Skinbux −${p.tradeDiscountPercent}%`
    );
    res.json({ ok: true, ...p });
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
    const auto = computeSellQuote(row, { discount: pricingSettings.get().sellDiscount });
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
// Баланс CSFloat берём из их API — это единственная площадка, которая его
// отдаёт. Прикидка по истории продаж и ручные поправки для неё больше не
// нужны: живое число всегда точнее. Ключ у нас один, владельца сайта, поэтому
// подменяем только ему — у друзей в панели останется их собственный расчёт.
async function balancesFor(username) {
  const raw = trades.computeBalances(username, config.sources);
  const merged = balanceAdjustments.applyAdjustments(raw, balanceAdjustments.getAdjustments(username));
  if (username !== SITE_OWNER) return merged;

  try {
    const live = await csfloatAccount.fetchBalance(process.env.CSFLOAT_API_KEY);
    merged.csfloat = {
      // pending у CSFloat — деньги за продажи, пока идёт защита сделки:
      // по смыслу это тот же hold, что у других площадок.
      active: live.available,
      hold: live.pending,
      frozen: 0,
      nextUnlockAt: null,
      source: "api",
    };
  } catch (err) {
    // Не молчим: иначе не отличить "на CSFloat пусто" от "ключ не сработал".
    merged.csfloat = { ...(merged.csfloat || { active: 0, hold: 0, frozen: 0, nextUnlockAt: null }), source: "error", error: err.message };
  }

  // Skinbux тоже отдаёт баланс, и вдобавок мы умеем разложить холд по
  // владельцам денег: свои продажи, продажи друга через наш аккаунт и
  // продажи клиентов через сайт (см. skinbuxAccount.splitHold).
  try {
    const live = await skinbuxAccount.fetchBalance(process.env.SKINBUX_API_KEY);
    let hold = null;
    try {
      const transactions = await skinbuxAccount.fetchTransactions(process.env.SKINBUX_API_KEY);
      hold = skinbuxAccount.splitHold(transactions, {
        sales: skinbuxSales.loadAll(),
        // Продажи мимо сайта опознаются по трекеру: там видно, за сколько
        // предмет куплен и у кого (Bought On: gaben.market — у клиента).
        trackerSales: trades.listRawTrades(username),
        ownerSteamId: skinbuxSales.OWNER_STEAM_ID,
        partners: skinbuxSales.PARTNER_STEAM_IDS,
      });
    } catch (err) {
      console.warn("[balances] Skinbux: холд не разложен:", err.message);
    }
    merged.skinbux = {
      active: live.available,
      hold: live.pending,
      frozen: 0,
      nextUnlockAt: hold?.nextUnlockAt || null,
      source: "api",
      holdSplit: hold,
    };
  } catch (err) {
    merged.skinbux = { ...(merged.skinbux || { active: 0, hold: 0, frozen: 0, nextUnlockAt: null }), source: "error", error: err.message };
  }

  return merged;
}

app.get("/api/balances", async (req, res) => {
  res.json(await balancesFor(req.session.username));
});

// Ручная правка баланса конкретного поля (active/hold/frozen) на площадке —
// value это то число, которое владелец хочет видеть, а не сама поправка;
// разницу с текущим "чистым" расчётом мы сохраняем сами (см. balanceAdjustments.js).
app.post("/api/balances/:source/adjust", (req, res) => {
  // CSFloat читается из API — правка руками всё равно не переживёт
  // следующее чтение, поэтому честно отказываем, а не делаем вид.
  if (["csfloat", "skinbux"].includes(req.params.source) && req.session.username === SITE_OWNER) {
    return res.status(400).json({ ok: false, error: "Этот баланс приходит из API площадки и правке не подлежит" });
  }
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
app.post("/api/balances/transfer", async (req, res) => {
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

  // CSFloat и Skinbux читаются из API: списание там произойдёт само, когда деньги
  // реально уйдут. Поправку по нему не сохраняем, иначе она будет вычитаться
  // из живого баланса каждый раз.
  if (!(["csfloat", "skinbux"].includes(fromSource) && req.session.username === SITE_OWNER)) {
    balanceAdjustments.setAdjustment(req.session.username, fromSource, "active", fromActive - amt, rawFromActive);
  }
  balanceAdjustments.setAdjustment(req.session.username, toSource, "active", toActive + amt, rawToActive);

  res.json({ ok: true, balances: await balancesFor(req.session.username) });
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

// ---- Капитал и прибыль инвесторов (capital.js, capitalBank.js) ----
// Вся страница /capital и её роуты — только для владельца: тут балансы
// инвесторов и личные траты, чужим аккаунтам в панели этого видеть незачем.
app.get("/capital", requireCapitalAccess, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "capital.html"));
});

// Банк на сейчас + предварительный расчёт периода. refresh=1 — перечитать
// инвентарь Steam мимо кеша.
app.get("/api/capital", requireCapitalAccess, async (req, res) => {
  try {
    const state = capital.load();
    const bank = await capitalBank.collectBank({
      state,
      rows: cache.rows,
      config,
      // Банк — это бизнес владельца, а не того, кто смотрит страницу: у
      // инвестора своего трекера сделок нет, и инвентарь посчитался бы нулём.
      owner: SITE_OWNER,
      // Те же самые карточки, что в My Trades: один источник чисел на два
      // экрана, иначе они рано или поздно разойдутся.
      balances: await balancesFor(SITE_OWNER),
      owedToMe: debts.totalOwed(SITE_OWNER).total,
      refresh: req.query.refresh === "1",
    });
    const preview = capital.previewPeriod(state, bank.total);

    if (isInvestor(req)) {
      // Банк инвестору — с разбивкой по площадкам, но без нашей кухни: ни
      // сверки с инвентарём Steam, ни чьих-то имён в долгах. Чужие деньги на
      // счетах (клиентские выплаты и расчёты с партнёрами) идут одной
      // безымянной строкой — иначе сумма не сходилась бы с банком.
      const you = state.participants.find((p) => p.login && p.login === req.session.username) || null;
      const investorBank = {
        inventory: bank.inventory,
        money: bank.money,
        moneyTotal: bank.moneyTotal,
        owedToMe: bank.owedToMe,
        liabilities: { total: bank.liabilities.total },
        leftoverDebt: bank.leftoverDebt,
        assets: bank.assets,
        total: bank.total,
        collectedAt: bank.collectedAt,
        errors: [],
      };
      // Инвестору — банк, доли и история прибыли. Личные траты владельца в
      // расчёте участвуют (из-за них падает банк), но суммы и записи о них
      // чужих денег не касаются и наружу не идут.
      return res.json({
        ok: true,
        investor: true,
        you: you ? { id: you.id, name: you.name } : null,
        state: {
          participants: state.participants,
          managerFeePct: state.managerFeePct,
          periods: state.periods.slice(-12).map(({ movements, personalSpend, personalIncome, ...p }) => p),
        },
        bank: investorBank,
        preview: {
          openingTotal: preview.openingTotal,
          bankTotal: preview.bankTotal,
          profit: preview.profit,
          investorsProfit: preview.investorsProfit,
          managerFeePct: preview.managerFeePct,
          closingTotal: preview.closingTotal,
          mismatch: preview.mismatch,
          rows: preview.rows.map(({ personalSpend, personalIncome, ...r }) => r),
        },
        pricesReady: cache.rows.length > 0,
      });
    }

    res.json({
      ok: true,
      state: { ...state, periods: state.periods.slice(-12) },
      bank,
      preview,
      pricesReady: cache.rows.length > 0,
    });
  } catch (err) {
    console.error("[capital] Ошибка:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Прибыль за выбранный отрезок — по дневной истории закрытий. Доступна и
// инвестору: ради неё всё и затевалось.
app.get("/api/capital/history", requireCapitalAccess, (req, res) => {
  try {
    res.json({ ok: true, ...capital.profitBetween({ from: req.query.from, to: req.query.to }) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/capital/participants", requireSiteOwner, (req, res) => {
  try {
    capital.setParticipants(req.body?.participants);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/capital/settings", requireSiteOwner, (req, res) => {
  try {
    capital.setSettings(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/capital/movement", requireSiteOwner, (req, res) => {
  try {
    capital.addMovement(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/capital/movement/:id", requireSiteOwner, (req, res) => {
  try {
    capital.deleteMovement(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Закрытие периода: банк собирается заново прямо здесь, а не берётся из
// того, что прислал браузер — иначе прибыль зависела бы от того, как давно
// открыта страница.
app.post("/api/capital/close", requireSiteOwner, async (req, res) => {
  try {
    const state = capital.load();
    const bank = await capitalBank.collectBank({
      state,
      rows: cache.rows,
      config,
      owner: req.session.username,
      refresh: true,
    });
    if (bank.errors.length) {
      return res.status(400).json({ ok: false, error: `Банк собран не полностью: ${bank.errors.join("; ")}` });
    }
    const period = capital.closePeriod(bank.total, bank, { note: req.body?.note });
    res.json({ ok: true, period });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Импорт продаж со Skinbux: закрывает в трекере позиции, которые проданы с
// нашего аккаунта (skinbuxSalesImport.js). Продажи клиентов и друга через
// сайт пропускаются — они учтены отдельно и предметы там не наши.
app.post("/api/trades/import/skinbux", requireSiteOwner, async (req, res) => {
  try {
    const transactions = await skinbuxAccount.fetchTransactions(process.env.SKINBUX_API_KEY);

    // Инвентарь нужен, чтобы выбрать из одинаковых скинов проданный: float
    // того, что ещё лежит, виден здесь (tradeFloats.js). force — кэш минутной
    // давности тут вреден, предмет мог уйти только что. Если инвентарь не
    // ответил, импорт не ломаем: откатываемся на FIFO и говорим об этом.
    let inventory = null;
    let inventoryError = null;
    try {
      inventory = await skinbuxInventory.fetchUserInventory(
        process.env.SKINBUX_API_KEY,
        skinbuxSales.OWNER_STEAM_ID,
        { force: true }
      );
    } catch (err) {
      inventoryError = err.message;
    }

    // Заодно дополняем float'ы позиций, где их не вписывали руками (youpin,
    // cs.money): в предпросмотре это видно сразу, а записываем только при
    // подтверждении — dryRun ничего не меняет.
    // С расчётными полями: isLocked говорит, что предмета нет в инвентаре не
    // потому, что он продан, а потому, что он под защитой сделки.
    const rawTrades = trades.listTrades({ owner: req.session.username, rows: cache.rows, config });
    const fill = tradeFloats.planFill(rawTrades, inventory);
    const plan = skinbuxSalesImport.planImport({
      transactions,
      journal: skinbuxSales.loadAll(),
      rawTrades: tradeFloats.applyFillInMemory(rawTrades, fill.assignments),
      days: req.body?.days,
      ownerSteamId: skinbuxSales.OWNER_STEAM_ID,
      inventory,
    });
    const floats = { filled: fill.assignments.length, ambiguous: fill.ambiguous, error: inventoryError };

    if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, floats, ...plan });

    const filled = trades.setFloatMany(req.session.username, fill.assignments);
    const { closed, failed } = skinbuxSalesImport.applyImport(plan, {
      owner: req.session.username,
      sourcesConfig: config.sources,
    });
    res.json({ ok: true, closed, failed, floats: { ...floats, filled }, ...plan });
  } catch (err) {
    console.error("[skinbux-import] Ошибка:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Импорт покупок с CSFloat одной кнопкой (csfloatPurchases.js). Только для
// владельца: ключ CSFloat один на весь сайт — его, и чужой аккаунт в панели
// не должен затащить себе его сделки.
//
// dryRun — сначала показать, что найдено, и только потом писать: список
// приходит из недокументированного эндпоинта, и увидеть его глазами до
// записи полусотни строк дешевле, чем потом их удалять.
app.post("/api/trades/import/csfloat", requireSiteOwner, async (req, res) => {
  try {
    const { purchases, fetched, skipped, days, mode } = await csfloatPurchases.fetchPurchases(
      process.env.CSFLOAT_API_KEY,
      { days: req.body?.days, mode: req.body?.mode === "all" ? "all" : "purchased" }
    );
    const known = trades.listExternalIds(req.session.username);
    const fresh = purchases.filter((p) => !known.has(p.externalId));
    const summary = {
      fetched,
      skipped,
      days,
      mode,
      found: purchases.length,
      alreadyHave: purchases.length - fresh.length,
    };

    if (req.body?.dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        ...summary,
        items: fresh.map((p) => ({
          marketHashName: p.marketHashName,
          buyPrice: p.buyPrice,
          buyDate: p.buyDate,
          floatValue: p.floatValue,
          received: p.received,
        })),
      });
    }

    let added = 0;
    const failed = [];
    for (const p of fresh) {
      const { baseName, wear } = parseItemName(p.marketHashName);
      try {
        trades.addTrade({
          marketHashName: p.marketHashName,
          name: baseName,
          wear,
          buySource: "csfloat",
          buyPrice: p.buyPrice,
          buyDate: p.buyDate,
          unlockAt: p.unlockAt,
          owner: req.session.username,
          rows: cache.rows,
          sourcesConfig: config.sources,
          externalId: p.externalId,
          floatValue: p.floatValue,
          assetId: p.assetId,
        });
        added++;
      } catch (err) {
        failed.push(`${p.marketHashName}: ${err.message}`);
      }
    }
    res.json({ ok: true, added, failed, ...summary });
  } catch (err) {
    console.error("[csfloat-import] Ошибка:", err.message);
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

// ---- Долги в нашу сторону (debts.js) ----
// Единственные деньги, которых не видно ниоткуда: ни площадки, ни инвентарь
// про них не знают. Поэтому запись ручная, у каждого аккаунта панели своя.
app.get("/api/debts", (req, res) => {
  res.json({ ok: true, debts: debts.list(req.session.username), ...debts.totalOwed(req.session.username) });
});

app.post("/api/debts", (req, res) => {
  try {
    const debt = debts.add({ ...req.body, owner: req.session.username });
    res.json({ ok: true, debt, ...debts.totalOwed(req.session.username) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/debts/:id/repaid", (req, res) => {
  try {
    const debt = debts.setRepaid(req.params.id, req.session.username, req.body?.repaid !== false);
    res.json({ ok: true, debt, ...debts.totalOwed(req.session.username) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/debts/:id", (req, res) => {
  try {
    debts.remove(req.params.id, req.session.username);
    res.json({ ok: true, ...debts.totalOwed(req.session.username) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- Балансы клиентов (только владелец) ----
// Что человек видит у себя в профиле, то и здесь: расчёт по журналу продаж
// плюс ручные поправки по Steam ID (customerBalances.js).
function customerBalanceRows() {
  const sales = skinbuxSales.loadAll();
  // Клиенты: кто входил в кабинет, кто что-то продавал через сайт и кому
  // уже ставили поправку. Свои и партнёрские аккаунты это не клиенты.
  const names = new Map();
  for (const sale of sales) {
    const id = String(sale.steamId || "");
    if (!id || skinbuxSales.OWN_STEAM_IDS.has(id)) continue;
    if (sale.customerName) names.set(id, sale.customerName);
    else if (!names.has(id)) names.set(id, null);
  }
  for (const c of customers.list()) {
    const id = String(c.steamId || "");
    if (!id || skinbuxSales.OWN_STEAM_IDS.has(id)) continue;
    names.set(id, c.displayName || names.get(id) || null);
  }
  for (const id of customerBalances.steamIds()) {
    if (!names.has(id)) names.set(id, null);
  }

  return [...names.entries()]
    .map(([steamId, name]) => {
      const computed = skinbuxSales.computeBalance(steamId);
      const adjustment = customerBalances.totalsFor(steamId);
      const balance = customerBalances.apply(computed, steamId);
      return {
        steamId,
        name,
        computed,
        adjustment,
        balance,
        total: round2(balance.available + balance.hold + balance.trade),
        entries: customerBalances.listFor(steamId),
      };
    })
    // Сверху те, у кого деньги на балансе: с ними и есть что решать.
    .sort((a, b) => b.total - a.total || String(a.name || "").localeCompare(String(b.name || "")));
}

app.get("/api/customer-balances", requireSiteOwner, (req, res) => {
  res.json({ ok: true, clients: customerBalanceRows() });
});

app.post("/api/customer-balances", requireSiteOwner, (req, res) => {
  try {
    const { steamId, amount, bucket, note } = req.body || {};
    const entry = customerBalances.add({ steamId, amount, bucket, note, by: req.session.username });
    res.json({ ok: true, entry, clients: customerBalanceRows() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/customer-balances/:steamId/:entryId", requireSiteOwner, (req, res) => {
  try {
    customerBalances.remove(req.params.steamId, req.params.entryId);
    res.json({ ok: true, clients: customerBalanceRows() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Сверка открытых позиций с инвентарём: чего уже нет на аккаунте (продано
// мимо Skinbux — на Youpin, прямым трейдом). Ничего не закрывает: цену и дату
// продажи владелец вписывает сам, мы только показываем, что искать.
app.post("/api/trades/inventory-check", requireSiteOwner, async (req, res) => {
  try {
    const inventory = await skinbuxInventory.fetchUserInventory(
      process.env.SKINBUX_API_KEY,
      skinbuxSales.OWNER_STEAM_ID,
      { force: true }
    );
    // Сделки берём с расчётными полями: нужен isLocked. Предметы в трейд-бане
    // Skinbux в инвентаре не показывает вовсе, и без этой пометки все свежие
    // покупки с CSFloat выглядели бы проданными.
    const rawTrades = trades.listTrades({ owner: req.session.username, rows: cache.rows, config });
    const fill = tradeFloats.planFill(rawTrades, inventory);
    const filled = trades.setFloatMany(req.session.username, fill.assignments);

    const report = tradeFloats.checkHoldings(tradeFloats.applyFillInMemory(rawTrades, fill.assignments), inventory);
    res.json({
      ok: true,
      ...report,
      floatsFilled: filled,
      inventoryCount: inventory.length,
      inventoryWithFloat: inventory.filter((i) => i.float != null).length,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[inventory-check] Ошибка:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// float предмета руками: пустая строка — стереть. Пригождается там, где float
// не приходит сам (youpin, cs.money) и подтянуть из инвентаря однозначно
// нельзя — например, когда одинаковых скинов на аккаунте несколько.
app.post("/api/trades/:id/float", (req, res) => {
  try {
    const trade = trades.setFloat(req.params.id, req.session.username, (req.body || {}).floatValue);
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

// ---- Ежедневное закрытие периода ----
// Инвестор выбирает отрезок календарём и хочет увидеть прибыль за него. Для
// этого история должна писаться сама, каждый день: из редких закрытий руками
// отрезок "с 29 сентября по 6 октября" не собрать.
//
// Считает то же самое, что кнопка "Закрыть период", поэтому расхождений между
// автоматикой и ручным закрытием быть не может — это буквально один вызов.
const CAPITAL_CLOSE_HOUR = 0; // местное время сервера
const CAPITAL_CLOSE_MINUTE = 5;

async function runDailyCapitalClose() {
  try {
    const state = capital.load();
    if (!state.participants.length) return; // участники ещё не заведены

    const today = new Date().toDateString();
    const last = state.periods[state.periods.length - 1];
    if (last && new Date(last.closedAt).toDateString() === today) return; // за сегодня уже есть

    const bank = await capitalBank.collectBank({
      state,
      rows: cache.rows,
      config,
      owner: SITE_OWNER,
      balances: await balancesFor(SITE_OWNER),
      owedToMe: debts.totalOwed(SITE_OWNER).total,
    });
    // Банк с недочитанными балансами занижен, и разница легла бы в убыток
    // периода, который потом разошёлся бы по людям. Лучше пропустить день:
    // завтрашний период просто посчитает за двое суток.
    if (bank.errors.length) {
      console.warn("[capital] Автозакрытие пропущено:", bank.errors.join(" | "));
      return;
    }
    if (!cache.rows.length) {
      console.warn("[capital] Автозакрытие пропущено: цены ещё не загружены");
      return;
    }

    const period = capital.closePeriod(bank.total, bank, { note: "авто" });
    console.log(`[capital] Период закрыт: банк $${period.bankTotal}, прибыль $${period.profit}`);
  } catch (err) {
    // Чаще всего это "балансы не сходятся с банком" — расчёт не записан, и
    // разбираться с этим надо руками, а не молча.
    console.error("[capital] Автозакрытие не удалось:", err.message);
  }
}

function scheduleDailyCapitalClose() {
  const next = new Date();
  next.setHours(CAPITAL_CLOSE_HOUR, CAPITAL_CLOSE_MINUTE, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);

  setTimeout(() => {
    runDailyCapitalClose();
    setInterval(runDailyCapitalClose, 24 * 60 * 60 * 1000);
  }, next - new Date());
  console.log(`[capital] Следующее автозакрытие периода: ${next.toLocaleString()}`);
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

  scheduleDailyCapitalClose();
  scheduleSalesWatch();

  startTelegramArbBot(() => cache.rows, config);
});

// Корректно закрываем headless-браузер (если открывался) при остановке сервера,
// чтобы не оставался висящий процесс Chrome.
process.on("SIGINT", async () => {
  console.log("\n[*] Останавливаюсь...");
  await closeBrowser().catch(() => {});
  process.exit(0);
});
