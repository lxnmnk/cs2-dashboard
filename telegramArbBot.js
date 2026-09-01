// Интерактивный Telegram-бот "Мониторинг арбитража" — отдельный от
// telegramNotifier.js (тот шлёт csfloat-bid-scan раз в 12ч по фиксированному
// токену/чату). Этот бот слушает команды через long polling (getUpdates) на
// СВОЁМ токене (TELEGRAM_ARB_BOT_TOKEN) — намеренно ДРУГОМ, чтобы не
// конфликтовать с getUpdates, который может уже слушать csfloat-bot на своём
// токене (Telegram отдаёт 409 Conflict, если два процесса одновременно
// делают long polling одним и тем же токеном).
//
// Каждый чат, написавший /start, получает свой независимый набор фильтров
// (те же связки источник+сторона и display-фильтры, что и в arbitrage-
// таблице дашборда) и уведомляется только о лотах, ПОЯВИВШИХСЯ С
// ПРЕДЫДУЩЕГО СКАНА — не спамит одним и тем же лотом каждые 5 минут, пока
// он остаётся выгодным.
const fs = require("fs");
const path = require("path");
const { applyDisplayFilters, findBestFlip, normalizeSourceSide } = require("./pricingEngine");
const { DOPPLER_PHASES } = require("./itemName");

const SUBSCRIBERS_FILE = path.join(__dirname, "telegramArbSubscribers.json");
const TELEGRAM_API = "https://api.telegram.org";

const SOURCE_LABELS = {
  csfloat: "CSFloat",
  buff: "Buff163",
  youpin: "Youpin898",
  skinbux: "Skinbux",
  csmoney: "CS.Money",
};

function loadSubscribers() {
  if (!fs.existsSync(SUBSCRIBERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSubscribers(subs) {
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subs, null, 2));
}

function findSub(subs, chatId) {
  return subs.find((s) => s.chatId === chatId);
}

function defaultFilters() {
  return {
    buySource: "any",
    sellSource: "any",
    minProfitUsd: 5,
    minProfitPercent: 5,
    excludeStatTrak: false,
    excludeSouvenir: false,
    excludeStickers: false,
    minPrice: null,
    maxPrice: null,
    maxCsfloatSpreadPercent: null,
    maxYoupinSpreadPercent: null,
    maxBuffSpreadPercent: null,
    phase: null,
  };
}

// ---- Telegram Bot API — низкоуровневые вызовы ----
async function tgCall(token, method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(token, chatId, text, extra = {}) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Какие стороны цены источник вообще когда-либо отдаёт — независимо от
// canBuy/canSell. Skinbux — buyback-сервис, ask у него всегда null (см.
// sources/skinbux.js), поэтому кнопку "Skinbux ask" предлагать нельзя: связка
// с ней никогда не найдёт ни одного лота (findBestFlip.pointsFor вернёт []).
const SOURCE_AVAILABLE_SIDES = {
  csfloat: ["ask", "bid"],
  buff: ["ask", "bid"],
  youpin: ["ask", "bid"],
  skinbux: ["bid"],
  csmoney: ["ask", "bid"],
};

// ---- Инлайн-клавиатуры для выбора связки и фазы ----
function buildSourceKeyboard(kind, config) {
  const capField = kind === "buy" ? "canBuy" : "canSell";
  const sources = Object.entries(config.sources).filter(([, cfg]) => cfg.enabled && cfg[capField]);

  const buttons = [];
  for (const [source] of sources) {
    for (const side of SOURCE_AVAILABLE_SIDES[source] || ["ask", "bid"]) {
      buttons.push({ text: `${SOURCE_LABELS[source]} ${side}`, callback_data: `${kind}:${source}:${side}` });
    }
  }

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "Любой (any)", callback_data: `${kind}:any` }]);
  return { inline_keyboard: rows };
}

