// Официальные русские и украинские названия скина по его market_hash_name —
// для поиска: "Красная линия", "Нож-бабочка", "Червона лінія" должны находить
// AK-47 | Redline и Butterfly Knife. Словарь собирается из файлов локализации
// самой CS2 скриптом tools/build-skin-names.js в skinNamesI18n.json.
//
// Название разбираем на части (оружие | раскраска (качество)) и переводим
// каждую. Наклейки, агенты, кейсы в словарь не входят — для них пусто.
const names = require("./skinNamesI18n.json");

const DOPPLER_PHASE_SUFFIX = / - (Phase \d|Ruby|Sapphire|Black Pearl|Emerald)$/;

const cache = new Map();

/** Строка с русскими и украинскими названиями через пробел (или ""). */
function localizedAlt(marketHashName) {
  if (cache.has(marketHashName)) return cache.get(marketHashName);

  let rest = String(marketHashName || "").replace(DOPPLER_PHASE_SUFFIX, "");
  let wear = null;
  const wearMatch = rest.match(/^(.*) \(([^)]+)\)$/);
  if (wearMatch) {
    rest = wearMatch[1];
    wear = wearMatch[2];
  }
  rest = rest.replace(/^★\s*/, "").replace(/^StatTrak™\s*/, "").replace(/^Souvenir\s*/, "");
  const [weapon, finish] = rest.split(" | ");

  const parts = [
    ...(names.weapons[weapon] || []),
    ...(finish ? names.finishes[finish] || [] : []),
    ...(wear ? names.wears[wear] || [] : []),
  ];
  const alt = parts.join(" ");
  cache.set(marketHashName, alt);
  return alt;
}

module.exports = { localizedAlt };
