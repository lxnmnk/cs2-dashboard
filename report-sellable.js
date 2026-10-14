// Отчёт "что сейчас выгодно сдать": по каждой позиции, которая уже вышла из
// трейд-бана, показывает четыре варианта выхода — Skinbux, бид Youpin, бид
// CSFloat и выставление лотом на CSFloat — в деньгах после комиссии и в
// процентах от того, что за предмет заплачено.
//
// Зачем отдельным скриптом, а не вкладкой в панели: это разовый вопрос
// "разгрузить склад сегодня", и запускать его хочется и на сервере, где
// лежит настоящий trades.json, и локально — без поднятого сайта.
//
// Цены берём теми же модулями, что и сайт (sources/*, pricingEngine), чтобы
// числа совпадали с тем, что видно в My Trades, а не считались по-своему.
//
// Запуск:  node report-sellable.js [owner]      (по умолчанию lxnmnk)
//          TRADES_FILE=./trades-server.json node report-sellable.js
//
// TRADES_FILE нужен, когда смотришь не свой файл, а скачанный с сервера:
// подменять им локальный trades.json не надо. В шапке отчёта печатается,
// какой файл прочитан и когда была последняя покупка, — чтобы отчёт по
// позавчерашней копии не выдавался за сегодняшний склад.
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { fetchCs2ShLatest } = require("./sources/cs2sh");
const { fetchSkinbuxLatest } = require("./sources/skinbux");
const { buildRows } = require("./pricingEngine");
const trades = require("./trades");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const owner = process.argv[2] || "lxnmnk";

// Youpin отдаёт сразу только часть денег, остальное виснет в frozen balance
// (см. config.sources.youpin.instantPercent). Для решения "сдавать или нет"
// честнее сравнивать по тому, что реально придёт на руки.
const YOUPIN_INSTANT = (config.sources.youpin.instantPercent ?? 100) / 100;

// Сколько останется на руках после комиссии площадки за продажу. Ставки
// берём из config.sources, а не вписываем числом: поменяется комиссия —
// поменяется и отчёт, без правок здесь.
function afterFee(source, gross) {
  if (gross == null) return null;
  return gross * (1 - (config.sources[source].sellFee ?? 0));
}

