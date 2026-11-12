// Проверка цены выкупа из консоли — первый запуск и отладка.
//
//   node price-check.js skinplace "★ Talon Knife | Doppler (Minimal Wear) - Ruby" 0.07 0.15
//   node price-check.js skins "AWP | Dragon Lore (Field-Tested)" --fields
//
// Диапазон float учитывается только для skin.place: skins.com платит за
// название и качество, float ему не важен.
//
// --fields печатает весь предмет из ответа: формат у площадок нигде не
// описан, и по настоящему предмету видно, правильно ли мы читаем цену и
// float. Куку и токены скрипт не печатает никогда.
require("dotenv").config();
const { buyoutPrice, SOURCES } = require("./buyoutLookup");

const args = process.argv.slice(2).filter((a) => a !== "--fields");
const debug = process.argv.includes("--fields");
const [source, name, minRaw, maxRaw] = args;

if (!SOURCES[source] || !name) {
  console.log(`Укажи площадку (${Object.keys(SOURCES).join(" или ")}) и предмет:`);
  console.log('  node price-check.js skinplace "AWP | Dragon Lore (Field-Tested)" 0.3 0.33');
  process.exit(1);
}

(async () => {
  try {
    const result = await buyoutPrice(source, name, {
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
