// Из чего был собран банк в каждом закрытом расчёте (capital.json) —
// строка в строку, как на странице "Капитал" сейчас. Нужен, чтобы понять,
// откуда скачок банка между расчётами. Ничего не меняет.
//
// Запуск (на сервере):
//   node capital-history.js        // последние 3 расчёта
//   node capital-history.js 10     // последние 10
const capital = require("./capital");

const count = Number(process.argv[2]) || 3;
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

const { periods } = capital.load();
for (const p of periods.slice(-count)) {
  console.log(`\n=== ${p.closedAt.slice(0, 16).replace("T", " ")} · ${p.note || ""} · банк ${money(p.bankTotal)} · было ${money(p.openingTotal)} · прибыль ${money(p.profit)}`);
  const b = p.bank;
  if (!b) {
    console.log("  (раскладка банка не сохранена)");
    continue;
  }
  if (b.inventory) {
    console.log(
      `  Скины:        ${money(b.inventory.total)} · ${b.inventory.count} шт · в бане ${b.inventory.locked} · по рынку ${money(b.inventory.marketValue)}`
    );
  }
  for (const m of b.money || []) {
    console.log(`  ${m.title.padEnd(13)} ${money(m.value)}${m.note ? ` · ${m.note}` : ""}`);
  }
  if (b.owedToMe) console.log(`  Мне должны:   ${money(b.owedToMe)}`);
  if (b.leftoverDebt) console.log(`  Долг сверх Skinbux: −${money(b.leftoverDebt)}`);
  if (b.untracked?.count) console.log(`  Нет в трекере (в банк не шло): ${b.untracked.count} шт на ${money(b.untracked.value)}`);
  if (b.errors?.length) console.log(`  Ошибки: ${b.errors.join(" | ")}`);
  if (p.deposits || p.withdrawals) console.log(`  Внесено ${money(p.deposits)} · выведено ${money(p.withdrawals)}`);
}
