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
  // Банк считается по трекеру, поэтому предмет, которого там нет, в банк не
  // попадёт. Молчать об этом нельзя — это потерянные деньги. Инвестору этой
  // сверки не отдаём: чинить её всё равно нам.
  if (bank.untracked?.count) {
    problems.push(
      `В инвентаре Steam ${bank.untracked.count} предмет(ов) на ${money(bank.untracked.value)}, которых нет в My Trades — в банк они не вошли: ${bank.untracked.names.slice(0, 3).join(", ")}`
    );
  }
  showError(problems.join(" · "));

  renderBankCards(bank, preview);
  renderBankTable(bank);
  renderPeople(preview);
  renderHistory(state);
  loadProfitRange();

  // Инвестору — только смотреть: формы, движения денег и закрытие периода
  // ему не отдаёт и сервер, но и показывать их незачем.
  if (data.investor) {
    hideOwnerOnlyBlocks();
    return;
  }
  renderSetup(state);
  renderMovements(state, preview);
}

// ---- Режим инвестора ----
// Человек вложил деньги и смотрит, сколько стоит бизнес и какая часть его.
// Остальные вкладки ему закрыты на сервере, здесь просто убираем из виду всё,
// чем он всё равно не может воспользоваться.
function hideOwnerOnlyBlocks() {
  document.querySelectorAll('.subnav a[href="/arbitrage"], .subnav a[href="/mytrades"]').forEach((a) => a.remove());
  document.getElementById("setupBlock")?.remove();

  // Разделы без своего контейнера: заголовок плюс всё до следующего заголовка.
  for (const title of document.querySelectorAll(".section-title")) {
    const text = title.textContent.trim();
    if (!/^(Движения|Закрыть период)/.test(text)) continue;
    const doomed = [title];
    for (let el = title.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.classList.contains("section-title") || el.classList.contains("section-title-row")) break;
      doomed.push(el);
    }
    doomed.forEach((el) => el.remove());
  }
}

// ---- Прибыль за выбранный отрезок ----
// Складывается из дневных закрытий на сервере: раз в сутки период закрывается
// сам, и любой диапазон — это сумма готовых дней. Пересчитывать задним числом
// нечего и нельзя: доли на каждый день были свои.
let profitDays = 30;
let profitMode = "days"; // "days" | "custom"

function profitRangeParams() {
  if (profitMode === "custom") {
    const from = document.getElementById("capitalFromDate").value;
    const to = document.getElementById("capitalToDate").value;
    if (!from || !to) return null;
    return { from, to };
  }
  const to = new Date();
  const from = new Date(to.getTime() - profitDays * 86400000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

async function loadProfitRange() {
  const params = profitRangeParams();
  const cards = document.getElementById("capitalProfitCards");
  const hint = document.getElementById("capitalProfitHint");
  if (!params) {
    cards.innerHTML = "";
    hint.textContent = "Выбери обе даты";
    return;
  }

  let range;
  try {
    range = await api(`/api/capital/history?from=${params.from}&to=${params.to}`);
  } catch (err) {
    cards.innerHTML = "";
    hint.textContent = `Не удалось посчитать за период: ${err.message}`;
    return;
  }

  const cls = (v) => (v >= 0 ? "profit" : "loss");
  const tiles = [
    [`Прибыль за период`, money(range.profit), cls(range.profit)],
    ...range.rows.map((r) => [r.name + (r.isManager ? " (управляющий)" : ""), money(r.profit), cls(r.profit)]),
    ["В среднем за день", money(range.perDay), cls(range.perDay)],
  ];
  cards.innerHTML = tiles
    .map(
      ([label, value, c]) =>
        `<div class="summary-card"><div class="label">${escapeHtml(label)}</div><div class="value ${c}">${value}</div></div>`
    )
    .join("");

  hint.textContent = range.periods
    ? `Посчитано по ${range.periods} дневным расчётам: с ${fmtDate(range.firstAt)} по ${fmtDate(range.lastAt)}.`
    : "За этот отрезок расчётов ещё нет — история копится по одному дню, первый появится после ближайшей полуночи.";
}

document.getElementById("capitalPeriodTabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".period-tab");
  if (!btn) return;
  document.querySelectorAll("#capitalPeriodTabs .period-tab").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  const value = btn.dataset.days;
  profitMode = value === "custom" ? "custom" : "days";
  if (profitMode === "days") profitDays = Number(value);
  document.getElementById("capitalCustomRange").style.display = profitMode === "custom" ? "" : "none";
  loadProfitRange();
});

document.getElementById("capitalFromDate")?.addEventListener("change", loadProfitRange);
document.getElementById("capitalToDate")?.addEventListener("change", loadProfitRange);

function renderBankCards(bank, preview) {
  // У инвестора наверху стоит то, ради чего он сюда заходит: сколько стоит
  // бизнес и сколько в нём его. Остальное — кухня управляющего.
  const mine = data.you ? preview.rows.find((r) => r.id === data.you.id) : null;
  const cards = data.investor
    ? [
        ["Стоимость бизнеса", money(bank.total), ""],
        ...(mine
          ? [
              ["Твоя доля", percent(mine.share), ""],
              ["Твои деньги в деле", money(mine.closing), ""],
            ]
          : []),
      ]
    : [
        ["Банк (за вычетом долгов)", money(bank.total), ""],
        ["Прибыль периода", money(preview.profit), preview.profit >= 0 ? "profit" : "loss"],
        ["Инвесторам из неё", money(preview.investorsProfit), ""],
        ["Чужих денег вычтено", money(bank.liabilities.total), bank.liabilities.total ? "loss" : ""],
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
    // Всё ровно как в My Trades: скины по цене покупки одной строкой, балансы
    // площадок целиком — вместе с холдом и заморозкой.
    [
      "Скины",
      inv.total,
      `${inv.count} шт · из My Trades, по цене покупки${inv.locked ? ` · ${inv.locked} в трейд-бане` : ""} · по рынку сейчас ${money(inv.marketValue)}`,
    ],
    // Чужие деньги уже вычтены из строки Skinbux — там они и лежат. Имена в
    // пояснении видит только владелец.
    ...bank.money.map((m) => [m.title, m.value, (data.investor ? m.publicNote : m.note) || m.note || ""]),
    ...(bank.owedToMe ? [["Мне должны", bank.owedToMe, "из списка в My Trades"]] : []),
    ...(bank.leftoverDebt
      ? [["Ещё не выплачено", -bank.leftoverDebt, "чужих денег больше, чем лежит на Skinbux"]]
      : []),
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

function renderPeople(preview) {
  document.getElementById("peopleBody").innerHTML = preview.rows.length
    ? preview.rows
        .map(
          (r) => `<tr${data.you && r.id === data.you.id ? ' class="row-total"' : ""}>
            <td>${escapeHtml(r.name)}${r.isManager ? ' <span class="na">(управляющий)</span>' : ""}${
              data.you && r.id === data.you.id ? ' <span class="na">— это ты</span>' : ""
            }</td>
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

  if (data.investor) {
    document.getElementById("peopleHint").textContent =
      `Доля считается от банка на начало периода. Из прибыли инвестору идёт его доля × ${100 - preview.managerFeePct}%, остальное управляющему.`;
    return;
  }

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
        <td><input data-field="login" data-i="${i}" type="text" placeholder="логин на сайте" value="${escapeHtml(p.login || "")}" /></td>
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
