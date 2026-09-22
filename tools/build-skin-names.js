// Собирает skinNamesI18n.json — официальные русские и украинские названия
// оружия, раскрасок и качества из файлов локализации самой CS2 (их выкладывает
// CSFloat: github.com/csfloat/cs-files). Нужно для поиска: люди ищут так, как
// скин называется у них в игре ("Красная линия", "Нож-бабочка", "Градиент"),
// а в market_hash_name всё по-английски.
//
// Запуск (раз в несколько месяцев, когда выходят новые коллекции):
//   node tools/build-skin-names.js
const fs = require("fs");
const path = require("path");

const BASE = "https://raw.githubusercontent.com/csfloat/cs-files/master/static";
const OUT = path.join(__dirname, "..", "skinNamesI18n.json");

// Какие токены нужны: раскраски, оружие/ножи, перчатки, качество.
const GROUPS = {
  finishes: (k) => k.startsWith("paintkit_") && k.endsWith("_tag"),
  weapons: (k) => k.startsWith("sfui_wpnhud_") || k.startsWith("csgo_wearable_"),
  wears: (k) => k.startsWith("sfui_invtooltip_wear_amount_"),
};

function parse(txt) {
  const map = new Map();
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*"([^"]+)"\s+"(.*)"\s*$/);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  return map;
}

async function load(lang) {
  const res = await fetch(`${BASE}/csgo_${lang}.txt`);
  if (!res.ok) throw new Error(`csgo_${lang}.txt: ${res.status}`);
  return parse(await res.text());
}

(async () => {
  const [en, ru, uk] = await Promise.all(["english", "russian", "ukrainian"].map(load));
  const out = {};
  for (const [group, wanted] of Object.entries(GROUPS)) {
    const table = {};
    for (const [key, enValue] of en) {
      if (!wanted(key) || !enValue) continue;
      const names = new Set(table[enValue] || []);
      for (const other of [ru.get(key), uk.get(key)]) {
        if (other && other !== enValue) names.add(other);
      }
      if (names.size) table[enValue] = [...names];
    }
    out[group] = table;
    console.log(`${group}: ${Object.keys(table).length}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`записано ${OUT} (${fs.statSync(OUT).size} байт)`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