function buildPhaseKeyboard() {
  const buttons = DOPPLER_PHASES.map((p) => ({ text: p, callback_data: `phase:${p}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "Любая фаза (сброс)", callback_data: "phase:any" }]);
  return { inline_keyboard: rows };
}

function helpText() {
  return [
    "🤖 <b>Мониторинг арбитража CS2</b>",
    "",
    "Каждые 5 минут проверяю таблицу и присылаю новые выгодные лоты по твоим фильтрам (уже открытые лоты повторно не присылаю).",
    "",
    "/status — текущие фильтры",
    "/buy — выбрать источник покупки",
    "/sell — выбрать источник продажи",
    "/minprofit 10 — мин. профит в $",
    "/minpercent 5 — мин. профит в %",
    "/minprice 100 — мин. цена (или 'off')",
    "/maxprice 1000 — макс. цена (или 'off')",
    "/spread csfloat 15 — макс. спред csfloat/youpin/buff в % (или 'off')",
    "/toggle stattrak|souvenir|stickers — исключить/вернуть",
    "/phase — выбрать фазу Doppler/Gamma Doppler",
    "/reset — сбросить фильтры по умолчанию",
    "/stop — остановить уведомления",
  ].join("\n");
}

function statusText(sub) {
  return [
    "📋 <b>Текущие фильтры:</b>",
    `Покупка: ${escapeHtml(sub.buySource)}`,
    `Продажа: ${escapeHtml(sub.sellSource)}`,
    `Мин. профит: $${sub.minProfitUsd}`,
    `Мин. профит %: ${sub.minProfitPercent}%`,
    `Цена: ${sub.minPrice ?? "—"} .. ${sub.maxPrice ?? "—"}`,
    `Исключить StatTrak: ${sub.excludeStatTrak ? "да" : "нет"}`,
    `Исключить Souvenir: ${sub.excludeSouvenir ? "да" : "нет"}`,
    `Исключить наклейки: ${sub.excludeStickers ? "да" : "нет"}`,
    `Фаза: ${sub.phase ?? "любая"}`,
    `Спред CSFloat/Youpin/Buff: ${sub.maxCsfloatSpreadPercent ?? "—"} / ${sub.maxYoupinSpreadPercent ?? "—"} / ${sub.maxBuffSpreadPercent ?? "—"}`,
    `Статус: ${sub.active ? "активны" : "остановлены (/start — включить снова)"}`,
  ].join("\n");
}

// ---- Обработка входящих команд/кнопок ----
async function handleMessage(token, config, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return;

  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split("@")[0];

  const subs = loadSubscribers();
  let sub = findSub(subs, chatId);

  if (cmd === "/start") {
    if (!sub) {
      sub = { chatId, ...defaultFilters(), active: true, lastSeenKeys: null };
      subs.push(sub);
    } else {
      sub.active = true;
    }
    saveSubscribers(subs);
    await sendMessage(token, chatId, helpText());
    return;
  }

  if (!sub) {
    await sendMessage(token, chatId, "Сначала нажми /start.");
    return;
  }

  switch (cmd) {
    case "/help":
      await sendMessage(token, chatId, helpText());
      break;

    case "/status":
      await sendMessage(token, chatId, statusText(sub));
      break;

    case "/buy":
      await sendMessage(token, chatId, "Выбери источник покупки:", { reply_markup: buildSourceKeyboard("buy", config) });
      break;

    case "/sell":
      await sendMessage(token, chatId, "Выбери источник продажи:", { reply_markup: buildSourceKeyboard("sell", config) });
      break;

    case "/phase":
      await sendMessage(token, chatId, "Выбери фазу Doppler/Gamma Doppler:", { reply_markup: buildPhaseKeyboard() });
      break;

    case "/minprofit": {
      const n = parseFloat(args[0]);
      if (Number.isNaN(n)) {
        await sendMessage(token, chatId, "Формат: /minprofit 10");
        break;
      }
      sub.minProfitUsd = n;
      saveSubscribers(subs);
      await sendMessage(token, chatId, `Минимальный профит: $${n}`);
      break;
    }

    case "/minpercent": {
      const n = parseFloat(args[0]);
      if (Number.isNaN(n)) {
        await sendMessage(token, chatId, "Формат: /minpercent 5");
        break;
      }
      sub.minProfitPercent = n;
      saveSubscribers(subs);
      await sendMessage(token, chatId, `Минимальный профит %: ${n}%`);
      break;
    }

    case "/minprice": {
      const v = args[0];
      sub.minPrice = !v || v === "off" ? null : parseFloat(v);
      saveSubscribers(subs);
      await sendMessage(token, chatId, `Мин. цена: ${sub.minPrice ?? "не ограничена"}`);
      break;
    }

    case "/maxprice": {
      const v = args[0];
      sub.maxPrice = !v || v === "off" ? null : parseFloat(v);
      saveSubscribers(subs);
      await sendMessage(token, chatId, `Макс. цена: ${sub.maxPrice ?? "не ограничена"}`);
      break;
    }

    case "/spread": {
      const [src, val] = args;
      const field = {
        csfloat: "maxCsfloatSpreadPercent",
        youpin: "maxYoupinSpreadPercent",
        buff: "maxBuffSpreadPercent",
      }[src];
      if (!field) {
        await sendMessage(token, chatId, "Формат: /spread csfloat|youpin|buff 15  (или off)");
        break;
      }
      sub[field] = !val || val === "off" ? null : parseFloat(val);
      saveSubscribers(subs);
      await sendMessage(token, chatId, `Спред ${src}: ${sub[field] ?? "не ограничен"}`);
      break;
    }

    case "/toggle": {
      const key = { stattrak: "excludeStatTrak", souvenir: "excludeSouvenir", stickers: "excludeStickers" }[args[0]];
      if (!key) {
        await sendMessage(token, chatId, "Формат: /toggle stattrak|souvenir|stickers");
        break;
      }
      sub[key] = !sub[key];
      saveSubscribers(subs);
      await sendMessage(token, chatId, `${args[0]}: ${sub[key] ? "исключены" : "показываются"}`);
      break;
    }

    case "/stop":
      sub.active = false;
      saveSubscribers(subs);
      await sendMessage(token, chatId, "Уведомления остановлены. /start — включить снова.");
      break;

    case "/reset":
      Object.assign(sub, defaultFilters());
      sub.lastSeenKeys = null;
      saveSubscribers(subs);
      await sendMessage(token, chatId, "Фильтры сброшены на умолчания.");
      break;

    default:
      await sendMessage(token, chatId, "Неизвестная команда. /help — список команд.");
  }
}

async function handleCallback(token, cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || "";

  await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});

  const subs = loadSubscribers();
  const sub = findSub(subs, chatId);
  if (!sub) return;

  if (data.startsWith("buy:") || data.startsWith("sell:")) {
    const [kind, ...rest] = data.split(":");
    const value = rest.join(":");
    if (kind === "buy") sub.buySource = value;
    else sub.sellSource = value;
    saveSubscribers(subs);
    await sendMessage(token, chatId, `${kind === "buy" ? "Покупка" : "Продажа"}: ${escapeHtml(value)}`);
  } else if (data.startsWith("phase:")) {
    const phase = data.slice("phase:".length);
    sub.phase = phase === "any" ? null : phase;
    saveSubscribers(subs);
    await sendMessage(token, chatId, `Фаза: ${escapeHtml(sub.phase ?? "любая")}`);
  }
}

// ---- Скан и уведомления ----
function keyFor(row) {
  return row.marketHashName;
}

function computeQualifying(rows, config, sub) {
  const displayFilters = {
    excludeStatTrak: !!sub.excludeStatTrak,
    excludeSouvenir: !!sub.excludeSouvenir,
    excludeStickers: !!sub.excludeStickers,
    minPrice: sub.minPrice ?? null,
    maxPrice: sub.maxPrice ?? null,
    maxCsfloatSpreadPercent: sub.maxCsfloatSpreadPercent ?? null,
    maxYoupinSpreadPercent: sub.maxYoupinSpreadPercent ?? null,
    maxBuffSpreadPercent: sub.maxBuffSpreadPercent ?? null,
    phase: sub.phase || null,
  };

  const buyRestrict = normalizeSourceSide(sub.buySource);
  const sellRestrict = normalizeSourceSide(sub.sellSource);

  const results = [];
  for (const row of applyDisplayFilters(rows, displayFilters)) {
    const flip = findBestFlip(row.prices, config.sources, buyRestrict, sellRestrict);
    if (!flip) continue;
    if (flip.profitUsd == null || flip.profitUsd < (sub.minProfitUsd ?? 0)) continue;
    if (flip.profitPercent == null || flip.profitPercent < (sub.minProfitPercent ?? 0)) continue;
    results.push({ row, flip });
  }
  return results;
}

// Ссылка на поиск предмета на площадке (config.marketUrls) — точного ID лота
// у нас нет (cs2.sh отдаёт только агрегированные цены, не конкретные листинги),
// поэтому ведём на страницу поиска, отфильтрованную по названию предмета —
// это максимум, что можно сделать без данных о конкретном лоте.
function marketLink(config, source, linkName) {
  const template = config.marketUrls?.[source];
  if (!template) return null;
  return template.replace("{name}", encodeURIComponent(linkName));
}

function escapeAttr(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function sourceLink(config, source, side, linkName) {
  const url = marketLink(config, source, linkName);
  const label = `${SOURCE_LABELS[source]} (${side})`;
  return url ? `<a href="${escapeAttr(url)}">${label}</a>` : label;
}

function formatLot(item, index, config) {
  const { row, flip } = item;
  const buyLabel = sourceLink(config, flip.buySource, flip.buySide, row.linkName);
  const sellLabel = sourceLink(config, flip.sellSource, flip.sellSide, row.linkName);
  return (
    `${index}. <b>${escapeHtml(row.marketHashName)}</b>\n` +
    `Купить: ${buyLabel} — $${flip.buyPrice.toFixed(2)}\n` +
    `Продать: ${sellLabel} — $${flip.sellPrice.toFixed(2)}\n` +
    `Профит: $${flip.profitUsd.toFixed(2)} (${flip.profitPercent.toFixed(2)}%)`
  );
}

const MAX_LOTS_PER_MESSAGE = 15;

async function scanAndNotify(token, getRows, config) {
  const rows = getRows();
  if (!rows.length) return;

  const subs = loadSubscribers();
  let changed = false;

  for (const sub of subs) {
    if (!sub.active) continue;

    const qualifying = computeQualifying(rows, config, sub);
    const currentKeys = new Set(qualifying.map((it) => keyFor(it.row)));

    // Первый скан после /start или /reset — просто запоминаем текущий срез,
    // чтобы не вываливать разом всё, что уже давно выгодно.
    if (sub.lastSeenKeys == null) {
      sub.lastSeenKeys = Array.from(currentKeys);
      changed = true;
      continue;
    }

    const prevKeys = new Set(sub.lastSeenKeys);
    const newItems = qualifying.filter((it) => !prevKeys.has(keyFor(it.row)));

    if (newItems.length) {
      const capped = newItems.slice(0, MAX_LOTS_PER_MESSAGE);
      const header =
        newItems.length === 1
          ? "🔥 <b>Новый выгодный лот:</b>"
          : `🔥 <b>Новых выгодных лотов: ${newItems.length}</b>`;
      const body = capped.map((it, i) => formatLot(it, i + 1, config)).join("\n\n");
      const footer = newItems.length > capped.length ? `\n\n…и ещё ${newItems.length - capped.length}` : "";

      try {
        await sendMessage(token, sub.chatId, `${header}\n\n${body}${footer}`);
      } catch (err) {
        console.error(`[telegram-arb-bot] Ошибка отправки чату ${sub.chatId}: ${err.message}`);
      }
    }

    sub.lastSeenKeys = Array.from(currentKeys);
    changed = true;
  }

  if (changed) saveSubscribers(subs);
}

// ---- Long polling ----
async function pollLoop(token, config) {
  let offset = 0;

  try {
    const seed = await tgCall(token, "getUpdates", { offset: -1, timeout: 0 });
    if (seed.ok && seed.result.length) offset = seed.result[seed.result.length - 1].update_id + 1;
  } catch {
    // не критично — просто начнём с текущего момента после первого успешного вызова
  }

  for (;;) {
    try {
      const res = await tgCall(token, "getUpdates", { offset, timeout: 30 });
      if (!res.ok) {
        await sleep(3000);
        continue;
      }
      for (const update of res.result) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleMessage(token, config, update.message).catch((e) =>
            console.error("[telegram-arb-bot] handleMessage:", e.message)
          );
        } else if (update.callback_query) {
          await handleCallback(token, update.callback_query).catch((e) =>
            console.error("[telegram-arb-bot] handleCallback:", e.message)
          );
        }
      }
    } catch (err) {
      console.error(`[telegram-arb-bot] polling error: ${err.message}`);
      await sleep(3000);
    }
  }
}

/**
 * @param {() => Array} getRows - возвращает актуальный cache.rows на момент вызова
 * @param {Object} config - config.json
 */
function startTelegramArbBot(getRows, config) {
  const token = process.env.TELEGRAM_ARB_BOT_TOKEN;
  if (!token) {
    console.log("[telegram-arb-bot] TELEGRAM_ARB_BOT_TOKEN не задан — бот не запущен.");
    return;
  }

  pollLoop(token, config); // фоновый цикл, живёт пока жив процесс

  const intervalMs = (config.telegramArbBot?.intervalMinutes || 5) * 60 * 1000;
  scanAndNotify(token, getRows, config);
  setInterval(() => scanAndNotify(token, getRows, config), intervalMs);

  console.log("[telegram-arb-bot] Запущен.");
}

module.exports = {
  startTelegramArbBot,
  // Экспортировано дополнительно для тестов и переиспользования логики.
  computeQualifying,
  formatLot,
  defaultFilters,
  loadSubscribers,
  saveSubscribers,
  findSub,
  SUBSCRIBERS_FILE,
};
