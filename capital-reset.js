// Новая точка отсчёта капитала: 7 октября 2026, по данным владельца.
//
// Автоматические расчёты 08.10, 14.10 и 01.11 собирались из устаревших
// ручных балансов (CS.Money и Крипта не обновлялись), и 01.11 раздул банк до
// $67,739. Их убираем, а историю начинаем заново:
//   1. копия capital.json рядом (capital.backup-<время>.json);
//   2. все старые расчёты удаляются, движения денег из них снова открыты;
//   3. балансы участников — как были на 7 октября;
//   4. в историю пишется расчёт "7 октября" с нулевой прибылью — старт.
// Следующий расчёт закрывается кнопкой на странице "Капитал": прибыль = банк
// сейчас − банк 7 октября, по долям на 7 октября.
//
// Запуск (на сервере):
//   node capital-reset.js           // показать, что будет, ничего не меняя
//   node capital-reset.js --apply   // записать
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const capital = require("./capital");

const START_AT = "2026-10-07T23:59:00+03:00";
const BALANCES = { lxnmnk: 16577, Natalia: 16172, Volodymyr: 14407 };

const apply = process.argv.includes("--apply");
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const round2 = (n) => Math.round(n * 100) / 100;

const state = capital.load();
console.log(`Режим: ${apply ? "ЗАПИСЫВАЮ" : "вхолостую"}\n`);

console.log(`Удаляю расчёты (${state.periods.length}):`);
for (const p of state.periods) {
  console.log(`  ${p.closedAt.slice(0, 10)} · банк ${money(p.bankTotal)} · прибыль ${money(p.profit)} · ${p.note || ""}`);
}

const reopened = state.movements.filter((m) => m.periodId);
if (reopened.length) {
  console.log(`\n⚠ Движения денег из удаляемых расчётов снова станут открытыми и попадут в сегодняшний расчёт:`);
  for (const m of reopened) console.log(`  ${m.date} · ${m.type} · ${money(m.amount)} · ${m.note || ""}`);
}

const total = round2(Object.values(BALANCES).reduce((s, v) => s + v, 0));
console.log(`\nБалансы на 7 октября (банк ${money(total)}):`);
const rows = [];
for (const p of state.participants) {
  if (!(p.name in BALANCES)) throw new Error(`Нет баланса на 7 октября для участника "${p.name}"`);
  const balance = BALANCES[p.name];
  console.log(`  ${p.name.padEnd(10)} ${money(p.balance).padStart(11)} → ${money(balance)}`);
  rows.push({ id: p.id, name: p.name, isManager: p.isManager, opening: balance, share: balance / total, deposited: 0, withdrawn: 0, profit: 0, closing: balance });
}
if (rows.length !== Object.keys(BALANCES).length) throw new Error("Участников на сервере не столько, сколько в BALANCES");

if (!apply) {
  console.log("\nЭто был холостой прогон. Чтобы записать — повтори с --apply");
  process.exit(0);
}

const backup = path.join(__dirname, `capital.backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.copyFileSync(path.join(__dirname, "capital.json"), backup);

for (const p of state.participants) p.balance = BALANCES[p.name];
for (const m of state.movements) delete m.periodId;
state.periods = [
  {
    id: crypto.randomUUID(),
    closedAt: new Date(START_AT).toISOString(),
    note: "точка отсчёта — данные владельца на 7 октября",
    openingTotal: total,
    bankTotal: total,
    bank: null,
    deposits: 0,
    withdrawals: 0,
    personalSpend: 0,
    personalIncome: 0,
    profit: 0,
    managerFeePct: state.managerFeePct,
    rows,
  },
];
capital.save(state);
console.log(`\nЗаписано. Копия старого файла: ${path.basename(backup)}`);
