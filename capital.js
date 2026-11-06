// Учёт капитала и прибыли между участниками бизнеса (я + инвесторы).
// Заменяет ручную таблицу в Excel, где каждый период дописывался колонкой с
// формулами вручную.
//
// Как считается прибыль за период:
//
//   прибыль = (банк сейчас − банк на начало периода)
//             − внесено участниками + выведено участниками
//             + мои личные траты из общих денег − мой личный доход в общие
//
// Личные траты вычитаются из банка, но бизнес в них не виноват, поэтому в
// прибыль они не входят и целиком ложатся на мой баланс. Точно так же и
// личный доход: если я занёс свои деньги на крипту, это не заработок бизнеса.
//
// Как прибыль делится:
//
//   прибыль: инвестору = его доля на НАЧАЛО периода × прибыль × (1 − комиссия управляющего)
//   убыток:  инвестору = его доля на НАЧАЛО периода × убыток — комиссия берётся
//            только с прибыли, убыток каждый несёт строго по своей доле
//   мне      = всё остальное
//
// Доля берётся на начало периода: деньги, внесённые внутри периода, начинают
// работать со следующего. Это же правило защищает от старой ошибки в Excel,
// где вывод вычитался периодом позже и человек продолжал получать прибыль на
// уже снятые деньги.
//
// Главный инвариант: сумма балансов участников после закрытия периода всегда
// равна банку. Если он нарушен — где-то потеряны деньги, и закрытие периода
// об этом скажет, а не запишет молча.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "capital.json");

// Типы движений денег между участником и общим банком.
//   deposit    — участник внёс деньги в бизнес
//   withdrawal — участник вывел свои деньги (не обязательно прибыль)
//   personal_spend  — я потратил общие деньги на себя (еда, жильё)
//   personal_income — я занёс в общий банк деньги, заработанные вне бизнеса
const MOVEMENT_TYPES = new Set(["deposit", "withdrawal", "personal_spend", "personal_income"]);
const PERSONAL_TYPES = new Set(["personal_spend", "personal_income"]);

const DEFAULTS = {
  // steamId аккаунта, инвентарь которого считается активом бизнеса.
  steamId: "76561199060089261",
  // Сколько прибыли инвестора забирает управляющий, в процентах.
  managerFeePct: 50,
  participants: [],
  movements: [],
  periods: [],
};

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    // файла ещё нет — первый запуск
  }
  return {
    ...DEFAULTS,
    ...saved,
    participants: saved.participants || [],
    movements: saved.movements || [],
    periods: saved.periods || [],
  };
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  return state;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---- Участники ----

function setParticipants(list) {
  const state = load();
  if (!Array.isArray(list) || !list.length) throw new Error("Нужен хотя бы один участник");

  state.participants = list.map((p) => {
    const name = String(p.name || "").trim();
    if (!name) throw new Error("У участника должно быть имя");
    const balance = Number(p.balance);
    if (!Number.isFinite(balance)) throw new Error(`Баланс участника "${name}" должен быть числом`);
    return {
      id: p.id || crypto.randomUUID(),
      name,
      // Учётка инвестора на сайте: по ней он видит на странице свою строку
      // ("твоя доля"), а не угадывает себя в списке. Необязательно.
      login: String(p.login || "").trim().toLowerCase() || null,
      // Управляющий получает остаток прибыли и несёт личные траты.
      isManager: !!p.isManager,
      balance: round2(balance),
    };
  });

  if (state.participants.filter((p) => p.isManager).length !== 1) {
    throw new Error("Управляющий должен быть ровно один");
  }
  return save(state);
}

