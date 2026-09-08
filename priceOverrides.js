// Ручные цены выкупа по конкретным предметам.
//
// Обычно цену клиенту считает sellQuote.js по формуле (bid скинбакса минус
// 5%, но не выше ask на buff/youpin). Иногда за предмет хочется дать другую
// сумму — например, редкий флот или паттерн, который формула не видит, либо
// наоборот предмет, который не хочется брать по расчётной цене. Такая цена
// перебивает расчётную ВЕЗДЕ, где клиент её видит: и в кабинете, и в
// прайс-чекере, и при автопродаже (то есть именно её мы и заплатим).
//
// На то, что уходит в Skinbux при продаже, это не влияет — там своя цена,
// которую они сверяют со своей же (иначе INVALID_PRICE).
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "priceOverrides.json");

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveAll(all) {
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

/** Цена для предмета или null, если ручной цены нет. */
function get(marketHashName) {
  const entry = loadAll()[marketHashName];
  return entry ? entry.price : null;
}

function set(marketHashName, price, note) {
  const name = typeof marketHashName === "string" ? marketHashName.trim() : "";
  if (!name) throw new Error("Не указан предмет");

  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Цена должна быть положительным числом");
  if (value > 100000) throw new Error("Цена выглядит ошибочной (больше $100 000)");

  const all = loadAll();
  all[name] = {
    price: Math.round(value * 100) / 100,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null,
    updatedAt: new Date().toISOString(),
  };
  saveAll(all);
  return all[name];
}

function remove(marketHashName) {
  const all = loadAll();
  if (!all[marketHashName]) return false;
  delete all[marketHashName];
  saveAll(all);
  return true;
}

function list() {
  return Object.entries(loadAll())
    .map(([marketHashName, entry]) => ({ marketHashName, ...entry }))
    .sort((a, b) => a.marketHashName.localeCompare(b.marketHashName));
}

module.exports = { get, set, remove, list };
