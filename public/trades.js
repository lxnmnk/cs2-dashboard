const SOURCE_LABELS = {
  csfloat: "CSFloat",
  youpin: "Youpin898",
  buff: "Buff163",
  skinbux: "Skinbux",
  csmoney: "CS.Money",
  trade: "Direct Trade",
  gabenmarket: "Gaben.Market",
};

const errorBox = document.getElementById("errorBox");
const updatedAtEl = document.getElementById("updatedAt");

let lastTrades = [];
let selectedItem = null; // { marketHashName, name, wear } chosen from autocomplete

// ---- "Where to sell" modal ----
const MARKET_FILTER_KEY = "trades_market_filter_v1";
const SIDE_FILTER_KEY = "trades_side_filter_v1";
const ALL_MARKETS = ["csfloat", "youpin", "buff", "skinbux", "csmoney"];
const ALL_SIDES = ["bid", "ask"]; // bid = Instant, ask = List

function loadMarketFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(MARKET_FILTER_KEY));
    if (saved && typeof saved === "object") return saved;
  } catch {}
  return Object.fromEntries(ALL_MARKETS.map((m) => [m, true])); // default: all checked
}

function saveMarketFilter() {
  localStorage.setItem(MARKET_FILTER_KEY, JSON.stringify(marketFilter));
}

function loadSideFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIDE_FILTER_KEY));
    if (saved && typeof saved === "object") return saved;
  } catch {}
  return Object.fromEntries(ALL_SIDES.map((s) => [s, true])); // default: all checked
}

function saveSideFilter() {
  localStorage.setItem(SIDE_FILTER_KEY, JSON.stringify(sideFilter));
}

let marketFilter = loadMarketFilter();
let sideFilter = loadSideFilter();
let modalTradeId = null;

const tradeModal = document.getElementById("tradeModal");

function openTradeModal(trade) {
  modalTradeId = trade.id;
  document.getElementById("modalItemName").textContent = `${trade.name} — ${trade.wear}`;

  const lockText = trade.isLocked
    ? `🔒 ${trade.daysLeft >= 2 ? `${trade.daysLeft}d` : `${trade.hoursLeft}h`} left`
    : "✅ sellable";
  document.getElementById("modalMeta").textContent =
    `Bought on ${sourceLabel(trade.buySource)} · ${fmtMoney(trade.buyPrice)} · ${fmtDate(trade.buyDate)} · ${lockText}`;

  // Снапшот лучших цен продажи на момент покупки — сравнивай с текущими
  // вариантами ниже, чтобы увидеть, куда сдвинулся рынок с тех пор.
  const snapshotEl = document.getElementById("modalSnapshot");
  const snap = trade.buySnapshot;
  if (snap && (snap.bestBid || snap.bestAsk)) {
    const parts = [];
    if (snap.bestBid) parts.push(`Instant ${fmtMoney(snap.bestBid.price)} (${sourceLabel(snap.bestBid.source)})`);
    if (snap.bestAsk) parts.push(`List ${fmtMoney(snap.bestAsk.price)} (${sourceLabel(snap.bestAsk.source)})`);
    snapshotEl.innerHTML = `📸 At purchase: ${parts.join(" · ")}`;
    snapshotEl.style.display = "block";
  } else {
    snapshotEl.style.display = "none";
  }

  const modalPhoto = document.getElementById("modalPhoto");
  if (trade.image) {
    modalPhoto.src = trade.image;
    modalPhoto.style.display = "block";
  } else {
    modalPhoto.style.display = "none";
  }

  document.querySelectorAll(".modal-filters input[data-market]").forEach((cb) => {
    cb.checked = !!marketFilter[cb.dataset.market];
  });
  document.querySelectorAll(".modal-filters input[data-side]").forEach((cb) => {
    cb.checked = !!sideFilter[cb.dataset.side];
  });

  const manualTradeBtn = document.getElementById("modalManualTradeBtn");
  manualTradeBtn.disabled = trade.isLocked;
  manualTradeBtn.title = trade.isLocked ? "Still locked by trade-hold" : "";

  hideModalSellForm();
  renderModalOptions();
  tradeModal.style.display = "flex";
}

function closeTradeModal() {
  tradeModal.style.display = "none";
  modalTradeId = null;
}

function renderModalOptions() {
  const trade = lastTrades.find((t) => t.id === modalTradeId);
  if (!trade) return;

  const options = trade.sellOptions || [];
  const isSelected = (o) => marketFilter[o.source] && sideFilter[o.side];
  const selected = options.filter(isSelected);
  const unselected = options.filter((o) => !isSelected(o));
  const bestSelected = selected[0]; // options are pre-sorted best-first by the server
  const bestUnselected = unselected[0];

  const optionsEl = document.getElementById("modalOptions");
  optionsEl.innerHTML = selected.length
    ? selected
        .map((o) => {
          const isBest = o === bestSelected;
          const profitClass = o.profitUsd >= 0 ? "profit-positive" : "profit-negative";
          // Цена в строке — уже после комиссии площадки (CSFloat 2%, Buff 1.5%),
          // то есть сколько реально придёт.
          const sideTag =
            o.side === "bid"
              ? '<span class="side-tag instant" title="Instant sell payout — guaranteed, fee already deducted">Instant</span>'
              : '<span class="side-tag list" title="Current market ask — what you\'d list it for, not guaranteed to sell, fee already deducted">List</span>';
          return `
            <div class="modal-option ${isBest ? "best" : ""}">
              <span>${isBest ? "⭐ " : ""}${sourceLabel(o.source)} ${sideTag}</span>
              <span>${fmtMoney(o.price)}</span>
              <span class="${profitClass}">${fmtMoney(o.profitUsd)} (${o.profitPercent != null ? o.profitPercent.toFixed(1) + "%" : "—"})</span>
              <button class="btn-small" data-action="sell-here" data-source="${o.source}" data-side="${o.side}" data-price="${o.gross ?? o.price}" data-fee="${o.feeRate || 0}" ${trade.isLocked ? "disabled title='Still locked by trade-hold'" : ""}>Sell here</button>
            </div>`;
        })
        .join("")
    : `<div class="empty-state">No markets selected — check at least one above</div>`;

  const calloutEl = document.getElementById("modalCallout");
  if (bestUnselected && (!bestSelected || bestUnselected.price > bestSelected.price)) {
    calloutEl.style.display = "block";
    const sideNote = bestUnselected.side === "bid" ? "instant sell" : "listing";
    calloutEl.innerHTML = `💡 <b>${sourceLabel(bestUnselected.source)}</b> isn't selected but pays more (${sideNote}): ${fmtMoney(bestUnselected.price)} (${fmtMoney(bestUnselected.profitUsd)} profit) — check it above to consider it.`;
  } else {
    calloutEl.style.display = "none";
  }

  optionsEl.querySelectorAll("[data-action='sell-here']").forEach((btn) => {
    btn.addEventListener("click", () =>
      showModalSellForm(btn.dataset.source, btn.dataset.price, btn.dataset.side, Number(btn.dataset.fee) || 0)
    );
  });
}

document.querySelectorAll(".modal-filters input[data-market]").forEach((cb) => {
  cb.addEventListener("change", () => {
    marketFilter[cb.dataset.market] = cb.checked;
    saveMarketFilter();
    renderModalOptions();
  });
});
document.querySelectorAll(".modal-filters input[data-side]").forEach((cb) => {
  cb.addEventListener("change", () => {
    sideFilter[cb.dataset.side] = cb.checked;
    saveSideFilter();
    renderModalOptions();
  });
});

