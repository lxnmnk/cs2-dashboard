// Отчёт "что сейчас выгодно сдать в выкуп": по каждой позиции, которая уже
// вышла из трейд-бана, показывает, сколько за неё дают Skinbux и бид Youpin,
// и что из этого выше цены покупки.
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

function money(n) {
  return n == null ? "—" : `$${n.toFixed(2)}`;
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
    const row = rows.find((r) => r.marketHashName === t.marketHashName);
    const skinbux = row?.prices?.skinbux?.bid ?? null;
    const youpinBid = row?.prices?.youpin?.bid ?? null;
    const youpinNet = youpinBid == null ? null : youpinBid * YOUPIN_INSTANT;
    const best = [
      { where: "skinbux", net: skinbux },
      { where: "youpin bid", net: youpinNet },
    ]
      .filter((o) => o.net != null)
      .sort((a, b) => b.net - a.net)[0] || null;

    return {
      name: t.marketHashName,
      buyPrice: t.buyPrice,
      buyDate: t.buyDate,
      skinbux,
      youpinBid,
      youpinNet,
      best,
      profit: best ? best.net - t.buyPrice : null,
      profitPct: best && t.buyPrice > 0 ? ((best.net - t.buyPrice) / t.buyPrice) * 100 : null,
    };
  });

  report.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));

  const W = [46, 10, 10, 11, 11, 12, 9];
  const lastBuy = all.reduce((max, t) => (!max || t.buyDate > max ? t.buyDate : max), null);
  console.log(`Файл: ${tradesFile} · сделок: ${all.length} · последняя покупка: ${lastBuy ? new Date(lastBuy).toLocaleString("ru-RU") : "нет"}`);
  console.log(`Владелец: ${owner} · свободных позиций: ${free.length} · в трейд-бане: ${locked.length}`);
  console.log(`Цены на ${new Date().toLocaleString("ru-RU")}; Youpin считаем по ${Math.round(YOUPIN_INSTANT * 100)}% (остальное во frozen)\n`);
  console.log(
    pad("Предмет", W[0]) + pad("куплен", W[1], true) + pad("skinbux", W[2], true) +
    pad("youpin", W[3], true) + pad("youpin×", W[4], true) + pad("лучшее", W[5], true) + pad("разница", W[6], true)
  );
  console.log("-".repeat(W.reduce((a, b) => a + b, 0)));

  for (const r of report) {
    console.log(
      pad(r.name, W[0]) +
      pad(money(r.buyPrice), W[1], true) +
      pad(money(r.skinbux), W[2], true) +
      pad(money(r.youpinBid), W[3], true) +
      pad(money(r.youpinNet), W[4], true) +
      pad(r.best ? `${money(r.best.net)}` : "нет цен", W[5], true) +
      pad(r.profit == null ? "—" : `${r.profit >= 0 ? "+" : ""}${r.profit.toFixed(2)}`, W[6], true) +
      (r.best ? `  ${r.best.where}` : "")
    );
  }

  const profitable = report.filter((r) => r.profit != null && r.profit > 0);
  const sumBuy = report.reduce((s, r) => s + r.buyPrice, 0);
  const sumBest = report.reduce((s, r) => s + (r.best?.net ?? 0), 0);
  console.log("\nИтого по свободным позициям:");
  console.log(`  вложено:        ${money(sumBuy)}`);
  console.log(`  дадут сейчас:   ${money(sumBest)}  (${sumBest - sumBuy >= 0 ? "+" : ""}${(sumBest - sumBuy).toFixed(2)})`);
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
