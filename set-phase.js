// Проставить фазу Doppler / Gamma Doppler позиции в трекере.
//
// Зачем: в trades.json предмет лежит под настоящим market_hash_name, а у
// доплеров он один на все фазы — "★ Skeleton Knife | Doppler (Factory New)"
// одинаково называется и у Phase 1, и у Black Pearl. Из-за этого витрина
// показывала картинку не той фазы (Steam отдаёт одну иконку на страницу) и
// считала цену по средней строке прайса, хотя между фазами разница в разы.
//
// Внутри сайта фаза живёт синтетическим суффиксом " - <Фаза>" (см.
// itemName.js): под таким именем есть и своя строка цен, и своя картинка в
// справочнике фаз. Скрипт просто дописывает этот суффикс позиции.
//
// Запуск (на сервере, там настоящий trades.json):
//   node set-phase.js "Skeleton Knife"                      // показать позиции
//   node set-phase.js <id> "Black Pearl"                    // проставить
//
// Фазы: Phase 1..Phase 4, Ruby, Sapphire, Emerald, Black Pearl.
const trades = require("./trades");
const { stripPhaseSuffix } = require("./itemName");

const OWNER = process.env.TRADES_OWNER || "lxnmnk";
const PHASES = ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "Ruby", "Sapphire", "Emerald", "Black Pearl"];

const [, , first, second] = process.argv;

if (!first) {
  console.log('Укажи, что искать: node set-phase.js "Skeleton Knife"');
  process.exit(1);
}

const all = trades.listRawTrades(OWNER).filter((t) => t.status === "holding");

// Без второго аргумента — просто список подходящих позиций с их id.
if (!second) {
  const needle = first.toLowerCase();
  const found = all.filter((t) => t.marketHashName.toLowerCase().includes(needle));
  if (!found.length) {
    console.log("Ничего не нашлось.");
    process.exit(0);
  }
  console.log(`Найдено: ${found.length}\n`);
  for (const t of found) {
    const { phase } = stripPhaseSuffix(t.marketHashName);
    console.log(
      `  ${t.id.slice(0, 8)}  ${t.marketHashName.padEnd(56)} куплен $${String(t.buyPrice).padStart(8)}` +
        `  фаза: ${phase || "не указана"}${t.floatValue != null ? ` · float ${t.floatValue}` : ""}`
    );
  }
  console.log(`\nПроставить: node set-phase.js ${found[0].id.slice(0, 8)} "Black Pearl"`);
  process.exit(0);
}

const phase = PHASES.find((p) => p.toLowerCase() === second.trim().toLowerCase());
if (!phase) {
  console.error(`Неизвестная фаза "${second}". Доступные: ${PHASES.join(", ")}`);
  process.exit(1);
}

// id принимаем и полный, и короткий (как печатает список выше).
const matches = all.filter((t) => t.id === first || t.id.startsWith(first));
if (!matches.length) {
  console.error(`Позиция ${first} не найдена среди открытых.`);
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`Под ${first} подходит ${matches.length} позиций — укажи id длиннее.`);
  process.exit(1);
}

const trade = matches[0];
const { base, phase: current } = stripPhaseSuffix(trade.marketHashName);
if (!/Doppler/.test(base)) {
  console.error(`У "${base}" фаз не бывает.`);
  process.exit(1);
}

const nextName = `${base} - ${phase}`;
if (nextName === trade.marketHashName) {
  console.log("Уже так и записано, менять нечего.");
  process.exit(0);
}

trades.renameItem(trade.id, OWNER, nextName);
console.log(`${trade.id.slice(0, 8)}: ${current ? `${current} → ` : ""}${phase}`);
console.log(`  было:  ${trade.marketHashName}`);
console.log(`  стало: ${nextName}`);
console.log("\nКартинка и цена на витрине подтянутся сами при следующем открытии страницы.");
