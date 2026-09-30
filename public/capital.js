// Страница "Капитал и прибыль": банк, доли участников, движения денег и
// закрытие периода. Считает всё сервер (capital.js, capitalBank.js) — здесь
// только показ и формы, чтобы прибыль нельзя было "подправить" из браузера.
const errorBox = document.getElementById("errorBox");
let data = null; // последний ответ /api/capital
let setupRows = []; // черновик участников в блоке настроек

function money(v) {
  const n = Number(v) || 0;
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(v) {
  return ((Number(v) || 0) * 100).toFixed(2) + "%";
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("ru-RU") : "—";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showError(message) {
  errorBox.style.display = message ? "block" : "none";
  errorBox.textContent = message || "";
}

async function api(path, options) {
  const res = await fetch(path, options);
  const payload = await res.json().catch(() => ({ ok: false, error: "сервер ответил не JSON" }));
  if (!payload.ok) throw new Error(payload.error || "неизвестная ошибка");
  return payload;
}

async function load({ refresh = false } = {}) {
  showError("");
  try {
    data = await api(`/api/capital${refresh ? "?refresh=1" : ""}`);
  } catch (err) {
    showError(`Не удалось посчитать: ${err.message}`);
    return;
  }
  render();
}

function render() {
  const { bank, preview, state, pricesReady } = data;
  document.getElementById("bankUpdatedTop").textContent = "банк на " + new Date(bank.collectedAt).toLocaleString("ru-RU");

  const problems = [...bank.errors];
  if (!pricesReady) problems.push("Цены ещё не загрузились — инвентарь посчитан не полностью");
  if (bank.inventory.unpriced.count) {
    problems.push(`${bank.inventory.unpriced.count} предмет(ов) без цены не попали в банк: ${bank.inventory.unpriced.names.slice(0, 3).join(", ")}`);
  }
  showError(problems.join(" · "));

  renderBankCards(bank, preview);
  renderBankTable(bank);
  renderManual(state);
  renderPeople(preview);
  renderSetup(state);
  renderMovements(state, preview);
  renderHistory(state);
}

function renderBankCards(bank, preview) {
  const cards = [
    ["Банк (за вычетом долгов)", money(bank.total), ""],
    ["Прибыль периода", money(preview.profit), preview.profit >= 0 ? "profit" : "loss"],
    ["Инвесторам из неё", money(preview.investorsProfit), ""],
    ["Долг клиентам", money(bank.liabilities.total), bank.liabilities.total ? "loss" : ""],
  ];
  document.getElementById("bankCards").innerHTML = cards
    .map(
      ([label, value, cls]) =>
        `<div class="summary-card"><div class="label">${escapeHtml(label)}</div><div class="value ${cls}">${value}</div></div>`
    )
    .join("");
}

function renderBankTable(bank) {
  const inv = bank.inventory;
  const rows = [
    ["Инвентарь Steam, можно продать сейчас", inv.tradable.value, `${inv.tradable.count} шт · лучший bid минус комиссия`],
    ["Инвентарь Steam, в трейд-бане", inv.locked.value, `${inv.locked.count} шт · по цене покупки${inv.locked.unknownCost ? `; ${inv.locked.unknownCost} без известной цены — по рынку` : ""}`],
    ["Баланс CSFloat", bank.csfloat.value, bank.csfloat.source === "api" ? "из API" : bank.csfloat.source === "manual" ? "вписан руками" : "не прочитан"],
    ["Баланс Youpin", bank.youpin, "вручную"],
    ["Баланс Skinbux", bank.skinbux, "вручную"],
    ["Крипта / кеш", bank.cash, "вручную"],
    ["Переплата за флот", bank.overpay, "вручную"],
    ["Итого активы", bank.assets, ""],
    ["Долг клиентам: выплаты", -bank.liabilities.payout, "балансы клиентов на сайте"],
    ["Долг клиентам: trade-баланс", -bank.liabilities.tradeCredit, "должны скинами"],
    ["Банк", bank.total, "из него считается прибыль"],
  ];
  document.getElementById("bankBody").innerHTML = rows
    .map(([label, value, note]) => {
      const strong = label === "Банк" || label === "Итого активы";
      return `<tr${strong ? ' class="row-total"' : ""}>
        <td>${escapeHtml(label)}</td>
        <td class="${value < 0 ? "loss" : ""}">${money(value)}</td>
        <td class="na">${escapeHtml(note)}</td>
      </tr>`;
    })
    .join("");
}

function renderManual(state) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = value ?? "";
  };
  set("manualYoupin", state.manual.youpin);
  set("manualSkinbux", state.manual.skinbux);
  set("manualCash", state.manual.cash);
  set("manualOverpay", state.manual.overpay);
  set("manualCsfloat", state.manual.csfloat);
}

