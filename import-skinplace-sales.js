// Импорт продаж на skin.place в трекер сделок.
//
// API продаж у skin.place нет — список снят с их таблицы выгрузки руками.
// Float там не показан, поэтому сопоставляем по названию. Если одинаковых
// открытых позиций несколько — берём самую старую из уже разблокированных
// (продать можно только её) и пишем об этом, чтобы проверить глазами.
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
];

const apply = process.argv.includes("--apply");
const externalId = (sale) => `skinplace:${sale.order}:${sale.name}`;

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
  const hits = holdings
    .filter((t) => t.marketHashName === sale.name && !taken.has(t.id))
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
  for (const { sale, trade, of, locked } of matched) {
    const buy = Number(trade.buyPrice) || 0;
    bought += buy;
    sold += sale.usd;
    const profit = sale.usd - buy;
    const float = trade.floatValue != null ? ` float ${Number(trade.floatValue).toFixed(4)}` : "";
    const note = [
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