document.getElementById("modalPhotoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // разрешаем повторно выбрать тот же файл
  if (!file || !modalTradeId) return;

  const formData = new FormData();
  formData.append("image", file);

  const res = await fetch(`/api/trades/${modalTradeId}/image`, { method: "POST", body: formData });
  const data = await res.json();

  if (!data.ok) {
    alert(data.error || "Не удалось загрузить фото");
    return;
  }

  const trade = lastTrades.find((t) => t.id === modalTradeId);
  if (trade) trade.image = data.trade.image;

  const modalPhoto = document.getElementById("modalPhoto");
  modalPhoto.src = `${data.trade.image}?t=${Date.now()}`; // сброс кэша при замене фото
  modalPhoto.style.display = "block";
});

document.getElementById("modalCloseBtn").addEventListener("click", closeTradeModal);
tradeModal.addEventListener("click", (e) => {
  if (e.target === tradeModal) closeTradeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && tradeModal.style.display !== "none") closeTradeModal();
});

// Модалка продажи предмета переключается между тремя видами: список вариантов
// (modalOptions), форма продажи на конкретной площадке одной ценой
// (modalSellForm) и форма прямого Steam-трейда — можно добавить несколько
// полученных предметов, как в "Add a Trade" сверху (modalTradeForm).
function showModalOptionsView() {
  const form = document.getElementById("modalSellForm");
  form.style.display = "none";
  delete form.dataset.custom;
  document.getElementById("modalTradeForm").style.display = "none";
  document.getElementById("modalManualTradeBtn").style.display = "inline-block";
  document.getElementById("modalOtherSourceBtn").style.display = "inline-block";
  document.getElementById("modalOptions").style.display = "flex";
  renderModalOptions(); // пересчитать callout и т.п. на случай, если он был скрыт
}

// Под ценой продажи — сколько реально придёт после комиссии площадки. Сервер
// вычитает ту же комиссию сам, здесь только показываем.
function updateModalSellNet() {
  const el = document.getElementById("modalSellNet");
  const feeRate = Number(document.getElementById("modalSellForm").dataset.feeRate) || 0;
  const price = parseFloat(document.getElementById("modalSellPrice").value);
  if (!feeRate || !(price > 0)) {
    el.textContent = "";
    return;
  }
  const net = Math.round(price * (1 - feeRate) * 100) / 100;
  el.textContent = `−${(feeRate * 100).toFixed(1).replace(/\.0$/, "")}% fee → you get ${fmtMoney(net)}`;
}
document.getElementById("modalSellPrice").addEventListener("input", updateModalSellNet);

function showModalSellForm(source, price, side, feeRate = 0) {
  document.getElementById("modalOptions").style.display = "none";
  document.getElementById("modalCallout").style.display = "none";
  document.getElementById("modalManualTradeBtn").style.display = "none";
  document.getElementById("modalOtherSourceBtn").style.display = "none";
  document.getElementById("modalTradeForm").style.display = "none";

  const form = document.getElementById("modalSellForm");
  form.dataset.source = source;
  form.dataset.side = side || "";
  document.getElementById("modalSellSummary").textContent = `Selling on ${sourceLabel(source)} for`;
  document.getElementById("modalSellPrice").value = price || "";
  document.getElementById("modalSellDate").value = nowForDatetimeLocal();
  document.getElementById("modalSellSourceInput").style.display = "none";
  document.getElementById("modalSellHoldDays").style.display = "none";
  // Продаёшь на Youpin — рядом поле в юанях с курсом.
  modalSellPriceCny.value = "";
  toggleCnyFields(form, source === "youpin");
  form.dataset.feeRate = String(feeRate || 0);
  updateModalSellNet();
  form.style.display = "flex";
}

// Продажа на площадке, которой нет в списке: название вводится руками и
// становится отдельным источником в балансах. Холд можно указать, если на
// той площадке деньги приходят не сразу.
function showModalOtherSourceForm() {
  showModalSellForm("", "", "");
  document.getElementById("modalSellSummary").textContent = "Sold on";

  const sourceInput = document.getElementById("modalSellSourceInput");
  const holdInput = document.getElementById("modalSellHoldDays");
  sourceInput.value = "";
  holdInput.value = "";
  sourceInput.style.display = "inline-block";
  holdInput.style.display = "inline-block";
  document.getElementById("modalSellForm").dataset.custom = "1";
  sourceInput.focus();
}

function hideModalSellForm() {
  showModalOptionsView();
}

document.getElementById("modalSellCancelBtn").addEventListener("click", hideModalSellForm);

// ---- Прямой Steam-трейд: несколько полученных предметов вместо одной цены ----
function createModalTradeRow() {
  const row = document.createElement("div");
  row.className = "modal-trade-row";
  row.innerHTML = `
    <div class="autocomplete-wrap">
      <input type="text" class="modal-trade-item-search" placeholder="Start typing an item name..." autocomplete="off" />
      <div class="autocomplete-list"></div>
    </div>
    <input type="number" class="modal-trade-item-price" step="0.01" min="0" placeholder="value $" />
    <button type="button" class="modal-trade-remove-btn btn-small btn-secondary" title="Remove">✕</button>
  `;
  row.selectedItem = null;

  const searchInput = row.querySelector(".modal-trade-item-search");
  const listEl = row.querySelector(".autocomplete-list");
  const priceInput = row.querySelector(".modal-trade-item-price");
  const removeBtn = row.querySelector(".modal-trade-remove-btn");

  let debounce = null;
  searchInput.addEventListener("input", () => {
    row.selectedItem = null;
    clearTimeout(debounce);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      listEl.classList.remove("open");
      return;
    }
    debounce = setTimeout(async () => {
      const res = await fetch(`/api/item-search?q=${encodeURIComponent(q)}`);
      const items = await res.json();
      renderRowAutocomplete(row, items);
    }, 200);
  });

  priceInput.addEventListener("input", updateModalTradeTotal);

  removeBtn.addEventListener("click", () => {
    row.remove();
    updateModalTradeTotal();
  });

  return row;
}

function renderRowAutocomplete(row, items) {
  const listEl = row.querySelector(".autocomplete-list");
  if (!items.length) {
    listEl.classList.remove("open");
    return;
  }
  listEl.innerHTML = items
    .map(
      (it, i) => `<div class="autocomplete-item" data-idx="${i}">
        ${escapeHtml(it.name)} <span class="wear">${escapeHtml(it.wear)}</span>
      </div>`
    )
    .join("");
  listEl.classList.add("open");

  listEl.querySelectorAll(".autocomplete-item").forEach((el, i) => {
    el.addEventListener("click", () => {
      row.selectedItem = items[i];
      row.querySelector(".modal-trade-item-search").value = `${items[i].name} (${items[i].wear})`;
      listEl.classList.remove("open");
    });
  });
}

function collectModalTradeRows(containerId) {
  return [...document.querySelectorAll(`#${containerId} .modal-trade-row`)]
    .map((row) => ({
      item: row.selectedItem,
      price: parseFloat(row.querySelector(".modal-trade-item-price").value),
    }))
    .filter((r) => r.item && Number.isFinite(r.price) && r.price > 0);
}

