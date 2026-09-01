// Одноразовый скрипт: до авторизации у сделок не было поля owner.
// Присваивает все "бесхозные" сделки указанному пользователю.
//   node migrate-trades.js <username>
const fs = require("fs");
const path = require("path");
const { userExists } = require("./users");

const TRADES_FILE = path.join(__dirname, "trades.json");
const [, , username] = process.argv;

if (!username) {
  console.error("Использование: node migrate-trades.js <username>");
  process.exit(1);
}

const normalized = username.trim().toLowerCase();

if (!userExists(normalized)) {
  console.error(`Пользователь "${normalized}" не найден — сначала создайте его через create-user.js`);
  process.exit(1);
}

if (!fs.existsSync(TRADES_FILE)) {
  console.log("trades.json не найден — переносить нечего.");
  process.exit(0);
}

const trades = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
let migrated = 0;

for (const trade of trades) {
  if (!trade.owner) {
    trade.owner = normalized;
    migrated++;
  }
}

fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
console.log(`Готово: ${migrated} сделок(-а) закреплено за "${normalized}" (всего в файле: ${trades.length}).`);
