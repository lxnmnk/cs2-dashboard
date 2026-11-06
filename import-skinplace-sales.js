// Импорт продаж на skin.place в трекер сделок.
//
// API продаж у skin.place нет — список снят с их таблицы выгрузки руками.
// Float там не показан, поэтому сопоставляем по названию. Если у продажи
// вписан float (из сверки с инвентарём: "its float is gone from the
// inventory") — закрываем ровно позицию с этим float. Иначе, если одинаковых
// открытых позиций несколько, берём самую старую из уже разблокированных
// (продать можно только её) и пишем об этом, чтобы проверить глазами.
// Фазу доплера skin.place не показывает — позиция "... - Ruby" подходит к
// продаже без фазы.
//
// Скрипт ничего не пишет без --apply: сначала показывает, что и с чем
// сопоставилось, и только потом закрывает позиции.
//
// Запуск (на сервере, там лежит настоящий trades.json):
//   node import-skinplace-sales.js            // показать, не менять
//   node import-skinplace-sales.js --apply    // записать
//
// skin.place платит сразу и без комиссии: холд 0 дней, цена = выплата.
const trades = require("./trades");
const config = require("./config.json");
const { stripPhaseSuffix } = require("./itemName");
const { sameFloat } = require("./tradeFloats");

const OWNER = process.env.TRADES_OWNER || "lxnmnk";
const SOURCE = "skinplace";
const LOCK_DAYS = config.portfolio?.tradeLockDays ?? 7;

// Время — как в их таблице (по Киеву), берём время завершения.
// order — номер заявки на skin.place: по нему и названию повторный запуск
// видит, что продажа уже записана.
const SALES = [
  { order: 14937225, name: "★ Talon Knife | Night Stripe (Well-Worn)", usd: 215.09, soldAt: "2026-10-22T11:02:00+03:00" },
  { order: 14937212, name: "★ M9 Bayonet | Autotronic (Well-Worn)", usd: 523.87, soldAt: "2026-10-22T11:01:00+03:00" },
  { order: 14937212, name: "★ Stiletto Knife | Boreal Forest (Field-Tested)", usd: 110.26, soldAt: "2026-10-22T11:01:00+03:00" },
  { order: 14937212, name: "★ Bayonet | Scorched (Field-Tested)", usd: 109.11, soldAt: "2026-10-22T11:01:00+03:00" },
  { order: 14937212, name: "★ Flip Knife | Stained (Minimal Wear)", usd: 116.19, soldAt: "2026-10-22T11:01:00+03:00" },
  { order: 14937212, name: "★ Stiletto Knife | Forest DDPAT (Field-Tested)", usd: 109.39, soldAt: "2026-10-22T11:01:00+03:00" },
  { order: 14937212, name: "★ Karambit | Case Hardened (Well-Worn)", usd: 584.54, soldAt: "2026-10-22T11:01:00+03:00" },

  // Вторая партия. С 25.10 Киев на зимнем времени (+02:00).
  { order: 15158431, name: "★ Bowie Knife | Gamma Doppler (Minimal Wear)", usd: 202.15, soldAt: "2026-11-01T16:41:00+02:00" },
  { order: 15053173, name: "★ StatTrak™ Butterfly Knife | Doppler (Factory New)", usd: 2611.91, soldAt: "2026-10-28T11:38:00+02:00" },
  { order: 14983423, name: "★ Talon Knife | Night Stripe (Well-Worn)", usd: 215.29, soldAt: "2026-10-24T15:28:00+03:00" },
  { order: 14960141, name: "AWP | Neo-Noir (Factory New)", usd: 44.08, soldAt: "2026-10-23T12:32:00+03:00", float: 0.068293 },
  { order: 14960141, name: "★ Classic Knife | Scorched (Field-Tested)", usd: 63.95, soldAt: "2026-10-23T12:32:00+03:00" },
  { order: 14960141, name: "★ Paracord Knife | Damascus Steel (Minimal Wear)", usd: 51.94, soldAt: "2026-10-23T12:32:00+03:00" },
  { order: 14960141, name: "★ Huntsman Knife | Black Laminate (Factory New)", usd: 100.27, soldAt: "2026-10-23T12:32:00+03:00", float: 0.059062, n: 1 },
  { order: 14960141, name: "★ Flip Knife | Urban Masked (Field-Tested)", usd: 102.61, soldAt: "2026-10-23T12:32:00+03:00", float: 0.292948 },
  { order: 14960141, name: "★ Huntsman Knife | Ultraviolet (Battle-Scarred)", usd: 50.44, soldAt: "2026-10-23T12:32:00+03:00", float: 0.647762 },
  { order: 14960141, name: "★ Huntsman Knife | Black Laminate (Factory New)", usd: 100.27, soldAt: "2026-10-23T12:32:00+03:00", float: 0.052576, n: 2 },
  { order: 14960141, name: "★ Classic Knife | Stained (Minimal Wear)", usd: 89.33, soldAt: "2026-10-23T12:32:00+03:00", float: 0.101987 },
  { order: 14960141, name: "★ Flip Knife | Urban Masked (Battle-Scarred)", usd: 99.97, soldAt: "2026-10-23T12:32:00+03:00", float: 0.721027 },
];