function updateModalTradeTotal() {
  const receivedTotal = collectModalTradeRows("modalTradeItems").reduce((sum, r) => sum + r.price, 0);
  const givenTotal = collectModalTradeRows("modalTradeGivenItems").reduce((sum, r) => sum + r.price, 0);
  document.getElementById("modalTradeReceivedTotal").textContent = fmtMoney(receivedTotal);
  document.getElementById("modalTradeGivenTotal").textContent = fmtMoney(givenTotal);
  document.getElementById("modalTradeNetTotal").textContent = fmtMoney(round2(receivedTotal - givenTotal));
}

function showModalTradeForm() {
  document.getElementById("modalOptions").style.display = "none";
  document.getElementById("modalCallout").style.display = "none";
  document.getElementById("modalManualTradeBtn").style.display = "none";
  document.getElementById("modalSellForm").style.display = "none";

  document.getElementById("modalTradeItems").innerHTML = "";
  document.getElementById("modalTradeItems").appendChild(createModalTradeRow());
  document.getElementById("modalTradeGivenItems").innerHTML = ""; // опционально, стартуем пустым
  document.getElementById("modalTradeDate").value = nowForDatetimeLocal();
  updateModalTradeTotal();
  document.getElementById("modalTradeForm").style.display = "flex";
}

function hideModalTradeForm() {
  showModalOptionsView();
}

document.getElementById("modalManualTradeBtn").addEventListener("click", showModalTradeForm);
document.getElementById("modalOtherSourceBtn").addEventListener("click", showModalOtherSourceForm);
document.getElementById("modalTradeAddItemBtn").addEventListener("click", () => {
  document.getElementById("modalTradeItems").appendChild(createModalTradeRow());
});
document.getElementById("modalTradeAddGivenBtn").addEventListener("click", () => {
  document.getElementById("modalTradeGivenItems").appendChild(createModalTradeRow());
});
document.getElementById("modalTradeCancelBtn").addEventListener("click", hideModalTradeForm);