function renderPeople(preview) {
  document.getElementById("peopleBody").innerHTML = preview.rows.length
    ? preview.rows
        .map(
          (r) => `<tr>
            <td>${escapeHtml(r.name)}${r.isManager ? ' <span class="na">(управляющий)</span>' : ""}</td>
            <td>${money(r.opening)}</td>
            <td>${percent(r.share)}</td>
            <td>${r.deposited ? money(r.deposited) : '<span class="na">—</span>'}</td>
            <td>${r.withdrawn ? money(r.withdrawn) : '<span class="na">—</span>'}</td>
            <td class="${r.profit >= 0 ? "profit" : "loss"}">${money(r.profit)}</td>
            <td>${money(r.closing)}</td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="7" class="empty-row">Участники ещё не заведены — открой блок настроек ниже.</td></tr>';

  const parts = [
    `Прибыль периода ${money(preview.profit)} = банк ${money(preview.bankTotal)} − было ${money(preview.openingTotal)}`,
  ];
  if (preview.deposits) parts.push(`− внесено ${money(preview.deposits)}`);
  if (preview.withdrawals) parts.push(`+ выведено ${money(preview.withdrawals)}`);
  if (preview.personalSpend) parts.push(`+ мои личные траты ${money(preview.personalSpend)}`);
  if (preview.personalIncome) parts.push(`− мой доход извне ${money(preview.personalIncome)}`);
  parts.push(`Инвестору идёт его доля × прибыль × ${100 - preview.managerFeePct}%.`);
  if (Math.abs(preview.mismatch) > 0.05) parts.push(`⚠ балансы не сходятся с банком на ${money(preview.mismatch)}`);
  document.getElementById("peopleHint").textContent = parts.join(" ");
}

function renderSetup(state) {
  document.getElementById("managerFeeInput").value = state.managerFeePct;
  document.getElementById("steamIdInput").value = state.steamId;
  if (!setupRows.length) setupRows = state.participants.map((p) => ({ ...p }));
  drawSetupRows();

  const select = document.getElementById("movePerson");
  select.innerHTML = state.participants.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}

function drawSetupRows() {
  document.getElementById("setupBody").innerHTML = setupRows
    .map(
      (p, i) => `<tr>
        <td><input data-field="name" data-i="${i}" type="text" value="${escapeHtml(p.name)}" /></td>
        <td><input data-field="balance" data-i="${i}" type="number" step="0.01" value="${p.balance ?? 0}" /></td>
        <td><input data-field="isManager" data-i="${i}" type="radio" name="manager" ${p.isManager ? "checked" : ""} /></td>
        <td><button class="btn-small btn-secondary" data-remove="${i}">Убрать</button></td>
      </tr>`
    )
    .join("");

  document.querySelectorAll("#setupBody input").forEach((input) => {
    input.addEventListener("change", () => {
      const row = setupRows[Number(input.getAttribute("data-i"))];
      const field = input.getAttribute("data-field");
      if (field === "isManager") setupRows.forEach((p, i) => (p.isManager = i === Number(input.getAttribute("data-i"))));
      else row[field] = field === "balance" ? Number(input.value) : input.value;
      if (field === "isManager") drawSetupRows();
    });
  });
  document.querySelectorAll("#setupBody [data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setupRows.splice(Number(btn.getAttribute("data-remove")), 1);
      drawSetupRows();
    });
  });
}

const MOVE_LABELS = {
  deposit: "внёс",
  withdrawal: "вывел",
  personal_spend: "личные траты",
  personal_income: "доход извне",
};

function renderMovements(state, preview) {
  const byId = Object.fromEntries(state.participants.map((p) => [p.id, p.name]));
  document.getElementById("movesBody").innerHTML = preview.movements.length
    ? preview.movements
        .map(
          (m) => `<tr>
            <td>${fmtDate(m.date)}</td>
            <td>${escapeHtml(byId[m.participantId] || "—")}</td>
            <td>${escapeHtml(MOVE_LABELS[m.type] || m.type)}</td>
            <td>${money(m.amount)}</td>
            <td>${escapeHtml(m.note)}</td>
            <td><button class="btn-small btn-secondary" data-del="${m.id}">Удалить</button></td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="6" class="empty-row">С прошлого расчёта движений не было.</td></tr>';

  document.querySelectorAll("#movesBody [data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/capital/movement/${btn.getAttribute("data-del")}`, { method: "DELETE" });
        await load();
      } catch (err) {
        showError(`Не удалось удалить: ${err.message}`);
      }
    });
  });
}

