// csf_bargains — отдельный бот автобаргов CSFloat (TELEGRAM_BARGAIN_BOT_TOKEN).
//
// Раньше барги жили внутри бота арбитража (/bargain ...), и их сообщения
// тонули среди лотов для ручной покупки. Теперь здесь всё про барги: команды
// управления и уведомления (отправил барг, купил, контр-оффер, принял,
// отменил, ошибки). Логика самих баргов — csfloatAutoBargain.js.
//
// Лоты CSFloat берутся из live-опроса бота арбитража (telegramArbBot.js
// liveHooks) — второй такой же опрос только тратил бы лимит CSFloat.
//
// Деньги одного CSFloat-аккаунта: команды принимаем только из чата владельца.
const { applyDisplayFilters } = require("./pricingEngine");
const { createBargainer, ruleLabel } = require("./csfloatAutoBargain");
const { sendMessage, escapeHtml, ownerChatId, startPolling, parseCommand } = require("./telegramBot");
const arbBot = require("./telegramArbBot");

const TAG = "telegram-bargain-bot";

const FILTER_KEYS = [
  "excludeStatTrak",
  "excludeSouvenir",
  "excludeStickers",
  "minPrice",
  "maxPrice",
  "maxCsfloatSpreadPercent",
  "maxYoupinSpreadPercent",
  "maxBuffSpreadPercent",
  "phase",
];

function helpText() {
  return [
    "🤝 <b>csf_bargains — автобарги CSFloat</b>",
    "",
    "Смотрю новые лоты CSFloat каждые 30 с. Если лот выгоден со скидкой — шлю барг, если выгоден по полной цене — покупаю. На контр-оффер продавца отвечаю сам: принимаю до потолка правила или отвечаю контром по потолку.",
    "",
    "/status — состояние, правила, висящие барги",
    "/on — включить   /test — включить без отправки   /off — выключить",
    "/buy on|off — покупать сразу, если лот выгоден по полной цене",
    "/counters on|off — отвечать на контр-офферы",
    "/reserve 1000 — сколько $ всегда оставлять на балансе",
    "/ttl 30 — через сколько минут отменять барг без ответа (не меньше 30)",
    "/discount 10 — скидка, если лот её не сообщает",
    "/rules — правила покупки (номера, проценты)",
    "/rule 2 off | /rule 2 on — выключить / включить правило",
    "/rule 2 8 10 — поменять проценты правила (подробно в /rules)",
    "/rule reset — правила снова из config.json",
    "/filters — фильтры лотов",
    "/minprice 100 | off, /maxprice 1000 | off",
    "/toggle stattrak|souvenir|stickers",
    "/spread csfloat|youpin|buff 15 | off",
  ].join("\n");
}

function filtersText(f) {
  return [
    "🔎 <b>Фильтры баргов</b>",
    `Цена лота: ${f.minPrice ?? "—"} .. ${f.maxPrice ?? "—"}`,
    `Исключить StatTrak / Souvenir / наклейки: ${f.excludeStatTrak ? "да" : "нет"} / ${f.excludeSouvenir ? "да" : "нет"} / ${f.excludeStickers ? "да" : "нет"}`,
    `Спред CSFloat/Youpin/Buff: ${f.maxCsfloatSpreadPercent ?? "—"} / ${f.maxYoupinSpreadPercent ?? "—"} / ${f.maxBuffSpreadPercent ?? "—"}`,
    `Фаза: ${escapeHtml(f.phase ?? "любая")}`,
  ].join("\n");
}