document.getElementById("modalTradeConfirmBtn").addEventListener("click", async () => {
  const receivedItems = collectModalTradeRows("modalTradeItems");
  const givenItems = collectModalTradeRows("modalTradeGivenItems");

  if (!receivedItems.length) {
    alert("Add at least one received item with a name and value");
    return;
  }

  const dateRaw = document.getElementById("modalTradeDate").value;
  const tradeDate = dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString();
  const receivedTotal = receivedItems.reduce((sum, r) => sum + r.price, 0);
  const givenTotal = givenItems.reduce((sum, r) => sum + r.price, 0);
  // Продажная цена этого предмета = всё, что получил, минус то, что ещё
  // докинул со своей стороны — так прибыль по сделке считается верно, даже
  // если докинутый предмет никогда не был заведён как отдельная покупка.
  const mainSellPrice = round2(receivedTotal - givenTotal);
  if (mainSellPrice <= 0) {
    alert("Received value must be greater than what you also gave — check the amounts");
    return;
  }

  const sellRes = await fetch(`/api/trades/${modalTradeId}/sell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sellSource: "trade", sellPrice: mainSellPrice, sellDate: tradeDate }),
  });
  const sellData = await sellRes.json();
  if (!sellData.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not mark as sold: ${sellData.error}`;
    return;
  }

  for (const r of receivedItems) {
    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketHashName: r.item.marketHashName,
        name: r.item.name,
        wear: r.item.wear,
        buySource: "trade",
        buyPrice: r.price,
        buyDate: tradeDate,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      errorBox.style.display = "block";
      errorBox.textContent = `Sale recorded, but could not add received item "${r.item.name}": ${data.error}`;
    }
  }

  // Если докинутый предмет сам был отдельной сделкой в холдингах — закрываем
  // и её тоже (по цене, которую сам ей назначил выше). Если это был предмет,
  // никогда не заведённый в системе — его стоимость уже учтена через
  // mainSellPrice выше, отдельно закрывать нечего.
  for (const g of givenItems) {
    const existing = lastTrades.find(
      (t) => t.status === "holding" && t.id !== modalTradeId && t.marketHashName === g.item.marketHashName
    );
    if (!existing) continue;
    const res = await fetch(`/api/trades/${existing.id}/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellSource: "trade", sellPrice: g.price, sellDate: tradeDate }),
    });
    const data = await res.json();
    if (!data.ok) {
      errorBox.style.display = "block";
      errorBox.textContent = `Sale recorded, but could not close out "${g.item.name}" you also gave: ${data.error}`;
    }
  }

  errorBox.style.display = "none";
  closeTradeModal();
  await loadTrades();
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

document.getElementById("modalSellConfirmBtn").addEventListener("click", async () => {
  const form = document.getElementById("modalSellForm");
  const isCustom = form.dataset.custom === "1";
  const sellSource = isCustom ? document.getElementById("modalSellSourceInput").value.trim() : form.dataset.source;
  const sellSide = isCustom ? null : form.dataset.side || null;
  const sellHoldDays = isCustom ? document.getElementById("modalSellHoldDays").value : null;
  const sellPrice = parseFloat(document.getElementById("modalSellPrice").value);
  const sellDateRaw = document.getElementById("modalSellDate").value;

  if (isCustom && !sellSource) {
    alert("Enter where you sold it");
    return;
  }
  if (!sellPrice || sellPrice <= 0) {
    alert("Enter a sell price");
    return;
  }
  const sellDate = sellDateRaw ? new Date(sellDateRaw).toISOString() : new Date().toISOString();

  const res = await fetch(`/api/trades/${modalTradeId}/sell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sellSource, sellSide, sellPrice, sellDate, sellHoldDays }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not mark as sold: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  closeTradeModal();
  await loadTrades();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtMoney(v) {
  return v == null ? '<span class="na">—</span>' : `$${v.toFixed(2)}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString("en-US", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Свої назви маркетів (купив/продав "десь ще") вписуються руками і йдуть
// у таблиці як HTML — тому екрануємо.
function sourceLabel(src) {
  return src ? (SOURCE_LABELS[src] || escapeHtml(src)) : '<span class="na">—</span>';
}

function nowForDatetimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// ---- Item name autocomplete ----
const itemSearchInput = document.getElementById("itemSearch");
const autocompleteList = document.getElementById("autocompleteList");
let searchDebounce = null;

itemSearchInput.addEventListener("input", () => {
  selectedItem = null;
  clearTimeout(searchDebounce);
  const q = itemSearchInput.value.trim();
  if (q.length < 2) {
    autocompleteList.classList.remove("open");
    return;
  }
  searchDebounce = setTimeout(async () => {
    const res = await fetch(`/api/item-search?q=${encodeURIComponent(q)}`);
    const items = await res.json();
    renderAutocomplete(items);
  }, 200);
});

// Общий обработчик для всех автокомплитов сразу — и верхнего "Add a Trade",
// и любого числа строк внутри формы прямого трейда (modalTradeItems).
document.addEventListener("click", (e) => {
  document.querySelectorAll(".autocomplete-list.open").forEach((list) => {
    const wrap = list.closest(".autocomplete-wrap");
    if (wrap && !wrap.contains(e.target)) list.classList.remove("open");
  });
});

function renderAutocomplete(items) {
  if (!items.length) {
    autocompleteList.classList.remove("open");
    return;
  }
  autocompleteList.innerHTML = items
    .map(
      (it, i) => `<div class="autocomplete-item" data-idx="${i}">
        ${escapeHtml(it.name)} <span class="wear">${escapeHtml(it.wear)}</span>
      </div>`
    )
    .join("");
  autocompleteList.classList.add("open");

  autocompleteList.querySelectorAll(".autocomplete-item").forEach((el, i) => {
    el.addEventListener("click", () => {
      selectedItem = items[i];
      itemSearchInput.value = `${selectedItem.name} (${selectedItem.wear})`;
      autocompleteList.classList.remove("open");
    });
  });
}

// ---- Add trade ----
// "Other (type it)…" у "Bought On": замість списку — поле, куди вписуєш
// свій маркет. На балансі це не впливає (баланси рахуються з продажів).
const buySourceSelect = document.getElementById("buySourceInput");
const buySourceCustomInput = document.getElementById("buySourceCustomInput");
buySourceSelect.addEventListener("change", () => {
  const custom = buySourceSelect.value === "__other";
  buySourceCustomInput.style.display = custom ? "block" : "none";
  if (custom) buySourceCustomInput.focus();
  toggleCnyFields(buyTradeForm, buySourceSelect.value === "youpin");
});

// ---- Юани для Youpin ----
// На Youpin цены в юанях: вписываешь сумму в ¥, а поле $ пересчитывается по
// твоему курсу (сколько долларов за 10 000 ¥). Курс запоминается в этом
// браузере; в сделку всё равно сохраняется цена в долларах.
const CNY_RATE_KEY = "cnyUsdPer10000";
const DEFAULT_USD_PER_10000_CNY = 1480;
const buyTradeForm = document.querySelector("section.trade-form");
const buyPriceCnyInput = document.getElementById("buyPriceCnyInput");
const modalSellPriceCny = document.getElementById("modalSellPriceCny");
const cnyRateInputs = document.querySelectorAll(".cny-rate-input");

function getUsdPer10000Cny() {
  try {
    const v = Number(localStorage.getItem(CNY_RATE_KEY));
    return v > 0 ? v : DEFAULT_USD_PER_10000_CNY;
  } catch {
    return DEFAULT_USD_PER_10000_CNY;
  }
}

function fillUsdFromCny(cnyInput, usdInput) {
  const cny = parseFloat(cnyInput.value);
  if (cny > 0) {
    usdInput.value = Math.round(((cny * getUsdPer10000Cny()) / 10000) * 100) / 100;
    // Чтобы подсказка "получишь $X" под ценой продажи тоже обновилась.
    usdInput.dispatchEvent(new Event("input"));
  }
}

function toggleCnyFields(container, show) {
  container.querySelectorAll(".cny-field").forEach((el) => {
    el.style.display = show ? "" : "none";
  });
}

buyPriceCnyInput.addEventListener("input", () =>
  fillUsdFromCny(buyPriceCnyInput, document.getElementById("buyPriceInput"))
);
modalSellPriceCny.addEventListener("input", () =>
  fillUsdFromCny(modalSellPriceCny, document.getElementById("modalSellPrice"))
);

// Поле курса есть и в покупке, и в продаже — держим их одинаковыми, и при
// смене курса пересчитываем уже вписанные юани.
cnyRateInputs.forEach((input) => {
  input.value = getUsdPer10000Cny();
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!(v > 0)) return;
    try {
      localStorage.setItem(CNY_RATE_KEY, String(v));
    } catch {
      // приватный режим браузера — курс просто не запомнится
    }
    cnyRateInputs.forEach((other) => {
      if (other !== input) other.value = v;
    });
    fillUsdFromCny(buyPriceCnyInput, document.getElementById("buyPriceInput"));
    fillUsdFromCny(modalSellPriceCny, document.getElementById("modalSellPrice"));
  });
});

toggleCnyFields(buyTradeForm, buySourceSelect.value === "youpin");

document.getElementById("addTradeBtn").addEventListener("click", async () => {
  if (!selectedItem) {
    alert("Select an item from the autocomplete list first");
    return;
  }
  const buyPrice = parseFloat(document.getElementById("buyPriceInput").value);
  if (!buyPrice || buyPrice <= 0) {
    alert("Enter a buy price");
    return;
  }
  const buySource =
    buySourceSelect.value === "__other" ? buySourceCustomInput.value.trim() : buySourceSelect.value;
  if (!buySource) {
    alert("Type the marketplace name");
    buySourceCustomInput.focus();
    return;
  }
  const buyDateRaw = document.getElementById("buyDateInput").value;
  const buyDate = buyDateRaw ? new Date(buyDateRaw).toISOString() : new Date().toISOString();
  const unlockAtRaw = document.getElementById("unlockAtInput").value;
  const unlockAt = unlockAtRaw ? new Date(unlockAtRaw).toISOString() : null;
  const quantity = Math.max(1, parseInt(document.getElementById("buyQuantityInput").value, 10) || 1);

  // Несколько одинаковых предметов, купленных за одну цену в одно и то же
  // время — заводим их как отдельные строки (каждая продаётся независимо),
  // просто отправляем одинаковый запрос quantity раз подряд.
  let addedCount = 0;
  let lastError = null;
  for (let i = 0; i < quantity; i++) {
    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketHashName: selectedItem.marketHashName,
        name: selectedItem.name,
        wear: selectedItem.wear,
        buySource,
        buyPrice,
        buyDate,
        unlockAt,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      addedCount++;
    } else {
      lastError = data.error;
      break; // не пытаемся добавить остальные, если сервер уже отказал
    }
  }

  if (lastError) {
    errorBox.style.display = "block";
    errorBox.textContent =
      addedCount > 0
        ? `Added ${addedCount} of ${quantity}, then stopped: ${lastError}`
        : `Could not add trade: ${lastError}`;
  } else {
    errorBox.style.display = "none";
    itemSearchInput.value = "";
    document.getElementById("buyPriceInput").value = "";
    buyPriceCnyInput.value = "";
    document.getElementById("buyQuantityInput").value = "1";
    document.getElementById("unlockAtInput").value = "";
    selectedItem = null;
    document.getElementById("buyDateInput").value = nowForDatetimeLocal();
  }
  await loadTrades();
});

// Парсит "MM/DD/YYYY HH:MM" (то, что показывает prompt-хинт из toLocaleString("en-US"))
// в ISO-строку. Возвращает null, если формат не совпал.
function parseUsDateTime(input) {
  const m = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[, ]+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, min] = m;
  return new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(2, "0")}:${min}:00`).toISOString();
}

async function editUnlockAt(id, currentIso) {
  const current = currentIso ? new Date(currentIso) : new Date();
  const hint = current.toLocaleString("en-US");
  const input = prompt(
    `Exact unlock date & time (as shown by Steam's "Tradable After").\nFormat: MM/DD/YYYY HH:MM\nCurrent: ${hint}`,
    hint
  );
  if (input === null) return;

  const iso = parseUsDateTime(input);
  if (!iso) {
    alert("Could not parse that date. Use the format MM/DD/YYYY HH:MM");
    return;
  }

  const res = await fetch(`/api/trades/${id}/unlock-at`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unlockAt: iso }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not update unlock date: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  await loadTrades();
}

async function editBuyDate(id, currentIso) {
  const current = currentIso ? new Date(currentIso) : new Date();
  const hint = current.toLocaleString("en-US");
  const input = prompt(`Buy date & time.\nFormat: MM/DD/YYYY HH:MM\nCurrent: ${hint}`, hint);
  if (input === null) return;

  const iso = parseUsDateTime(input);
  if (!iso) {
    alert("Could not parse that date. Use the format MM/DD/YYYY HH:MM");
    return;
  }

  const res = await fetch(`/api/trades/${id}/buy-date`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyDate: iso }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not update buy date: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  await loadTrades();
}

// ---- Delete ----
async function deleteTrade(id) {
  if (!confirm("Permanently delete this record?")) return;
  const res = await fetch(`/api/trades/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not delete: ${data.error}`;
    return;
  }
  selectedIds.delete(id);
  updateBulkDeleteBar();
  await loadTrades();
}

// ---- Bulk delete: checkboxes work across both tables (Holdings + Sale
// History) into one shared selection, so you can wipe out several bought-in-
// bulk duplicates or old test rows in one go instead of one-by-one. ----
const selectedIds = new Set();

function updateBulkDeleteBar() {
  const bar = document.getElementById("bulkDeleteBar");
  const count = selectedIds.size;
  if (count === 0) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  document.getElementById("bulkDeleteCount").textContent = `${count} selected`;
}

function toggleSelected(id, checked) {
  if (checked) selectedIds.add(id);
  else selectedIds.delete(id);
  updateBulkDeleteBar();
}

function wireSelectAll(checkboxId, rowSelector) {
  document.getElementById(checkboxId).addEventListener("change", (e) => {
    document.querySelectorAll(rowSelector).forEach((cb) => {
      cb.checked = e.target.checked;
      toggleSelected(cb.dataset.id, e.target.checked);
    });
  });
}

document.getElementById("bulkDeleteBtn").addEventListener("click", async () => {
  const count = selectedIds.size;
  if (!count) return;
  if (!confirm(`Permanently delete ${count} record${count > 1 ? "s" : ""}? This cannot be undone.`)) return;

  const ids = [...selectedIds];
  let failed = 0;
  for (const id of ids) {
    const res = await fetch(`/api/trades/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) selectedIds.delete(id);
    else failed++;
  }

  if (failed) {
    errorBox.style.display = "block";
    errorBox.textContent = `Deleted ${count - failed} of ${count} — ${failed} failed.`;
  } else {
    errorBox.style.display = "none";
  }
  updateBulkDeleteBar();
  await loadTrades();
});

document.getElementById("bulkDeleteClearBtn").addEventListener("click", () => {
  selectedIds.clear();
  document.querySelectorAll(".row-select").forEach((cb) => (cb.checked = false));
  document.getElementById("holdingSelectAll").checked = false;
  document.getElementById("soldSelectAll").checked = false;
  updateBulkDeleteBar();
});

wireSelectAll("holdingSelectAll", "#holdingBody .row-select");
wireSelectAll("soldSelectAll", "#soldBody .row-select");

// ---- Render ----
// Simple row: name/quality/bought-on/price/date/lock. Click anywhere on the
// row (except a button) opens the "where to sell" modal with per-market
// prices. Delete stays a quick row-level action.
function renderHolding(rows) {
  const tbody = document.getElementById("holdingBody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No open positions yet — add a purchase above</td></tr>`;
    document.getElementById("holdingSelectAll").checked = false;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const lockCell = r.isLocked
        ? `<span class="lock-badge locked" title="Unlocks: ${fmtDate(r.unlockAt)}">🔒 ${r.daysLeft >= 2 ? `${r.daysLeft}d left` : `${r.hoursLeft}h left`}</span>`
        : `<span class="lock-badge unlocked" title="Unlocked: ${fmtDate(r.unlockAt)}">✅ sellable</span>`;
      const checked = selectedIds.has(r.id) ? "checked" : "";

      return `
        <tr data-row-key="${r.id}">
          <td><input type="checkbox" class="row-select" data-id="${r.id}" ${checked} /></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.wear)}</td>
          <td>${sourceLabel(r.buySource)}</td>
          <td>${fmtMoney(r.buyPrice)}</td>
          <td>${fmtDate(r.buyDate)} <button class="btn-small btn-secondary" data-action="edit-buy-date" data-id="${r.id}" title="Edit buy date">✎</button></td>
          <td>${lockCell} <button class="btn-small btn-secondary" data-action="edit-unlock" data-id="${r.id}" title="Set exact time from Steam">✎</button></td>
          <td><button class="btn-small btn-danger" data-action="delete" data-id="${r.id}">Delete</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-row-key]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("input")) return; // edit/delete/checkbox handle their own click
      const trade = lastTrades.find((t) => t.id === tr.dataset.rowKey);
      if (trade) openTradeModal(trade);
    });
  });
  tbody.querySelectorAll(".row-select").forEach((cb) => {
    cb.addEventListener("change", () => toggleSelected(cb.dataset.id, cb.checked));
  });
  tbody.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", () => deleteTrade(btn.dataset.id));
  });
  tbody.querySelectorAll("[data-action='edit-unlock']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trade = lastTrades.find((t) => t.id === btn.dataset.id);
      editUnlockAt(btn.dataset.id, trade?.unlockAt);
    });
  });
  tbody.querySelectorAll("[data-action='edit-buy-date']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trade = lastTrades.find((t) => t.id === btn.dataset.id);
      editBuyDate(btn.dataset.id, trade?.buyDate);
    });
  });
}

function renderSold(rows) {
  const tbody = document.getElementById("soldBody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No sales yet</td></tr>`;
    document.getElementById("soldSelectAll").checked = false;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const profitClass = r.profitUsd >= 0 ? "profit-positive" : "profit-negative";
      const holdDays = Math.round((new Date(r.sellDate) - new Date(r.buyDate)) / (24 * 60 * 60 * 1000));
      const checked = selectedIds.has(r.id) ? "checked" : "";
      return `
        <tr>
          <td><input type="checkbox" class="row-select" data-id="${r.id}" ${checked} /></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.wear)}</td>
          <td>${sourceLabel(r.buySource)} · ${fmtMoney(r.buyPrice)} · ${fmtDate(r.buyDate)}</td>
          <td>${sourceLabel(r.sellSource)} · ${fmtMoney(r.sellPrice)} · ${fmtDate(r.sellDate)}</td>
          <td class="${profitClass}">${fmtMoney(r.profitUsd)}</td>
          <td class="${profitClass}">${r.profitPercent != null ? r.profitPercent.toFixed(1) + "%" : '<span class="na">—</span>'}</td>
          <td>${holdDays}</td>
          <td><button class="btn-small btn-danger" data-action="delete" data-id="${r.id}">Delete</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".row-select").forEach((cb) => {
    cb.addEventListener("change", () => toggleSelected(cb.dataset.id, cb.checked));
  });
  tbody.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", () => deleteTrade(btn.dataset.id));
  });
}

function renderSummary(holding, sold) {
  document.getElementById("sumHoldingCount").textContent = holding.length;

  const invested = holding.reduce((sum, r) => sum + r.buyPrice, 0);
  document.getElementById("sumInvested").textContent = `$${invested.toFixed(2)}`;

  const unrealized = holding.reduce((sum, r) => sum + (r.profitUsd ?? 0), 0);
  const unrealizedEl = document.getElementById("sumUnrealized");
  unrealizedEl.textContent = `$${unrealized.toFixed(2)}`;
  unrealizedEl.className = "value " + (unrealized >= 0 ? "profit-positive" : "profit-negative");

  const realized = sold.reduce((sum, r) => sum + r.profitUsd, 0);
  const realizedEl = document.getElementById("sumRealized");
  realizedEl.textContent = `$${realized.toFixed(2)} (${sold.length})`;
  realizedEl.className = "value " + (realized >= 0 ? "profit-positive" : "profit-negative");
}

async function loadTrades() {
  const res = await fetch("/api/trades");
  const trades = await res.json();
  lastTrades = trades;

  const holding = trades.filter((t) => t.status === "holding");
  const sold = trades.filter((t) => t.status === "sold");

  renderHolding(holding);
  renderSold(sold);
  renderSummary(holding, sold);
  renderProfitByPeriod(sold);
  loadBalances();

  updatedAtEl.textContent = `Trades: ${trades.length}`;
}

// ---- Realized profit by period — same "sold" data as Sale History, summed
// for either a rolling window ending now (sellDate >= now - N days) or an
// exact calendar range picked via the "Custom" tab (sellDate within
// [from 00:00, to 23:59:59] inclusive of both days). Tabbed like the
// Balances "Volume" widget: pick a window, see Profit/Loss/Net/Daily Avg for
// it, instead of one static card per period. ----
let lastSoldForProfit = [];
let selectedProfitDays = 30;
let profitMode = "days"; // "days" | "custom"

function renderProfitByPeriod(sold) {
  lastSoldForProfit = sold;
  renderProfitPeriodCards();
}

function ymdToLocalDate(ymd, endOfDay) {
  const [y, m, d] = ymd.split("-").map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
}

function renderProfitPeriodCards() {
  const container = document.getElementById("profitByPeriodCards");
  let inPeriod, days;

  if (profitMode === "custom") {
    const fromRaw = document.getElementById("profitFromDate").value;
    const toRaw = document.getElementById("profitToDate").value;
    if (!fromRaw || !toRaw) {
      container.innerHTML = `<div class="summary-card"><div class="label">Pick both a "From" and "To" date above</div></div>`;
      return;
    }
    const from = ymdToLocalDate(fromRaw, false);
    const to = ymdToLocalDate(toRaw, true);
    inPeriod = lastSoldForProfit.filter((r) => {
      const t = new Date(r.sellDate).getTime();
      return t >= from.getTime() && t <= to.getTime();
    });
    days = Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
  } else {
    const cutoff = Date.now() - selectedProfitDays * 24 * 60 * 60 * 1000;
    inPeriod = lastSoldForProfit.filter((r) => new Date(r.sellDate).getTime() >= cutoff);
    days = selectedProfitDays;
  }

  const profit = inPeriod.filter((r) => r.profitUsd >= 0).reduce((sum, r) => sum + r.profitUsd, 0);
  const loss = inPeriod.filter((r) => r.profitUsd < 0).reduce((sum, r) => sum + -r.profitUsd, 0);
  const net = round2(profit - loss);
  const dailyAvg = round2(net / days);
  const netCls = net >= 0 ? "profit-positive" : "profit-negative";
  const dailyCls = dailyAvg >= 0 ? "profit-positive" : "profit-negative";

  container.innerHTML = `
    <div class="summary-card">
      <div class="label">Profit</div>
      <div class="value profit-positive">${fmtMoney(round2(profit))}</div>
    </div>
    <div class="summary-card">
      <div class="label">Loss</div>
      <div class="value profit-negative">${fmtMoney(round2(loss))}</div>
    </div>
    <div class="summary-card">
      <div class="label">Net Profit</div>
      <div class="value ${netCls}">${net >= 0 ? "+" : ""}${fmtMoney(net)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Daily Avg</div>
      <div class="value ${dailyCls}">${fmtMoney(dailyAvg)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Trades Sold</div>
      <div class="value">${inPeriod.length}</div>
    </div>
  `;
}

function ymdString(date) {
  return date.toISOString().slice(0, 10);
}

document.querySelectorAll("#profitPeriodTabs .period-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#profitPeriodTabs .period-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    const customRangeEl = document.getElementById("profitCustomRange");
    if (btn.dataset.days === "custom") {
      profitMode = "custom";
      customRangeEl.style.display = "flex";
      // По умолчанию — последние 7 дней, если ещё ничего не выбрано.
      const fromInput = document.getElementById("profitFromDate");
      const toInput = document.getElementById("profitToDate");
      if (!fromInput.value) fromInput.value = ymdString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
      if (!toInput.value) toInput.value = ymdString(new Date());
    } else {
      profitMode = "days";
      selectedProfitDays = parseInt(btn.dataset.days, 10);
      customRangeEl.style.display = "none";
    }
    renderProfitPeriodCards();
  });
});

document.getElementById("profitFromDate").addEventListener("change", renderProfitPeriodCards);
document.getElementById("profitToDate").addEventListener("change", renderProfitPeriodCards);

// ---- Balances — money from sales, estimated from sale history (see
// trades.js computeBalances on the server), plus Skins in Steam (auto,
// same as Invested Now) and Crypto (fully hand-entered). All rendered into
// one row of cards; edits/transfers re-render from the response instead of
// re-fetching. ----
const BALANCE_SOURCE_ORDER = ["csfloat", "youpin", "buff", "skinbux", "csmoney"];
const STEAM_CRYPTO_SOURCES = ["steam", "crypto"];
let lastBalances = {};

// CS.Money по названию отдельно — активный остаток там можно потратить
// только на предметы с отметкой Instant, это не то же самое, что "просто
// доступные деньги" на остальных площадках.
const BALANCE_LABEL_OVERRIDES = { csmoney: "CS.Money (Instant)", steam: "Skins in Steam", crypto: "Crypto" };

async function loadBalances() {
  const res = await fetch("/api/balances");
  lastBalances = await res.json();
  renderAllBalanceCards();
}

function renderAllBalanceCards() {
  renderBalances(lastBalances);
}

function balanceEditBtn(source, field, current) {
  return `<button class="btn-small btn-secondary balance-edit-btn" data-action="edit-balance" data-source="${source}" data-field="${field}" data-current="${current}" title="Edit this number by hand">✎</button>`;
}

function wireBalanceButtons(container) {
  container.querySelectorAll("[data-action='edit-balance']").forEach((btn) => {
    btn.addEventListener("click", () => editBalanceField(btn.dataset.source, btn.dataset.field, parseFloat(btn.dataset.current)));
  });
  container.querySelectorAll("[data-action='withdraw-crypto']").forEach((btn) => {
    btn.addEventListener("click", () => withdrawToCrypto(btn.dataset.source, parseFloat(btn.dataset.active)));
  });
}

// Один общий ряд карточек: биржи (только если по ним реально что-то продано)
// + Steam/Crypto (эти два — всегда, даже по нулям, см. STEAM_CRYPTO_SOURCES).
function renderBalances(balances) {
  const container = document.getElementById("balancesCards");
  const marketplaceSources = BALANCE_SOURCE_ORDER.filter((s) => balances[s]);
  // Площадки, введённые руками при продаже, в фиксированном порядке не значатся —
  // добавляем их следом, иначе деньги с них нигде не показывались бы.
  const customSources = Object.keys(balances)
    .filter((s) => !BALANCE_SOURCE_ORDER.includes(s) && !STEAM_CRYPTO_SOURCES.includes(s))
    .sort();
  const sources = [...marketplaceSources, ...customSources, ...STEAM_CRYPTO_SOURCES];

  container.innerHTML = sources
    .map((s) => {
      const b = balances[s] || { active: 0, hold: 0, frozen: 0, nextUnlockAt: null };
      const extras = [];
      if (b.hold > 0) {
        extras.push(
          `<div class="balance-extra">+${fmtMoney(b.hold)} hold · unlocks ${fmtDate(b.nextUnlockAt)} ${balanceEditBtn(s, "hold", b.hold)}</div>`
        );
      }
      if (b.frozen > 0) {
        extras.push(
          `<div class="balance-extra" title="Условие освобождения (не использовал ли покупатель свой frozen balance) не отслеживается">+${fmtMoney(b.frozen)} frozen ⚠️ ${balanceEditBtn(s, "frozen", b.frozen)}</div>`
        );
      }
      // Вывод в крипту — только для реальных площадок с активным остатком;
      // у самого Steam (это стоимость скинов, не деньги) и у Crypto (некуда
      // переводить сам в себя) кнопки нет.
      const canWithdraw = b.active > 0 && !STEAM_CRYPTO_SOURCES.includes(s);
      const withdrawBtn = canWithdraw
        ? `<button class="btn-small btn-secondary" data-action="withdraw-crypto" data-source="${s}" data-active="${b.active}" title="Move some of this active balance to Crypto">→ Crypto</button>`
        : "";
      return `
        <div class="summary-card">
          <div class="label">${BALANCE_LABEL_OVERRIDES[s] || sourceLabel(s)}</div>
          <div class="value">${fmtMoney(b.active)} ${balanceEditBtn(s, "active", b.active)}</div>
          ${extras.join("")}
          ${withdrawBtn ? `<div class="balance-extra">${withdrawBtn}</div>` : ""}
        </div>`;
    })
    .join("");

  wireBalanceButtons(container);
}

async function editBalanceField(source, field, currentValue) {
  const fieldLabel = { active: "active", hold: "hold", frozen: "frozen" }[field];
  const input = prompt(`${BALANCE_LABEL_OVERRIDES[source] || sourceLabel(source)} — set the ${fieldLabel} balance to ($):`, currentValue.toFixed(2));
  if (input === null) return;
  const value = parseFloat(input);
  if (!Number.isFinite(value)) {
    alert("Enter a valid number");
    return;
  }

  const res = await fetch(`/api/balances/${source}/adjust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, value }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not update balance: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  lastBalances = data.balances;
  renderAllBalanceCards();
}

// "У меня $1000 на скинбаксе не в холде — можно вывести на крипту": двигает
// деньги из активного остатка площадки в Crypto (тоже просто ручные цифры,
// никакого реального API вывода тут нет).
async function withdrawToCrypto(fromSource, currentActive) {
  const input = prompt(
    `Withdraw how much from ${BALANCE_LABEL_OVERRIDES[fromSource] || sourceLabel(fromSource)} to Crypto? (max $${currentActive.toFixed(2)})`,
    currentActive.toFixed(2)
  );
  if (input === null) return;
  const amount = parseFloat(input);
  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Enter a valid positive amount");
    return;
  }
  if (amount > currentActive) {
    alert(`Only $${currentActive.toFixed(2)} is active (not on hold) there`);
    return;
  }

  const res = await fetch("/api/balances/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromSource, toSource: "crypto", amount }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not withdraw: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  lastBalances = data.balances;
  renderAllBalanceCards();
}

// ---- Продажи клиентов через сайт ----
// Отдельно от моих сделок: тут видно, кто именно продал, что, когда, сколько
// мы ему должны и сколько за это заплатил Skinbux.
const SALE_STATUS_LABELS = {
  created: "waiting for the client to accept",
  pending: "waiting for the client to accept",
  hold: "accepted, funds on hold",
  completed: "funds released",
  cancelled: "cancelled",
  reverted: "reverted",
};

async function loadClientSales() {
  const res = await fetch("/api/client-sales");
  const data = await res.json();
  const body = document.getElementById("clientSalesBody");

  if (!data.sales.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty-row">Nobody has sold you anything through the site yet.</td></tr>';
    return;
  }

  body.innerHTML = data.sales
    .map((s) => {
      // Отметить выплату можно и пока деньги ещё в холде у Skinbux: бывает,
      // что клиенту платишь раньше, и без этого сумма так и висела у него.
      const canPay = !s.paidAt && (s.status === "hold" || s.status === "completed");
      let status;
      if (s.paidAt) status = `paid ${fmtDate(s.paidAt)}`;
      else if (s.status === "hold" && s.unlockAt) status = `on hold until ${fmtDate(s.unlockAt)}`;
      else if (s.status === "completed") status = "released — client can withdraw";
      else status = SALE_STATUS_LABELS[s.status] || s.status;

      let action = "";
      if (canPay) {
        action = `<button class="btn-small btn-secondary" data-action="mark-paid" data-id="${s.id}" data-status="${escapeHtml(s.status)}">Mark paid</button>`;
      } else if (s.paidAt) {
        action = `<button class="btn-small btn-secondary" data-action="unmark-paid" data-id="${s.id}">Undo</button>`;
      }

      // Номер сделки — тот же, что клиент пишет в Telegram ("Угода #..."),
      // по нему строку и находишь.
      return `
        <tr>
          <td>${fmtDate(s.createdAt)}</td>
          <td>#${escapeHtml(String(s.id))}</td>
          <td><a href="https://steamcommunity.com/profiles/${escapeHtml(s.steamId)}" target="_blank">${escapeHtml(s.customerName || s.steamId)}</a></td>
          <td>${escapeHtml(s.items.join(", "))}</td>
          <td>${fmtMoney(s.totalPrice)}</td>
          <td>${s.skinbuxTotal ? fmtMoney(s.skinbuxTotal) : '<span class="na">—</span>'}</td>
          <td class="${s.profit >= 0 ? "profit" : "loss"}">${s.skinbuxTotal ? fmtMoney(s.profit) : '<span class="na">—</span>'}</td>
          <td>${escapeHtml(status)}</td>
          <td>${action}</td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll('[data-action="mark-paid"]').forEach((btn) => {
    btn.addEventListener("click", () => markSalePaid(btn.getAttribute("data-id"), btn.getAttribute("data-status")));
  });
  body.querySelectorAll('[data-action="unmark-paid"]').forEach((btn) => {
    btn.addEventListener("click", () => unmarkSalePaid(btn.getAttribute("data-id")));
  });
}

// Пока выплата не отмечена, сделка продолжает висеть в балансе у клиента.
async function markSalePaid(id, status) {
  const question =
    status === "hold"
      ? "Skinbux hasn't released these funds yet. Mark as paid anyway? It disappears from the client's balance."
      : "Mark this payout as done? It disappears from the client's balance.";
  if (!confirm(question)) return;
  const res = await fetch(`/api/sales/${id}/paid`, { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not mark as paid: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  loadClientSales();
}

// Отмена отметки — если нажал "Mark paid" не на той сделке.
async function unmarkSalePaid(id) {
  if (!confirm("Undo the payout mark? The amount shows up in the client's balance again.")) return;
  const res = await fetch(`/api/sales/${id}/unpaid`, { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not undo: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  loadClientSales();
}

// ---- Ручные цены выкупа ----
// Цена, которую видит клиент на конкретный предмет. Пока она задана, обычная
// формула (bid скинбакса минус 5%) для этого предмета не применяется нигде —
// ни в кабинете, ни в прайс-чекере, ни при автопродаже.
const overrideSearchInput = document.getElementById("overrideSearch");
const overrideAutocompleteEl = document.getElementById("overrideAutocomplete");
let overrideSelectedName = null;
let overrideDebounce = null;

overrideSearchInput.addEventListener("input", () => {
  overrideSelectedName = null;
  clearTimeout(overrideDebounce);
  const q = overrideSearchInput.value.trim();
  if (q.length < 2) {
    overrideAutocompleteEl.classList.remove("open");
    return;
  }
  overrideDebounce = setTimeout(async () => {
    const res = await fetch(`/api/item-search?q=${encodeURIComponent(q)}`);
    const items = await res.json();
    if (!items.length) {
      overrideAutocompleteEl.classList.remove("open");
      return;
    }
    overrideAutocompleteEl.innerHTML = items
      .map((it, i) => `<div class="autocomplete-item" data-idx="${i}">${escapeHtml(it.name)} <span class="wear">${escapeHtml(it.wear)}</span></div>`)
      .join("");
    overrideAutocompleteEl.classList.add("open");
    overrideAutocompleteEl.querySelectorAll(".autocomplete-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        overrideSelectedName = items[i].marketHashName;
        overrideSearchInput.value = items[i].marketHashName;
        overrideAutocompleteEl.classList.remove("open");
      });
    });
  }, 200);
});

document.getElementById("overrideSaveBtn").addEventListener("click", async () => {
  // Имя берём из выбранной подсказки, но разрешаем и введённое руками —
  // предмета может не быть в снапшоте цен, а цену задать всё равно нужно.
  const marketHashName = overrideSelectedName || overrideSearchInput.value.trim();
  const price = parseFloat(document.getElementById("overridePrice").value);
  const note = document.getElementById("overrideNote").value.trim();

  if (!marketHashName) return alert("Pick an item");
  if (!price || price <= 0) return alert("Enter a price");

  const res = await fetch("/api/price-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketHashName, price, note }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not set price: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  overrideSearchInput.value = "";
  document.getElementById("overridePrice").value = "";
  document.getElementById("overrideNote").value = "";
  overrideSelectedName = null;
  loadOverrides();
});

async function loadOverrides() {
  const res = await fetch("/api/price-overrides");
  const data = await res.json();
  const body = document.getElementById("overridesBody");

  if (!data.items.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-row">No custom prices — everything uses the usual formula.</td></tr>';
    return;
  }

  body.innerHTML = data.items
    .map((it) => {
      // Показываем расчётную цену рядом: если ручная выше, мы платим клиенту
      // больше, чем получим сами — пусть это будет видно сразу.
      const auto = it.autoPrice != null ? fmtMoney(it.autoPrice) : '<span class="na">—</span>';
      const overpay = it.autoPrice != null && it.price > it.autoPrice;
      return `
        <tr>
          <td>${escapeHtml(it.marketHashName)}</td>
          <td class="${overpay ? "loss" : "profit"}">${fmtMoney(it.price)}</td>
          <td>${auto}</td>
          <td>${it.note ? escapeHtml(it.note) : '<span class="na">—</span>'}</td>
          <td><button class="btn-small btn-secondary" data-action="drop-override" data-name="${escapeHtml(it.marketHashName)}">Back to auto</button></td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll('[data-action="drop-override"]').forEach((btn) => {
    btn.addEventListener("click", () => dropOverride(btn.getAttribute("data-name")));
  });
}

async function dropOverride(marketHashName) {
  const res = await fetch("/api/price-overrides", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketHashName }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not reset price: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  loadOverrides();
}

document.getElementById("buyDateInput").value = nowForDatetimeLocal();
loadTrades();
setInterval(loadTrades, 60 * 1000);

// Ручные цены и продажи клиентов — только у владельца сайта; у друзей эти
// блоки не показываем и не грузим (сервер им всё равно ответит 403).
fetch("/api/me")
  .then((r) => r.json())
  .then((me) => {
    if (!me.isSiteOwner) return;
    document.getElementById("siteOwnerSections").style.display = "block";
    loadOverrides();
    loadClientSales();
    loadPricingSettings();
  });

// ---- Проценты (только владелец) ----
// Покупка: youpin + %; продажа: Skinbux − %; у трейда свои проценты на обе
// стороны — он от покупки и продажи не зависит.
const PRICING_FIELDS = {
  buyMarkupPercent: "buyMarkupInput",
  sellDiscountPercent: "sellDiscountInput",
  tradeMarkupPercent: "tradeMarkupInput",
  tradeDiscountPercent: "tradeDiscountInput",
};

async function loadPricingSettings() {
  const res = await fetch("/api/pricing-settings");
  const data = await res.json();
  if (!data.ok) return;
  for (const [field, inputId] of Object.entries(PRICING_FIELDS)) {
    document.getElementById(inputId).value = data[field];
  }
}

document.getElementById("pricingSaveBtn").addEventListener("click", async () => {
  const status = document.getElementById("pricingStatus");
  const body = {};
  for (const [field, inputId] of Object.entries(PRICING_FIELDS)) {
    body[field] = document.getElementById(inputId).value;
  }
  const res = await fetch("/api/pricing-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    status.textContent = data.error;
    return;
  }
  status.textContent =
    `Saved: buy +${data.buyMarkupPercent}%, sell −${data.sellDiscountPercent}%, ` +
    `trade +${data.tradeMarkupPercent}% / −${data.tradeDiscountPercent}%`;
  setTimeout(() => (status.textContent = ""), 5000);
});

// ---- Сворачивание разделов ----
// Страница длинная, поэтому любой раздел сворачивается кликом по заголовку.
// Прячем всё, что идёт после заголовка до следующего раздела; какие разделы
// свёрнуты — запоминаем в этом браузере.
const COLLAPSED_KEY = "mytradesCollapsedSections";

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // приватный режим — просто не запомним
  }
}

function sectionBody(title) {
  // У "Profit" заголовок лежит в строке вместе с переключателем периода —
  // тогда раздел начинается после всей строки.
  const header = title.parentElement.classList.contains("section-title-row") ? title.parentElement : title;
  const body = [];
  for (let el = header.nextElementSibling; el; el = el.nextElementSibling) {
    const isNextSection =
      el.classList.contains("section-title") ||
      el.classList.contains("section-title-row") ||
      el.querySelector(".section-title");
    if (isNextSection || el.tagName === "SCRIPT" || el.classList.contains("modal-overlay")) break;
    body.push(el);
  }
  return body;
}

function setupCollapsibleSections() {
  const collapsed = loadCollapsed();
  document.querySelectorAll(".section-title").forEach((title) => {
    if (title.closest(".modal-overlay")) return;
    const key = title.firstChild?.textContent.trim();
    if (!key) return;

    const body = sectionBody(title);
    if (!body.length) return;

    const chevron = document.createElement("span");
    chevron.className = "collapse-chevron";
    chevron.textContent = "▾";
    title.prepend(chevron);
    title.classList.add("collapsible");
    title.title = "Click to collapse / expand";

    // Запоминаем исходный display, чтобы при разворачивании вернуть как было
    // (часть блоков изначально скрыта и показывается скриптом по условию).
    const apply = (isCollapsed) => {
      title.classList.toggle("collapsed", isCollapsed);
      body.forEach((el) => {
        if (isCollapsed) {
          el.dataset.collapsedDisplay = el.style.display;
          el.style.display = "none";
        } else if ("collapsedDisplay" in el.dataset) {
          el.style.display = el.dataset.collapsedDisplay;
          delete el.dataset.collapsedDisplay;
        }
      });
    };

    apply(collapsed.has(key));
    title.addEventListener("click", (e) => {
      if (e.target.closest("a, button, input, select")) return;
      const isCollapsed = !title.classList.contains("collapsed");
      apply(isCollapsed);
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsed(collapsed);
    });
  });
}

setupCollapsibleSections();
