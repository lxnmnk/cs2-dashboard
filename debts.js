// Долги в нашу сторону: кто и сколько должен вернуть.
//
// Это единственные деньги бизнеса, которых не видно ниоткуда: площадки их не
// отдают, в трекере сделок их нет, в инвентаре тем более. Отдал скин под
// обещание заплатить, выручил друга деньгами, оплатил покупку за клиента —
// деньги вышли из оборота, но никуда не делись. Без такой записи они просто
// исчезают из капитала, и прибыль периода выходит заниженной.
//
// Обратное направление (сколько должны МЫ — клиентам и друзьям) считается
// само из журнала продаж, см. capitalBank.clientLiabilities. Здесь только то,
// что никакой API не знает, поэтому запись ручная.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "debts.json");

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveAll(debts) {
  fs.writeFileSync(FILE, JSON.stringify(debts, null, 2));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Долги владельца, свежие сверху; возвращённые уходят вниз. */
function list(owner) {
  return loadAll()
    .filter((d) => d.owner === owner)
    .sort((a, b) => {
      if (!!a.repaidAt !== !!b.repaidAt) return a.repaidAt ? 1 : -1;
      return new Date(b.date) - new Date(a.date);
    });
}

function add({ owner, who, amount, note, date }) {
  if (!owner) throw new Error("owner обязателен");
  const name = String(who || "").trim();
  if (!name) throw new Error("Укажи, кто должен");
  if (name.length > 60) throw new Error("Имя слишком длинное");

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Сумма должна быть положительным числом");

  const debts = loadAll();
  const debt = {
    id: crypto.randomUUID(),
    owner,
    who: name,
    amount: round2(value),
    note: String(note || "").slice(0, 200),
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    // Дата возврата: пока её нет, деньги считаются невозвращёнными.
    repaidAt: null,
  };
  debts.push(debt);
  saveAll(debts);
  return debt;
}

function find(debts, id, owner) {
  const debt = debts.find((d) => d.id === id && d.owner === owner);
  if (!debt) throw new Error("Долг не найден");
  return debt;
}

/** Отметить возвращённым или снять отметку (repaid: false). */
function setRepaid(id, owner, repaid = true) {
  const debts = loadAll();
  const debt = find(debts, id, owner);
  debt.repaidAt = repaid ? new Date().toISOString() : null;
  saveAll(debts);
  return debt;
}

function remove(id, owner) {
  const debts = loadAll();
  find(debts, id, owner);
  saveAll(debts.filter((d) => d.id !== id));
}

/** Сколько всего нам должны прямо сейчас — для карточки и для банка. */
function totalOwed(owner) {
  const open = list(owner).filter((d) => !d.repaidAt);
  return {
    total: round2(open.reduce((sum, d) => sum + d.amount, 0)),
    count: open.length,
  };
}

module.exports = { list, add, setRepaid, remove, totalOwed };
