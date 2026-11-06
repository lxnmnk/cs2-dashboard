// Расклад холда Skinbux по транзакциям — то же, что карточка Skinbux в My
// Trades (skinbuxAccount.splitHold), только по строкам: чья транзакция,
// откуда это известно и сколько из неё идёт в "моё". Ничего не меняет.
//
// Запуск (на сервере):
//   node hold-breakdown.js
require("dotenv").config();
const skinbuxAccount = require("./skinbuxAccount");
const skinbuxSales = require("./skinbuxSales");
const trades = require("./trades");

const OWNER = process.env.TRADES_OWNER || "lxnmnk";
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const VIA = { journal: "журнал сайта", tracker: "трекер", unknown: "нигде (просто считаю моим)" };

(async () => {
  const transactions = await skinbuxAccount.fetchTransactions(process.env.SKINBUX_API_KEY);
  const split = skinbuxAccount.splitHold(transactions, {
    sales: skinbuxSales.loadAll(),
    trackerSales: trades.listRawTrades(OWNER),
    ownerSteamId: skinbuxSales.OWNER_STEAM_ID,
    partners: skinbuxSales.PARTNER_STEAM_IDS,
  });

  const items = [...split.items].sort((a, b) => new Date(a.unlockAt) - new Date(b.unlockAt));
  let mineSum = 0;
  for (const it of items) {
    // В "моё": своя продажа — целиком, клиентская — сумма минус долг клиенту,
    // партнёрская — ноль (если уже вернул, то целиком).
    let toMine;
    if (it.owner === "mine") toMine = it.amount;
    else if (it.owner === "client") toMine = it.amount - (it.payout || 0);
    else toMine = it.paidAt ? it.amount : 0;
    mineSum += toMine;

    const who =
      it.owner === "mine" ? "МОЁ" : it.owner === "client" ? `клиент ${it.customerName || it.steamId || ""}` : it.owner;
    console.log(
      `#${it.id} · разблок. ${it.unlockAt.slice(0, 16).replace("T", " ")} · ${money(it.amount)} · ${who}` +
        `${it.paidAt ? " (уже оплачен)" : ""} · откуда: ${VIA[it.via] || it.via}` +
        `${it.payout != null ? ` · должны ${money(it.payout)}` : ""} · в "моё" ${money(toMine)}`
    );
    for (const name of it.names) console.log(`      ${name}`);
    if (it.journal) {
      console.log(`    журнал сайта: steamId ${it.journal.steamId} · ${it.journal.kind} · клиенту ${money(it.journal.totalPrice)}`);
    }
    for (const t of it.tracker || []) {
      console.log(
        `    трекер: ${t.name} · куплен ${t.buySource} ${money(t.buyPrice)} ${String(t.buyDate).slice(0, 10)}` +
          ` · продан ${money(t.sellPrice)} · id ${String(t.id).slice(0, 8)}`
      );
    }
  }

  console.log("\nИТОГО");
  console.log(`  в холде всего:        ${money(split.total)}  (${items.length} транз.)`);
  console.log(`  партнёрам вернуть:    ${money(Object.values(split.partners).reduce((s, v) => s + v, 0))}`);
  console.log(`  клиентам выплатить:   ${money(split.clients.payout)}`);
  console.log(`  моё:                  ${money(split.mine)}  (по строкам ${money(mineSum)})`);
  console.log(`  из моего не найдено ни в журнале, ни в трекере: ${money(split.unconfirmed.sum)} (${split.unconfirmed.count} транз.)`);
})().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
