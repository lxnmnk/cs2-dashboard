// Зняти паузу з поповнень USDT у мережі (cryptoTopups.js, звірка з балансом
// Skinbux). Запускати НА СЕРВЕРІ з папки проекту:
//   node topup-resume.js trc20
//   node topup-resume.js erc20
// Перед цим переконайся в панелі Skinbux → Top Up, що адреса в config.json
// (cryptoTopup.networks) збігається з панеллю і депозит клієнта там є.
// Сервер підхопить зміну на наступному проході (до хвилини), рестарт не треба.
const cryptoTopups = require("./cryptoTopups");

const network = process.argv[2];
if (!["erc20", "trc20"].includes(network)) {
  console.log("Использование: node topup-resume.js erc20|trc20");
  process.exit(1);
}
const was = cryptoTopups.resume(network);
console.log(was ? `Пауза ${network} снята (стояла с ${was.since}).` : `${network} и так не на паузе.`);
