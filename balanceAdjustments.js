// Ручные поправки к расчётным балансам площадок (trades.js computeBalances).
// Расчёт по истории продаж не знает о выводах денег/тратах на самих
// площадках, поэтому со временем расходится с реальностью — здесь хранится
// разница ("сколько сам подправил"), которая всегда прибавляется поверх
// свежего расчёта, а не заменяет его — так поправка не "протухает" при
// появлении новых продаж.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "balanceAdjustments.json");

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getAdjustments(owner) {
  return loadAll()[owner] || {};
}

// value — то число, которое пользователь хочет видеть в этом поле прямо
// сейчас; rawValue — что на этот момент даёт "чистый" расчёт без поправок.
// Сохраняем разницу между ними.
function setAdjustment(owner, source, field, value, rawValue) {
  const all = loadAll();
  if (!all[owner]) all[owner] = {};
  if (!all[owner][source]) all[owner][source] = {};
  all[owner][source][field] = round2(value - rawValue);
  saveAll(all);
  return all[owner][source];
}

function applyAdjustments(rawBalances, adjustments) {
  const sources = new Set([...Object.keys(rawBalances), ...Object.keys(adjustments)]);
  const merged = {};
  for (const s of sources) {
    const base = rawBalances[s] || { active: 0, hold: 0, frozen: 0, nextUnlockAt: null };
    const adj = adjustments[s] || {};
    merged[s] = {
      active: round2(base.active + (adj.active || 0)),
      hold: round2(base.hold + (adj.hold || 0)),
      frozen: round2(base.frozen + (adj.frozen || 0)),
      nextUnlockAt: base.nextUnlockAt,
    };
  }
  return merged;
}

module.exports = { getAdjustments, setAdjustment, applyAdjustments };
