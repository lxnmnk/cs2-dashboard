// Sell-бот (TELEGRAM_SELL_BOT_TOKEN): где, когда и почём продать предметы из
// My Trades, которые уже вышли из трейд-бана.
//
// Правила (по порядку, срабатывает первое):
//   1. Предмет уже выставлен нами на CSFloat (csfloatAutoList.js) — говорим,
//      по какой цене и почему (цена = Youpin ask, Skinbux дешевле 99%).
//   2. Skinbux bid ≥ 99% от Youpin ask — сдать на Skinbux: почти та же
//      цена, но сразу и без ожидания покупателя.
//   3. Брали под CS.Money (пометка /csmoney или при покупке лучшим выкупом
//      был CS.Money) — сдать в выкуп CS.Money.
//   4. Youpin ask и bid отличаются не больше чем на 8% — выставить на Youpin
//      по ask (рынок плотный, продастся). Если CSFloat ask такой же — можно
//      и на CSFloat по той же цене.
//   Иначе — хорошего выхода сейчас нет, держим (видно только в /list).
//
// Раз в intervalMinutes проверяем и присылаем то, что изменилось: предмет
// вышел из бана, сменилась площадка или цена сдвинулась на 3%+. Полный
// список — по /list.
const fs = require("fs");
const path = require("path");
const trades = require("./trades");
const { sendMessage, escapeHtml, ownerChatId, startPolling, parseCommand } = require("./telegramBot");

const TAG = "telegram-sell-bot";
const STATE_FILE = path.join(__dirname, "sellAdvisorState.json");
const AUTOLIST_FILE = path.join(__dirname, "csfloatAutoListings.json");

const DEFAULTS = {
  intervalMinutes: 30,
  maxYoupinSpreadPercent: 8,
  skinbuxPercentOfYoupinAsk: 99,
  // CSFloat ask "такой же, как Youpin": не дешевле Youpin ask больше чем на столько %.
  csfloatSameAsYoupinPercent: 1,
  // Повторно пишем про тот же предмет, если цена сдвинулась хотя бы на столько %.
  repriceNotifyPercent: 3,
};

const LABEL = { csfloat: "CSFloat", youpin: "Youpin", skinbux: "Skinbux", csmoney: "CS.Money", buff: "Buff" };