function setSettings({ steamId, managerFeePct }) {
  const state = load();
  if (steamId !== undefined) {
    const id = String(steamId).trim();
    if (!/^\d{17}$/.test(id)) throw new Error("steamId — это 17 цифр");
    state.steamId = id;
  }
  if (managerFeePct !== undefined) {
    const pct = Number(managerFeePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error("Комиссия управляющего — от 0 до 100%");
    state.managerFeePct = pct;
  }
  return save(state);
}

// ---- Движения денег ----

function addMovement({ participantId, type, amount, date, note }) {
  const state = load();
  if (!MOVEMENT_TYPES.has(type)) throw new Error("Неизвестный тип движения");

  const participant = state.participants.find((p) => p.id === participantId);
  if (!participant) throw new Error("Участник не найден");
  // Личные траты и доходы бывают только у управляющего: только его баланс
  // отделён от бизнеса.
  if (PERSONAL_TYPES.has(type) && !participant.isManager) {
    throw new Error("Личные траты и доходы бывают только у управляющего");
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Сумма должна быть положительным числом");

  state.movements.push({
    id: crypto.randomUUID(),
    participantId,
    type,
    amount: round2(value),
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    note: String(note || "").slice(0, 200),
    // Движения, попавшие в закрытый период, помечаются его id и дальше в
    // расчёт не идут.
    periodId: null,
  });
  return save(state);
}

function deleteMovement(id) {
  const state = load();
  const movement = state.movements.find((m) => m.id === id);
  if (!movement) throw new Error("Движение не найдено");
  if (movement.periodId) throw new Error("Это движение уже вошло в закрытый период");
  state.movements = state.movements.filter((m) => m.id !== id);
  return save(state);
}

/** Движения, ещё не вошедшие ни в один закрытый период. */
function openMovements(state) {
  return state.movements.filter((m) => !m.periodId);
}

// ---- Расчёт периода ----

/**
 * Предварительный расчёт: что будет, если закрыть период прямо сейчас с
 * банком bankTotal. Ничего не пишет — это то, что видно на странице до
 * нажатия кнопки.
 */
function previewPeriod(state, bankTotal) {
  const participants = state.participants;
  const openingTotal = round2(participants.reduce((sum, p) => sum + p.balance, 0));
  const movements = openMovements(state);

  const sumOf = (type, filter = () => true) =>
    round2(movements.filter((m) => m.type === type && filter(m)).reduce((sum, m) => sum + m.amount, 0));

  const deposits = sumOf("deposit");
  const withdrawals = sumOf("withdrawal");
  const personalSpend = sumOf("personal_spend");
  const personalIncome = sumOf("personal_income");

  // Прибыль бизнеса: рост банка, очищенный от движений участников и от моих
  // личных денег.
  const profit = round2(bankTotal - openingTotal - deposits + withdrawals + personalSpend - personalIncome);

  const feeRate = state.managerFeePct / 100;
  const manager = participants.find((p) => p.isManager);
  const rows = [];
  let investorsProfit = 0;

  for (const p of participants) {
    const share = openingTotal > 0 ? p.balance / openingTotal : 0;
    const deposited = sumOf("deposit", (m) => m.participantId === p.id);
    const withdrawn = sumOf("withdrawal", (m) => m.participantId === p.id);
    // Доля прибыли инвестора за вычетом комиссии управляющего; убыток — по
    // доле целиком, без комиссии. У самого управляющего прибыль считается
    // остатком — ниже.
    const investorRate = profit > 0 ? 1 - feeRate : 1;
    const profitShare = p.isManager ? 0 : round2(share * profit * investorRate);
    if (!p.isManager) investorsProfit = round2(investorsProfit + profitShare);
    rows.push({ id: p.id, name: p.name, isManager: p.isManager, opening: p.balance, share, deposited, withdrawn, profit: profitShare });
  }

  const managerRow = rows.find((r) => r.isManager);
  if (managerRow) {
    // Управляющему — остаток прибыли (своя доля + комиссия с инвесторов),
    // минус личные траты, плюс личный доход.
    managerRow.profit = round2(profit - investorsProfit);
    managerRow.personalSpend = personalSpend;
    managerRow.personalIncome = personalIncome;
  }

  for (const row of rows) {
    const personal = row.isManager ? personalIncome - personalSpend : 0;
    row.closing = round2(row.opening + row.profit + row.deposited - row.withdrawn + personal);
  }

  const closingTotal = round2(rows.reduce((sum, r) => sum + r.closing, 0));
  return {
    openingTotal,
    bankTotal: round2(bankTotal),
    deposits,
    withdrawals,
    personalSpend,
    personalIncome,
    profit,
    investorsProfit,
    managerFeePct: state.managerFeePct,
    rows,
    closingTotal,
    // Сумма балансов обязана сойтись с банком. Расхождение — признак ошибки
    // в расчёте, а не повод округлить.
    mismatch: round2(closingTotal - round2(bankTotal)),
    movements,
  };
}

/**
 * Закрыть период: записать историю и переставить балансы участников.
 * bankBreakdown сохраняется целиком, чтобы через полгода было видно, из чего
 * складывался банк в тот день, а не только итог.
 */
function closePeriod(bankTotal, bankBreakdown, { note } = {}) {
  const state = load();
  if (!state.participants.length) throw new Error("Сначала заведи участников");

  const preview = previewPeriod(state, bankTotal);
  if (Math.abs(preview.mismatch) > 0.05) {
    throw new Error(`Балансы не сходятся с банком на $${preview.mismatch} — расчёт не записан`);
  }

  const period = {
    id: crypto.randomUUID(),
    closedAt: new Date().toISOString(),
    note: String(note || "").slice(0, 200),
    openingTotal: preview.openingTotal,
    bankTotal: preview.bankTotal,
    bank: bankBreakdown || null,
    deposits: preview.deposits,
    withdrawals: preview.withdrawals,
    personalSpend: preview.personalSpend,
    personalIncome: preview.personalIncome,
    profit: preview.profit,
    managerFeePct: state.managerFeePct,
    rows: preview.rows.map((r) => ({ ...r })),
  };

  state.periods.push(period);
  for (const row of preview.rows) {
    const participant = state.participants.find((p) => p.id === row.id);
    if (participant) participant.balance = row.closing;
  }
  for (const movement of openMovements(state)) movement.periodId = period.id;

  save(state);
  return period;
}

/**
 * Отменить последний расчёт: балансы участников возвращаются к тем, что были
 * на его начало, движения денег снова становятся открытыми, а сам расчёт
 * удаляется из истории. Нужен, когда банк в расчёте оказался неверным.
 */
function undoLastPeriod() {
  const state = load();
  const period = state.periods.pop();
  if (!period) throw new Error("Нет ни одного расчёта");
  for (const row of period.rows) {
    const participant = state.participants.find((p) => p.id === row.id);
    if (participant) participant.balance = row.opening;
  }
  for (const movement of state.movements) {
    if (movement.periodId === period.id) delete movement.periodId;
  }
  save(state);
  return period;
}

/**
 * Прибыль каждого участника за произвольный отрезок — то, что инвестор
 * выбирает календариком. Складывается из уже закрытых периодов — их закрывает
 * владелец кнопкой, когда сам проверил банк.
 *
 * Берём периоды, закрытые внутри [from, to], и суммируем по каждому его долю
 * прибыли. Взносы и выводы в сумму не идут: это не заработок, а движение
 * собственных денег.
 */
function profitBetween({ from, to } = {}) {
  const state = load();
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  // Конец дня включительно: выбрав "по 7 октября", человек ждёт, что седьмое
  // войдёт целиком.
  const toMs = to ? new Date(to).getTime() + 86400000 - 1 : Infinity;

  const periods = state.periods.filter((p) => {
    const at = new Date(p.closedAt).getTime();
    return at >= fromMs && at <= toMs;
  });

  const byId = new Map(state.participants.map((p) => [p.id, { id: p.id, name: p.name, isManager: p.isManager, profit: 0 }]));
  let total = 0;
  for (const period of periods) {
    total = round2(total + period.profit);
    for (const row of period.rows || []) {
      const acc = byId.get(row.id);
      if (acc) acc.profit = round2(acc.profit + (Number(row.profit) || 0));
    }
  }

  const days = periods.length;
  return {
    from: from || null,
    to: to || null,
    days,
    periods: periods.length,
    profit: total,
    perDay: days ? round2(total / days) : 0,
    rows: [...byId.values()],
    // Крайние точки отрезка — чтобы на странице было видно, за что именно
    // посчитано, если история начинается позже выбранной даты.
    firstAt: periods[0]?.closedAt || null,
    lastAt: periods[periods.length - 1]?.closedAt || null,
  };
}

module.exports = {
  load,
  save,
  profitBetween,
  setParticipants,
  setSettings,
  addMovement,
  deleteMovement,
  openMovements,
  previewPeriod,
  closePeriod,
  undoLastPeriod,
  MOVEMENT_TYPES,
};