function renderHistory(state) {
  const periods = [...state.periods].reverse();
  document.getElementById("historyBody").innerHTML = periods.length
    ? periods
        .map(
          (p) => `<tr>
            <td>${fmtDate(p.closedAt)}</td>
            <td>${money(p.bankTotal)}</td>
            <td class="${p.profit >= 0 ? "profit" : "loss"}">${money(p.profit)}</td>
            <td>${p.rows.map((r) => `${escapeHtml(r.name)} ${money(r.profit)}`).join(" · ")}</td>
            <td>${escapeHtml(p.note)}</td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="5" class="empty-row">Ещё ни одного закрытого периода.</td></tr>';
}

// ---- Действия ----

document.getElementById("refreshBtn").addEventListener("click", () => load({ refresh: true }));

document.getElementById("manualSaveBtn").addEventListener("click", async () => {
  const value = (id) => {
    const raw = document.getElementById(id).value;
    return raw === "" ? null : Number(raw);
  };
  try {
    await api("/api/capital/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youpin: value("manualYoupin") ?? 0,
        skinbux: value("manualSkinbux") ?? 0,
        cash: value("manualCash") ?? 0,
        overpay: value("manualOverpay") ?? 0,
        csfloat: value("manualCsfloat"),
      }),
    });
    document.getElementById("manualStatus").textContent = "сохранено";
    setTimeout(() => (document.getElementById("manualStatus").textContent = ""), 2000);
    await load();
  } catch (err) {
    showError(`Не сохранилось: ${err.message}`);
  }
});

document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
  try {
    await api("/api/capital/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        managerFeePct: Number(document.getElementById("managerFeeInput").value),
        steamId: document.getElementById("steamIdInput").value.trim(),
      }),
    });
    await load();
  } catch (err) {
    showError(`Настройки не сохранились: ${err.message}`);
  }
});

document.getElementById("addPersonBtn").addEventListener("click", () => {
  setupRows.push({ name: "", balance: 0, isManager: !setupRows.some((p) => p.isManager) });
  drawSetupRows();
});

document.getElementById("savePeopleBtn").addEventListener("click", async () => {
  try {
    await api("/api/capital/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: setupRows }),
    });
    setupRows = [];
    await load();
  } catch (err) {
    showError(`Участники не сохранились: ${err.message}`);
  }
});

document.getElementById("moveAddBtn").addEventListener("click", async () => {
  const amount = Number(document.getElementById("moveAmount").value);
  if (!amount) return showError("Впиши сумму движения");
  try {
    await api("/api/capital/movement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: document.getElementById("movePerson").value,
        type: document.getElementById("moveType").value,
        amount,
        date: document.getElementById("moveDate").value || undefined,
        note: document.getElementById("moveNote").value,
      }),
    });
    document.getElementById("moveAmount").value = "";
    document.getElementById("moveNote").value = "";
    await load();
  } catch (err) {
    showError(`Не записалось: ${err.message}`);
  }
});

// Закрытие периода переставляет балансы всем — спрашиваем прямо, с цифрами.
document.getElementById("closeBtn").addEventListener("click", async () => {
  if (!data) return;
  const { preview } = data;
  const lines = preview.rows.map((r) => `${r.name}: ${money(r.profit)} → баланс ${money(r.closing)}`).join("\n");
  if (!confirm(`Закрыть период?\n\nПрибыль ${money(preview.profit)}\n\n${lines}\n\nБалансы участников изменятся, движения уйдут в историю.`)) return;

  const btn = document.getElementById("closeBtn");
  btn.disabled = true;
  document.getElementById("closeStatus").textContent = "считаю банк заново...";
  try {
    await api("/api/capital/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: document.getElementById("closeNote").value }),
    });
    document.getElementById("closeNote").value = "";
    document.getElementById("closeStatus").textContent = "период закрыт";
    await load();
  } catch (err) {
    showError(`Период не закрыт: ${err.message}`);
    document.getElementById("closeStatus").textContent = "";
  }
  btn.disabled = false;
});

document.getElementById("moveDate").value = new Date().toISOString().slice(0, 10);
load();
