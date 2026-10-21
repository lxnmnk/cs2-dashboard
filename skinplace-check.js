// Проверка цены skin.place из консоли — первый запуск и отладка.
//
//   node skinplace-check.js "★ Talon Knife | Doppler (Minimal Wear) - Ruby" 0.07 0.15
//   node skinplace-check.js "..." 0.07 0.15 --fields   // плюс весь предмет из ответа
//
// --fields нужен один раз: формат ответа skin.place нигде не описан, и по
// настоящему предмету видно, правильно ли мы читаем цену и float. Куку и
// ключи скрипт не печатает никогда.
require("dotenv").config();
const { skinplacePrice } = require("./skinplaceLookup");

const args = process.argv.slice(2).filter((a) => a !== "--fields");
const debug = process.argv.includes("--fields");
const [name, minRaw, maxRaw] = args;

if (!name) {
  console.log('Укажи предмет: node skinplace-check.js "★ Talon Knife | Doppler (Minimal Wear) - Ruby" 0.07 0.15');
  process.exit(1);
}

(async () => {
  try {
    const result = await skinplacePrice(name, {
      minFloat: minRaw != null ? Number(minRaw) : null,
      maxFloat: maxRaw != null ? Number(maxRaw) : null,
      debug,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Не получилось:", err.message);
    process.exit(1);
  }
})();
