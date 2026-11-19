// Зарахувати клієнту переказ USDT, який прийшов "без рахунку" (сума не
// збіглась, рахунок прострочився — про такий приходить повідомлення "❓").
// Запускати НА СЕРВЕРІ з папки проекту:
//   node topup-match.js <TX переказу> <Steam ID клієнта або id рахунку>
// Зараховується фактична сума переказу мінус комісія мережі (feeUsd), у
// trade-баланс — так само, як автоматичне зарахування. Рестарт не потрібен.
const cryptoTopups = require("./cryptoTopups");

const [tx, who] = process.argv.slice(2);
if (!tx || !who) {
  console.log("Использование: node topup-match.js <TX> <Steam ID клиента или id счёта>");
  process.exit(1);
}
try {
  const inv = cryptoTopups.manualMatch(tx, who);
  console.log(`Зачислено клиенту ${inv.steamId}: пришло $${inv.received.toFixed(2)}, на trade-баланс $${inv.credited.toFixed(2)} (счёт был на $${inv.amount.toFixed(2)}).`);
} catch (err) {
  console.log("Ошибка:", err.message);
  process.exit(1);
}
