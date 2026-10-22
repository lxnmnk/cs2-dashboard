// Проставить фазу всем доплерам в трекере, купленным на CSFloat.
//
// Раньше импорт с CSFloat записывал доплер без фазы ("★ Butterfly Knife |
// Doppler (Factory New)"), и витрина показывала общую картинку Steam — на ней
// сапфир, — а цену считала средней по всем фазам. Теперь импорт фазу пишет
// сам (csfloatPurchases.js), а этот скрипт один раз чинит уже записанные:
// заново спрашивает у CSFloat наши покупки и по номеру сделки дописывает фазу.
//
// Ничего не меняет без --apply.
//
// Запуск (на сервере, там настоящий trades.json и ключ CSFloat):
//   node fix-doppler-phases.js            // показать, что поменяется
//   node fix-doppler-phases.js --apply    // записать
//
// Доплеры, купленные не на CSFloat, скрипт перечислит — им фазу проставляют
// руками: node set-phase.js <id> "Phase 2".
require("dotenv").config();
const trades = require("./trades");
const csfloatPurchases = require("./csfloatPurchases");
const { stripPhaseSuffix } = require("./itemName");

const OWNER = process.env.TRADES_OWNER || "lxnmnk";
const DAYS = 365;
const apply = process.argv.includes("--apply");

(async () => {
  const noPhase = trades
    .listRawTrades(OWNER)
    .filter((t) => /Doppler/.test(t.marketHashName) && !stripPhaseSuffix(t.marketHashName).phase);
  if (!noPhase.length) {
    console.log("Все доплеры в трекере уже с фазой.");
    return;
  }

  const { purchases } = await csfloatPurchases.fetchPurchases(process.env.CSFLOAT_API_KEY, { days: DAYS, mode: "all" });
  const nameById = new Map(purchases.map((p) => [p.externalId, p.marketHashName]));

  const fixes = [];
  const unknown = [];
  for (const t of noPhase) {
    const fresh = t.externalId ? nameById.get(t.externalId) : null;
    const phase = fresh ? stripPhaseSuffix(fresh).phase : null;
    if (phase) fixes.push({ t, name: `${t.marketHashName} - ${phase}` });
    else unknown.push(t);
  }

  console.log(`Доплеров без фазы: ${noPhase.length} · режим: ${apply ? "ЗАПИСЫВАЮ" : "вхолостую"}\n`);
  for (const { t, name } of fixes) {
    console.log(`  ${t.id.slice(0, 8)}  ${t.status === "sold" ? "(продан) " : ""}${name}`);
  }
  if (unknown.length) {
    console.log(`\nФазу не узнать (куплен не на CSFloat или давно): ${unknown.length}`);
    for (const t of unknown) {
      console.log(`  ${t.id.slice(0, 8)}  ${t.marketHashName}${t.floatValue != null ? ` · float ${Number(t.floatValue).toFixed(4)}` : ""}`);
    }
    console.log('  Им — руками: node set-phase.js <id> "Phase 2"');
  }

  if (!apply) {
    if (fixes.length) console.log("\nЭто был холостой прогон. Чтобы записать — повтори с --apply");
    return;
  }
  for (const { t, name } of fixes) trades.renameItem(t.id, OWNER, name);
  console.log(`\nЗаписано: ${fixes.length}`);
})().catch((err) => {
  console.error("Не получилось:", err.message);
  process.exit(1);
});