const apply = process.argv.includes("--apply");
// n — номер среди одинаковых предметов одной заявки (два Huntsman в 14960141):
// без него второй считался бы уже записанным.
const externalId = (sale) => `skinplace:${sale.order}:${sale.name}${sale.n ? `#${sale.n}` : ""}`;

const all = trades.listRawTrades(OWNER);
const holdings = all.filter((t) => t.status === "holding");
const doneIds = new Set(all.filter((t) => t.status === "sold").map((t) => t.sellExternalId).filter(Boolean));

function unlockAt(t) {
  if (t.customUnlockAt) return new Date(t.customUnlockAt);
  return new Date(new Date(t.buyDate).getTime() + LOCK_DAYS * 24 * 60 * 60 * 1000);
}

const matched = [];
const unmatched = [];
const already = [];
const taken = new Set();

for (const sale of SALES) {
  if (doneIds.has(externalId(sale))) {
    already.push(sale);
    continue;
  }
  const soldAt = new Date(sale.soldAt);
  const sameName = (t) => t.marketHashName === sale.name || stripPhaseSuffix(t.marketHashName).base === sale.name;
  const byFloat = sale.float != null && holdings.find((t) => sameName(t) && !taken.has(t.id) && sameFloat(t.floatValue, sale.float));
  if (byFloat) {
    taken.add(byFloat.id);
    matched.push({ sale, trade: byFloat, of: 1, locked: unlockAt(byFloat) > soldAt, exact: true });
    continue;
  }
  const hits = holdings
    .filter((t) => sameName(t) && !taken.has(t.id))
    // Продать могли только то, что было разблокировано к моменту продажи:
    // такие вперёд, среди них — самая старая покупка.
    .sort((a, b) => (unlockAt(b) <= soldAt) - (unlockAt(a) <= soldAt) || new Date(a.buyDate) - new Date(b.buyDate));
  if (!hits.length) {
    unmatched.push(sale);
    continue;
  }
  taken.add(hits[0].id);
  matched.push({ sale, trade: hits[0], of: hits.length, locked: unlockAt(hits[0]) > soldAt });
}

const money = (n) => `$${n.toFixed(2)}`;

console.log(`Владелец: ${OWNER} · открытых позиций: ${holdings.length} · продаж в списке: ${SALES.length}`);
console.log(`skin.place: комиссия 0%, холд 0 дней · режим: ${apply ? "ЗАПИСЫВАЮ" : "вхолостую"}\n`);

if (matched.length) {
  console.log(`Сопоставлено: ${matched.length}`);
  let bought = 0;
  let sold = 0;
  for (const { sale, trade, of, locked, exact } of matched) {
    const buy = Number(trade.buyPrice) || 0;
    bought += buy;
    sold += sale.usd;
    const profit = sale.usd - buy;
    const float = trade.floatValue != null ? ` float ${Number(trade.floatValue).toFixed(4)}` : "";
    const note = [
      exact ? "точно по float" : null,
      trade.marketHashName !== sale.name ? `в трекере: ${trade.marketHashName}` : null,
      of > 1 ? `выбрана самая старая из ${of} одинаковых (id ${trade.id.slice(0, 8)})` : null,
      locked ? "⚠ по трекеру ещё в трейд-бане" : null,
    ].filter(Boolean);
    console.log(
      `  ${sale.name.slice(0, 46).padEnd(47)} куплен ${money(buy).padStart(9)} → ${money(sale.usd).padStart(9)}` +
        `  ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}${float}${note.length ? `\n      ${note.join(" · ")}` : ""}`
    );
  }
  console.log(`  ИТОГО: вложено ${money(bought)} · получено ${money(sold)} · ${sold - bought >= 0 ? "+" : ""}${(sold - bought).toFixed(2)}\n`);
}

if (already.length) console.log(`Уже записаны прошлым запуском: ${already.length}\n`);

if (unmatched.length) {
  console.log(`Не нашлось открытой позиции: ${unmatched.length}`);
  for (const sale of unmatched) console.log(`  ${sale.name} · ${money(sale.usd)}`);
  console.log("  (продана не из трекера, название записано иначе или уже закрыта руками)\n");
}

if (!apply) {
  console.log("Это был холостой прогон. Чтобы записать — повтори команду с --apply");
  process.exit(0);
}

let saved = 0;
for (const { sale, trade } of matched) {
  try {
    trades.sellTrade(
      trade.id,
      OWNER,
      {
        sellSource: SOURCE,
        sellPrice: sale.usd,
        sellDate: new Date(sale.soldAt).toISOString(),
        sellSide: "bid", // моментальный выкуп
        sellHoldDays: 0,
        sellExternalId: externalId(sale),
      },
      config.sources
    );
    saved++;
  } catch (err) {
    console.error(`  ${trade.marketHashName}: ${err.message}`);
  }
}
console.log(`Записано продаж: ${saved} из ${matched.length}`);