function settings(config) {
  return { ...DEFAULTS, ...(config.sellAdvisor || {}) };
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const pct = (n) => `${Math.round(n * 10) / 10}%`;
const KYIV = { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" };
const when = (iso) => new Date(iso).toLocaleString("ru-RU", KYIV);
const shortId = (t) => t.id.slice(0, 6);

function netOf(config, source, gross) {
  return gross * (1 - (config.sources[source]?.sellFee || 0));
}

function profitText(config, source, gross, buyPrice) {
  if (!(buyPrice > 0)) return "";
  const p = netOf(config, source, gross) - buyPrice;
  return ` → ${p >= 0 ? "+" : ""}${money(p)} (${p >= 0 ? "+" : ""}${pct((p / buyPrice) * 100)})`;
}

/** Наши лоты на CSFloat (csfloatAutoListings.json) по названию — без тех, что уже ушли. */
function autoListedByName() {
  const state = loadJson(AUTOLIST_FILE, { listings: {} });
  const byName = new Map();
  for (const [assetId, l] of Object.entries(state.listings || {})) {
    if (l.gone) continue;
    const list = byName.get(l.name) || [];
    list.push({ assetId, ...l });
    byName.set(l.name, list);
  }
  return byName;
}

/**
 * Совет по одной позиции: { venue, price, text } или { venue: "hold", text }.
 * listing — наш лот на CSFloat для этого предмета, если есть.
 */
function adviseTrade(t, row, config, cfg, listing) {
  const p = row?.prices || {};
  const ya = p.youpin?.ask ?? null;
  const yb = p.youpin?.bid ?? null;
  const ca = p.csfloat?.ask ?? null;
  const sb = p.skinbux?.bid ?? null;
  const cm = p.csmoney?.bid ?? null;
  const buy = Number(t.buyPrice) || 0;

  if (listing) {
    const why = [
      ya != null ? `цена = Youpin ask ${money(ya)}` : "по Youpin ask",
      sb != null && ya ? `Skinbux ${money(sb)} = ${pct((sb / ya) * 100)} от Youpin (< ${cfg.skinbuxPercentOfYoupinAsk}%)` : null,
    ].filter(Boolean);
    const drift = ya != null && Math.abs(ya - listing.price) >= 0.01 ? `\n  Youpin сейчас ${money(ya)} — переоценю при следующем проходе автолиста.` : "";
    return {
      venue: "csfloat-listed",
      price: listing.price,
      text: `📌 Уже выставлено на CSFloat по ${money(listing.price)}${profitText(config, "csfloat", listing.price, buy)}\n  Почему: ${why.join("; ")}.${drift}`,
    };
  }

  if (!row) return { venue: "hold", text: "нет цен в таблице" };

  if (sb != null && ya != null && sb >= ya * (cfg.skinbuxPercentOfYoupinAsk / 100)) {
    return {
      venue: "skinbux",
      price: sb,
      text: `💵 Сдать на Skinbux за ${money(sb)}${profitText(config, "skinbux", sb, buy)}\n  Почему: ${pct((sb / ya) * 100)} от Youpin ask ${money(ya)} — та же цена, но сразу (деньги через 7 дней).`,
    };
  }

  const csmoneyTarget = t.sellTarget === "csmoney" || (!t.sellTarget && t.buySnapshot?.bestBid?.source === "csmoney");
  if (csmoneyTarget && cm != null) {
    return {
      venue: "csmoney",
      price: cm,
      text: `🏦 Сдать в выкуп CS.Money за ${money(cm)}${profitText(config, "csmoney", cm, buy)}\n  Почему: брали под CS.Money${t.sellTarget ? "" : " (при покупке лучшим выкупом был CS.Money)"}.`,
    };
  }

  if (ya != null && yb != null && ya > 0) {
    const spread = ((ya - yb) / ya) * 100;
    if (spread <= cfg.maxYoupinSpreadPercent) {
      const csfloatSame = ca != null && ca >= ya * (1 - cfg.csfloatSameAsYoupinPercent / 100);
      return {
        venue: "youpin",
        price: ya,
        text:
          `🟠 Выставить на Youpin по ask ${money(ya)}${profitText(config, "youpin", ya, buy)}\n  Почему: bid ${money(yb)}, разница ${pct(spread)} (≤ ${cfg.maxYoupinSpreadPercent}%) — рынок плотный.` +
          (csfloatSame ? `\n  Или CSFloat по ${money(ya)}: там ask ${money(ca)} — такой же.` : ""),
      };
    }
    return {
      venue: "hold",
      text: `держать: Youpin ask ${money(ya)} / bid ${money(yb)} — разница ${pct(spread)} > ${cfg.maxYoupinSpreadPercent}%${sb != null ? `, Skinbux ${pct((sb / ya) * 100)} от ask` : ""}`,
    };
  }
  return { venue: "hold", text: "держать: нет цены Youpin" };
}

/** Все свободные (без трейд-бана) позиции с советом + запертые с датой разбана. */
function buildAdvice(rows, config) {
  const cfg = settings(config);
  const owner = config.sellAdvisor?.owner || process.env.TRADES_OWNER || "lxnmnk";
  const all = trades.listTrades({ owner, rows, config }).filter((t) => t.status === "holding");
  const index = new Map(rows.map((r) => [r.marketHashName, r]));

  // Наши лоты CSFloat раздаём позициям: сначала по asset_id, потом по названию.
  const listed = autoListedByName();
  const take = (t) => {
    const list = listed.get(t.marketHashName);
    if (!list?.length) return null;
    let i = t.assetId ? list.findIndex((l) => l.assetId === String(t.assetId)) : -1;
    if (i < 0) i = 0;
    return list.splice(i, 1)[0];
  };

  const free = all
    .filter((t) => !t.isLocked)
    .sort((a, b) => (a.assetId ? 0 : 1) - (b.assetId ? 0 : 1))
    .map((t) => ({ trade: t, advice: adviseTrade(t, index.get(t.marketHashName), config, cfg, take(t)) }));
  const locked = all.filter((t) => t.isLocked).sort((a, b) => Date.parse(a.unlockAt) - Date.parse(b.unlockAt));
  return { free, locked, cfg };
}

function itemBlock({ trade: t, advice }) {
  return `<b>${escapeHtml(t.marketHashName)}</b> <code>${shortId(t)}</code> (куплено за ${money(t.buyPrice)})\n${escapeHtml(advice.text)}`;
}

function chunks(blocks, header) {
  const out = [];
  let cur = header;
  for (const b of blocks) {
    if (cur.length + b.length + 2 > 3800) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + b;
  }
  if (cur) out.push(cur);
  return out;
}

function helpText() {
  return [
    "📦 <b>Где продать мой инвентарь</b>",
    "",
    "Смотрю My Trades: всё, что вышло из трейд-бана, и подсказываю, где и почём продать. Если предмет уже выставлен на CSFloat автоматически — говорю, по какой цене и почему.",
    "Новое и изменившееся присылаю сам раз в полчаса.",
    "",
    "/list — все свободные предметы с советом + когда разбан у остальных",
    "/csmoney abc123 — пометить, что предмет брали под выкуп CS.Money (повторно — снять)",
  ].join("\n");
}

function startTelegramSellBot(getRows, config) {
  const token = process.env.TELEGRAM_SELL_BOT_TOKEN;
  if (!token) {
    console.log(`[${TAG}] TELEGRAM_SELL_BOT_TOKEN не задан — бот продаж не запущен.`);
    return;
  }
  const owner = ownerChatId(process.env.TELEGRAM_SELL_CHAT_ID);
  if (!owner) {
    console.log(`[${TAG}] нет чата владельца (TELEGRAM_CHAT_ID) — бот продаж не запущен.`);
    return;
  }
  const tradesOwner = config.sellAdvisor?.owner || process.env.TRADES_OWNER || "lxnmnk";

  async function sendList(chatId) {
    const rows = getRows();
    if (!rows.length) return sendMessage(token, chatId, "Цены ещё не загрузились — попробуй через минуту.");
    const { free, locked } = buildAdvice(rows, config);
    const act = free.filter((x) => x.advice.venue !== "hold");
    const hold = free.filter((x) => x.advice.venue === "hold");
    const blocks = [
      ...act.map(itemBlock),
      ...(hold.length ? [`⏸ <b>Держать (${hold.length})</b>\n` + hold.map((x) => `• ${escapeHtml(x.trade.marketHashName)} <code>${shortId(x.trade)}</code> — ${escapeHtml(x.advice.text)}`).join("\n")] : []),
      ...(locked.length ? [`🔒 <b>В трейд-бане (${locked.length})</b>\n` + locked.map((t) => `• ${escapeHtml(t.marketHashName)} — с ${when(t.unlockAt)}`).join("\n")] : []),
    ];
    const header = `📦 <b>Свободно: ${free.length}, продать сейчас: ${act.length}</b>`;
    for (const text of chunks(blocks, header)) await sendMessage(token, chatId, text);
  }

  // Что изменилось с прошлой проверки — то и присылаем.
  async function check() {
    const rows = getRows();
    if (!rows.length) return;
    const { free, cfg } = buildAdvice(rows, config);
    const state = loadJson(STATE_FILE, { advised: {} });
    const seen = new Set();
    const changed = [];
    for (const x of free) {
      seen.add(x.trade.id);
      const prev = state.advised[x.trade.id];
      const { venue, price } = x.advice;
      if (venue === "hold") {
        state.advised[x.trade.id] = { venue, at: new Date().toISOString() };
        continue;
      }
      const moved = prev?.price && price && Math.abs(price - prev.price) / prev.price >= cfg.repriceNotifyPercent / 100;
      if (!prev || prev.venue !== venue || moved) changed.push(x);
      if (!prev || prev.venue !== venue || moved) state.advised[x.trade.id] = { venue, price: price ?? null, at: new Date().toISOString() };
    }
    // Проданные/удалённые — забываем.
    for (const id of Object.keys(state.advised)) if (!seen.has(id)) delete state.advised[id];

    if (changed.length) {
      const header = `📦 <b>Пора продавать: ${changed.length}</b>`;
      try {
        for (const text of chunks(changed.map(itemBlock), header)) await sendMessage(token, owner, text);
      } catch (err) {
        // Не сохраняем состояние — пришлём в следующий раз.
        console.error(`[${TAG}] не отправил советы: ${err.message}`);
        return;
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const parsed = parseCommand(msg.text);
    if (!parsed) return;
    if (String(chatId) !== owner) {
      await sendMessage(token, chatId, "Этот бот — только для владельца инвентаря.");
      return;
    }
    const { cmd, args } = parsed;
    if (cmd === "/start" || cmd === "/help") return sendMessage(token, chatId, helpText());
    if (cmd === "/list") return sendList(chatId);
    if (cmd === "/csmoney") {
      const prefix = String(args[0] || "").toLowerCase();
      if (prefix.length < 4) return sendMessage(token, chatId, "Формат: /csmoney abc123 — id из /list");
      const found = trades.listRawTrades(tradesOwner).filter((t) => t.status === "holding" && t.id.startsWith(prefix));
      if (found.length !== 1) return sendMessage(token, chatId, found.length ? "Под этот id подходит несколько предметов — дай длиннее." : "Не нашёл такой предмет среди непроданных.");
      const t = trades.setSellTarget(found[0].id, tradesOwner, found[0].sellTarget === "csmoney" ? null : "csmoney");
      return sendMessage(token, chatId, `${escapeHtml(t.marketHashName)}: ${t.sellTarget === "csmoney" ? "брали под CS.Money ✅" : "пометка CS.Money снята"}`);
    }
    return sendMessage(token, chatId, "Неизвестная команда. /help — список команд.");
  }

  startPolling(token, TAG, { onMessage });
  const intervalMs = settings(config).intervalMinutes * 60 * 1000;
  // Первая проверка — когда цены уже точно загружены.
  setTimeout(() => check().catch((e) => console.error(`[${TAG}] check:`, e.message)), 2 * 60 * 1000);
  setInterval(() => check().catch((e) => console.error(`[${TAG}] check:`, e.message)), intervalMs);
  console.log(`[${TAG}] Запущен.`);
}

module.exports = { startTelegramSellBot, adviseTrade, buildAdvice };