function money(n) {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

// Цена и сколько это от закупки: "+5.9%" читается быстрее, чем отдельная
// колонка с процентами, которую глазами ещё надо сопоставить со строкой.
function cell(net, buyPrice) {
  if (net == null) return "—";
  if (!(buyPrice > 0)) return money(net);
  const pct = ((net - buyPrice) / buyPrice) * 100;
  return `${money(net)} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function pad(s, width, right = false) {
  s = String(s);
  // Эмодзи и ★ занимают не одну ячейку, но для сверки глазами этого хватает.
  if (s.length > width) s = s.slice(0, width - 1) + "…";
  return right ? s.padStart(width) : s.padEnd(width);
}

(async () => {
  const [cs2shItems, skinbuxMap] = await Promise.all([
    fetchCs2ShLatest(process.env.CS2SH_API_KEY),
    fetchSkinbuxLatest(process.env.SKINBUX_API_KEY),
  ]);
  // cs.money в этом отчёте не участвует: сдаём мы на Skinbux или в бид Youpin.
  const rows = buildRows(cs2shItems, new Map(), skinbuxMap, config);

  const tradesFile = path.resolve(process.env.TRADES_FILE || path.join(__dirname, "trades.json"));
  const all = trades.listTrades({ owner, rows, config });
  const holding = all.filter((t) => t.status === "holding");
  const locked = holding.filter((t) => t.isLocked);
  const free = holding.filter((t) => !t.isLocked);

  const report = free.map((t) => {
    const prices = rows.find((r) => r.marketHashName === t.marketHashName)?.prices || {};

    // Skinbux: выкуп без комиссии, деньги через 7 дней.
    const skinbux = afterFee("skinbux", prices.skinbux?.bid ?? null);
    // Youpin: бид без комиссии, но сразу отдают только instantPercent.
    const youpinGross = afterFee("youpin", prices.youpin?.bid ?? null);
    const youpin = youpinGross == null ? null : youpinGross * YOUPIN_INSTANT;
    // CSFloat: и продажа в чужой buy order, и свой лот — с их комиссией.
    const csfloatBid = afterFee("csfloat", prices.csfloat?.bid ?? null);
    const csfloatAsk = afterFee("csfloat", prices.csfloat?.ask ?? null);

    // "Лучшее" выбираем только среди мгновенных выходов: лот на CSFloat —
    // это ожидание покупателя, сравнивать его с выкупом напрямую нечестно.
    const best = [
      { where: "skinbux", net: skinbux },
      { where: "youpin bid", net: youpin },
      { where: "csfloat bid", net: csfloatBid },
    ]
      .filter((o) => o.net != null)
      .sort((a, b) => b.net - a.net)[0] || null;

    return {
      name: t.marketHashName,
      buyPrice: t.buyPrice,
      buyDate: t.buyDate,
      skinbux,
      youpin,
      csfloatBid,
      csfloatAsk,
      best,
      profit: best ? best.net - t.buyPrice : null,
      profitPct: best && t.buyPrice > 0 ? ((best.net - t.buyPrice) / t.buyPrice) * 100 : null,
    };
  });

  // По умолчанию сортируем по проценту, а не по долларам: сотня прибыли на
  // ноже за три тысячи и сотня на ноже за триста — разные сделки, и в
  // долларовом списке первая стоит выше, хотя интересна вторая.
  // SORT=usd возвращает старый порядок, когда нужно разгрузить склад на
  // конкретную сумму.
  const sortBy = process.env.SORT === "usd" ? "profit" : "profitPct";
  report.sort((a, b) => (b[sortBy] ?? -Infinity) - (a[sortBy] ?? -Infinity));

  const W = [38, 9, 18, 18, 18, 18];
  const lastBuy = all.reduce((max, t) => (!max || t.buyDate > max ? t.buyDate : max), null);
  const csfloatFeePct = Math.round((config.sources.csfloat.sellFee ?? 0) * 100);
  console.log(`Файл: ${tradesFile} · сделок: ${all.length} · последняя покупка: ${lastBuy ? new Date(lastBuy).toLocaleString("ru-RU") : "нет"}`);
  console.log(`Владелец: ${owner} · свободных позиций: ${free.length} · в трейд-бане: ${locked.length}`);
  console.log(`Цены на ${new Date().toLocaleString("ru-RU")}; проценты — от цены покупки, * — лучший мгновенный выход`);
  console.log(`Сортировка: ${sortBy === "profit" ? "по деньгам" : "по проценту (SORT=usd — по деньгам)"}`);
  console.log(`Youpin по ${Math.round(YOUPIN_INSTANT * 100)}% (остальное во frozen), CSFloat за вычетом ${csfloatFeePct}% комиссии
`);
  console.log(
    pad("Предмет", W[0]) + pad("куплен", W[1], true) + pad("skinbux", W[2], true) +
    pad("youpin бид", W[3], true) + pad("csfloat бид", W[4], true) + pad("csfloat лотом", W[5], true)
  );
  console.log("-".repeat(W.reduce((a, b) => a + b, 0)));

  for (const r of report) {
    const mark = (where, text) => (r.best?.where === where && text !== "—" ? text + " *" : text);
    console.log(
      pad(r.name, W[0]) +
      pad(money(r.buyPrice), W[1], true) +
      pad(mark("skinbux", cell(r.skinbux, r.buyPrice)), W[2], true) +
      pad(mark("youpin bid", cell(r.youpin, r.buyPrice)), W[3], true) +
      pad(mark("csfloat bid", cell(r.csfloatBid, r.buyPrice)), W[4], true) +
      pad(cell(r.csfloatAsk, r.buyPrice), W[5], true)
    );
  }

  const profitable = report.filter((r) => r.profit != null && r.profit > 0);
  const sumBuy = report.reduce((s, r) => s + r.buyPrice, 0);
  const sumBest = report.reduce((s, r) => s + (r.best?.net ?? 0), 0);
  console.log("\nИтого по свободным позициям:");
  console.log(`  вложено:        ${money(sumBuy)}`);
  const diff = sumBest - sumBuy;
  const diffPct = sumBuy > 0 ? (diff / sumBuy) * 100 : 0;
  console.log(`  дадут сейчас:   ${money(sumBest)}  (${diff >= 0 ? "+" : ""}${diff.toFixed(2)} · ${diff >= 0 ? "+" : ""}${diffPct.toFixed(1)}%)`);
  console.log(`  в плюс:         ${profitable.length} из ${report.length}` +
    (profitable.length ? ` — на ${money(profitable.reduce((s, r) => s + r.profit, 0))}` : ""));

  if (locked.length) {
    const sum = locked.reduce((s, t) => s + t.buyPrice, 0);
    console.log(`\nВ трейд-бане (в отчёт не вошли): ${locked.length} шт на ${money(sum)}`);
  }
})().catch((err) => {
  console.error("Не получилось:", err.message);
  process.exit(1);
});