function rulesText(rules, fromBot) {
  const lines = [`📐 <b>Правила покупки</b>${fromBot ? " (изменены в боте)" : " (из config.json)"}`, ""];
  rules.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.disabled ? "⛔ выкл" : "✅"} ${escapeHtml(ruleLabel(r))}`);
  });
  lines.push(
    "",
    "Барг шлётся по правилу, которое даёт самую высокую цену; выключенные не участвуют. Те же правила решают, покупать ли сразу по полной цене (/buy).",
    "",
    "Изменить проценты: /rule N МИН [СТАРТ]",
    "• правило «% под площадку»: МИН — ниже какого профита не торгуемся, СТАРТ — с какого профита первый барг (не меньше МИН).",
    "  /rule 2 8 10 → начинаем с 10%, на контр-оффер торгуемся до 8%",
    "• правило «ask −%»: МИН — самая большая скидка от ask, до которой покупаем (потолок цены), СТАРТ — с какой скидки первый барг (не меньше МИН).",
    "  /rule 3 7 9 → первый барг ask −9%, потолок ask −7%",
    "Без СТАРТ — первый барг сразу по потолку.",
    "/rule N off | on, /rule reset — вернуть config.json"
  );
  return lines.join("\n");
}

/**
 * Команда /rule над копией правил. Возвращает { rules } (новые правила) или
 * { reset: true }, или { error } — текст для ответа.
 */
function applyRuleCommand(rules, args) {
  const [a, b, c] = args;
  if (a === "reset") return { reset: true };
  const idx = parseInt(a, 10) - 1;
  if (!(idx >= 0 && idx < rules.length)) return { error: `Нет правила ${a ?? ""}. Номера: 1–${rules.length}, см. /rules` };
  const next = rules.map((r) => ({ ...r }));
  const rule = next[idx];
  if (b === "off" || b === "on") {
    if (b === "off") rule.disabled = true;
    else delete rule.disabled;
    return { rules: next };
  }
  const min = parseFloat(b);
  const open = c == null ? null : parseFloat(c);
  if (!Number.isFinite(min) || min < 0 || min >= 100) return { error: "Формат: /rule N МИН [СТАРТ], проценты от 0 до 100. Подробно — /rules" };
  if (open != null && !(Number.isFinite(open) && open >= min && open < 100)) {
    return { error: `СТАРТ должен быть не меньше МИН (${min}) и меньше 100` };
  }
  if (rule.fromAsk) {
    rule.discountPercent = min;
    if (open != null && open !== min) rule.openDiscountPercent = open;
    else delete rule.openDiscountPercent;
  } else {
    rule.minProfitPercent = min;
    if (open != null && open !== min) rule.openProfitPercent = open;
    else delete rule.openProfitPercent;
  }
  return { rules: next };
}

/**
 * @param {() => Array} getRows
 * @param {Object} config
 * @returns {Object|null} liveHooks для startTelegramArbBot, или null, если бот не запущен
 */
function startTelegramBargainBot(getRows, config) {
  const token = process.env.TELEGRAM_BARGAIN_BOT_TOKEN;
  if (!token) {
    console.log(`[${TAG}] TELEGRAM_BARGAIN_BOT_TOKEN не задан — автобарги не запущены.`);
    return null;
  }
  const owner = ownerChatId(config.csfloatAutoBargain?.ownerChatId || process.env.TELEGRAM_BARGAIN_CHAT_ID);
  if (!owner) {
    console.log(`[${TAG}] нет чата владельца (TELEGRAM_CHAT_ID) — автобарги не запущены.`);
    return null;
  }

  const notify = (text) => sendMessage(token, owner, text);
  const bargainer = createBargainer({ config, notify, getRows });

  // Фильтры баргов. Раньше брались из фильтров владельца в боте арбитража —
  // при первом запуске переносим их оттуда, дальше они свои.
  function filters() {
    let f = bargainer.settings().filters;
    if (!f) {
      const sub = arbBot.findSub(arbBot.loadSubscribers(), Number(owner)) || {};
      f = Object.fromEntries(FILTER_KEYS.map((k) => [k, sub[k] ?? (k.startsWith("exclude") ? false : null)]));
      bargainer.setSetting("filters", f);
    }
    return f;
  }
  const setFilter = (key, value) => bargainer.setSetting("filters", { ...filters(), [key]: value });

  /**
   * Кандидаты в барг: лоты, не выгодные по полной цене, но выгодные по цене в
   * пределах скидки продавца (правила — в csfloatAutoBargain.js).
   * Мин./макс. цена сравнивается с ценой лота, а не с ценой из таблицы.
   */
  function onListings(listings, index) {
    const { minPrice, maxPrice, ...rest } = filters();
    const display = { ...rest, minPrice: null, maxPrice: null };
    const out = [];
    for (const listing of listings) {
      const row = index.get(listing.rowKey);
      if (!row) continue;
      if (minPrice != null && listing.price < minPrice) continue;
      if (maxPrice != null && listing.price > maxPrice) continue;
      if (!applyDisplayFilters([row], display).length) continue;
      const bp = bargainer.bargainPrice(listing, row);
      if (bp) out.push({ listing, row, ...bp });
    }
    bargainer.consider(out);
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const parsed = parseCommand(msg.text);
    if (!parsed) return;
    if (String(chatId) !== owner) {
      await sendMessage(token, chatId, "Этот бот управляет деньгами одного аккаунта CSFloat — команды только от владельца.");
      return;
    }
    const { cmd, args } = parsed;
    const [a, b] = args;
    const n = parseFloat(a);
    const reply = (text) => sendMessage(token, chatId, text);

    switch (cmd) {
      case "/start":
      case "/help":
        return reply(helpText());
      case "/status":
        return reply(bargainer.statusText() + "\n\n" + filtersText(filters()));
      case "/on":
        bargainer.setSetting("enabled", true);
        bargainer.setSetting("dryRun", false);
        return reply(bargainer.statusText());
      case "/test":
        bargainer.setSetting("enabled", true);
        bargainer.setSetting("dryRun", true);
        return reply(bargainer.statusText());
      case "/off":
        bargainer.setSetting("enabled", false);
        return reply(bargainer.statusText());
      case "/buy":
      case "/counters":
        if (a !== "on" && a !== "off") return reply(`Формат: ${cmd} on|off`);
        bargainer.setSetting(cmd === "/buy" ? "autoBuy" : "answerCounters", a === "on");
        return reply(bargainer.statusText());
      case "/reserve":
        if (!(n >= 0)) return reply("Формат: /reserve 1000");
        bargainer.setSetting("reserveUsd", n);
        return reply(bargainer.statusText());
      case "/ttl":
        if (!(n >= 30)) return reply("Формат: /ttl 30 (не меньше 30 мин: раньше CSFloat барг не отменит)");
        bargainer.setSetting("ttlMinutes", n);
        return reply(bargainer.statusText());
      case "/discount":
        if (!(n > 0 && n < 100)) return reply("Формат: /discount 10");
        bargainer.setSetting("assumedMaxDiscountPercent", n);
        return reply(bargainer.statusText());
      case "/rules":
        return reply(rulesText(bargainer.settings().rules, bargainer.isOverridden("rules")));
      case "/rule": {
        const res = applyRuleCommand(bargainer.settings().rules, args);
        if (res.error) return reply(res.error);
        if (res.reset) bargainer.resetSetting("rules");
        else bargainer.setSetting("rules", res.rules);
        return reply(rulesText(bargainer.settings().rules, bargainer.isOverridden("rules")));
      }
      case "/filters":
        return reply(filtersText(filters()));
      case "/minprice":
      case "/maxprice":
        setFilter(cmd === "/minprice" ? "minPrice" : "maxPrice", !a || a === "off" ? null : parseFloat(a));
        return reply(filtersText(filters()));
      case "/toggle": {
        const key = { stattrak: "excludeStatTrak", souvenir: "excludeSouvenir", stickers: "excludeStickers" }[a];
        if (!key) return reply("Формат: /toggle stattrak|souvenir|stickers");
        setFilter(key, !filters()[key]);
        return reply(filtersText(filters()));
      }
      case "/spread": {
        const key = { csfloat: "maxCsfloatSpreadPercent", youpin: "maxYoupinSpreadPercent", buff: "maxBuffSpreadPercent" }[a];
        if (!key) return reply("Формат: /spread csfloat|youpin|buff 15  (или off)");
        setFilter(key, !b || b === "off" ? null : parseFloat(b));
        return reply(filtersText(filters()));
      }
      default:
        return reply("Неизвестная команда. /help — список команд.");
    }
  }

  bargainer.start();
  startPolling(token, TAG, { onMessage });
  console.log(`[${TAG}] Запущен.`);

  return {
    wants: () => !!bargainer.settings().enabled,
    minPrice: () => filters().minPrice ?? null,
    onListings,
  };
}

module.exports = { startTelegramBargainBot, applyRuleCommand, rulesText };
