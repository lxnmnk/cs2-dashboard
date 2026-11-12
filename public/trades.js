const SOURCE_LABELS = {
  csfloat: "CSFloat",
  youpin: "Youpin898",
  buff: "Buff163",
  skinbux: "Skinbux",
  skinplace: "Skin.place",
  skins: "Skins.com",
  csmoney: "CS.Money",
  trade: "Direct Trade",
  gabenmarket: "Gaben.Market",
};

const errorBox = document.getElementById("errorBox");
const updatedAtEl = document.getElementById("updatedAt");

let lastTrades = [];
let isSiteOwner = false; // кнопки skin.place/skins.com работают от входа владельца — только у него
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
    `Bought on ${sourceLabel(trade.buySource)} · ${fmtMoney(trade.buyPrice)} · ${fmtDate(trade.buyDate)} · ${lockText}` +
    (trade.floatValue != null ? ` · float ${trade.floatValue.toFixed(6)}` : "");

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

  if (isSiteOwner) {
    optionsEl.insertAdjacentHTML("beforeend", BUYOUT_SOURCES.map((src) => buyoutRowHtml(trade, src)).join(""));
  }

  const calloutEl = document.getElementById("modalCallout");
  if (bestUnselected && (!bestSelected || bestUnselected.price > bestSelected.price)) {
    calloutEl.style.display = "block";
    const sideNote = bestUnselected.side === "bid" ? "instant sell" : "listing";
    calloutEl.innerHTML = `💡 <b>${sourceLabel(bestUnselected.source)}</b> isn't selected but pays more (${sideNote}): ${fmtMoney(bestUnselected.price)} (${fmtMoney(bestUnselected.profitUsd)} profit) — check it above to consider it.`;
  } else {
    calloutEl.style.display = "none";
  }

  optionsEl.querySelectorAll("[data-action='buyout-check']").forEach((btn) => {
    btn.addEventListener("click", () => checkBuyout(trade.id, btn.dataset.source));
  });

  optionsEl.querySelectorAll("[data-action='sell-here']").forEach((btn) => {
    btn.addEventListener("click", () =>
      showModalSellForm(btn.dataset.source, btn.dataset.price, btn.dataset.side, Number(btn.dataset.fee) || 0)
    );
  });
}

// ---- Skin.place и Skins.com: цена выкупа только по кнопке ----
// Общего прайса у них нет, каждая проверка — запросы к CSFloat и к площадке
// (у них свои лимиты), поэтому не грузим сами при открытии окна.
// Результат держим по позиции и площадке, пока страница открыта: закрыл-открыл
// окно — цена осталась.
const BUYOUT_SOURCES = ["skinplace", "skins"];
const buyoutResults = {}; // `${tradeId}|${source}` -> { loading } | { error } | result

function buyoutRowHtml(trade, source) {
  const r = buyoutResults[`${trade.id}|${source}`];
  const label = `${sourceLabel(source)} <span class="side-tag instant" title="Instant buyout price — what they pay right now">Instant</span>`;
  const locked = trade.isLocked ? "disabled title='Still locked by trade-hold'" : "";

  if (!r || r.error || r.loading) {
    const note = r?.error ? `<div class="buyout-note buyout-error">${escapeHtml(r.error)}</div>` : "";
    return `
      <div class="modal-option buyout-option">
        <span>${label}</span>
        <span class="na">—</span>
        <span class="section-hint">${r?.loading ? `asking CSFloat and ${sourceLabel(source)}…` : "on request"}</span>
        <button class="btn-small btn-secondary" data-action="buyout-check" data-source="${source}" ${r?.loading ? "disabled" : ""}>${
          r?.loading ? "Checking…" : r?.error ? "Retry" : "Check price"
        }</button>
      </div>${note}`;
  }

  if (r.price == null) {
    return `
      <div class="modal-option buyout-option buyout-blocked">
        <span>${label}</span>
        <span class="na">—</span>
        <span class="section-hint">not buying</span>
        <button class="btn-small btn-secondary" data-action="buyout-check" data-source="${source}" title="Ask again">↻</button>
      </div>
      <div class="buyout-note">⚠ ${escapeHtml(r.skipReason || "")}</div>`;
  }

  const profitClass = r.profitUsd >= 0 ? "profit-positive" : "profit-negative";
  const details = [
    r.matchedBy === "float" ? `same float as a CSFloat listing (${r.float.toFixed(4)})` : "same item name on CSFloat",
    r.floatRange === "any" ? "nobody sells one with a close float — any float of this wear" : null,
    r.csfloatPrice != null ? `CSFloat ask ${fmtMoney(r.csfloatPrice)}` : null,
    `checked ${new Date(r.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  ].filter(Boolean);
  return `
    <div class="modal-option buyout-option ${r.instant ? "" : "buyout-blocked"}">
      <span>${label}</span>
      <span>${fmtMoney(r.price)}</span>
      <span class="${profitClass}">${fmtMoney(r.profitUsd)} (${r.profitPercent != null ? r.profitPercent.toFixed(1) + "%" : "—"})</span>
      <span class="buyout-actions">
        <button class="btn-small btn-secondary" data-action="buyout-check" data-source="${source}" title="Ask again">↻</button>
        <button class="btn-small" data-action="sell-here" data-source="${source}" data-side="bid" data-price="${r.price}" data-fee="0" ${locked}>Sell here</button>
      </span>
    </div>
    <div class="buyout-note">${r.instant ? "" : `⚠ ${escapeHtml(r.skipReason)}<br />`}${details.join(" · ")}</div>`;
}

async function checkBuyout(tradeId, source) {
  const key = `${tradeId}|${source}`;
  buyoutResults[key] = { loading: true };
  if (modalTradeId === tradeId) renderModalOptions();
  try {
    const res = await fetch(`/api/trades/${tradeId}/buyout/${source}`, { method: "POST" });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: res.status === 504 || res.status === 502 ? `Server took too long to answer (HTTP ${res.status}) — try again` : `Server answered HTTP ${res.status}` };
    }
    buyoutResults[key] = data.ok ? data : { error: data.error || data.reason || "No price" };
  } catch (err) {
    buyoutResults[key] = { error: err.message };
  }
  if (modalTradeId === tradeId) renderModalOptions();
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
// source: "catalog" — полученные предметы, их в холдингах ещё нет, ищем по
// прайсу; "holdings" — то, что отдал: это уже заведённые позиции, поэтому
// выбираем из них, а не набираем название. Так закрывается ровно та сделка,
// которую отдал, даже если таких предметов у тебя два.
function createModalTradeRow(source = "catalog") {
  const fromHoldings = source === "holdings";
  const row = document.createElement("div");
  row.className = "modal-trade-row";
  row.innerHTML = `
    <div class="autocomplete-wrap">
      <input type="text" class="modal-trade-item-search" placeholder="${
        fromHoldings ? "Выбери свой предмет из holdings..." : "Start typing an item name..."
      }" autocomplete="off" />
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
  if (fromHoldings) {
    // Список свой, локальный — запрос на сервер не нужен. Пустое поле по
    // клику показывает все открытые позиции: обычно проще выбрать, чем
    // вспоминать название.
    const openList = () => renderHoldingsAutocomplete(row, findHoldings(searchInput.value));
    searchInput.addEventListener("focus", openList);
    searchInput.addEventListener("input", () => {
      row.selectedItem = null;
      openList();
    });
  } else {
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
  }

  priceInput.addEventListener("input", updateModalTradeTotal);
  // Набранное руками название — ещё не выбранный предмет: пересчитываем, чтобы
  // предупреждение появилось сразу, а не после правки цены.
  searchInput.addEventListener("input", updateModalTradeTotal);
  searchInput.addEventListener("blur", () => setTimeout(updateModalTradeTotal, 150)); // клик по подсказке успевает пройти

  removeBtn.addEventListener("click", () => {
    row.remove();
    updateModalTradeTotal();
  });

  return row;
}

const HOLDINGS_SHOWN = 60;

// "StatTrak™ AWP | Neo-Noir" -> "stattrak awp neo-noir": ™ и | в поиске
// никто не набирает, и из-за них "awp neo" ничего не находил.
const searchText = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[™★|()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Открытые позиции, кроме той, что сейчас продаём в окне. Каждое слово
 * запроса должно встретиться в названии, качестве или float — в любом
 * порядке: "neo glock mw" находит Glock-18 | Neo-Noir (Minimal Wear).
 */
function findHoldings(query) {
  const words = searchText(query).split(" ").filter(Boolean);
  const wearShort = { "Factory New": "fn", "Minimal Wear": "mw", "Field-Tested": "ft", "Well-Worn": "ww", "Battle-Scarred": "bs" };
  return lastTrades
    .filter((t) => t.status === "holding" && t.id !== modalTradeId)
    .filter((t) => {
      const wear = String(t.wear || "").split(" · ")[0];
      const hay = searchText(`${t.marketHashName} ${t.wear} ${wearShort[wear] || ""} ${t.floatValue ?? ""}`);
      return words.every((w) => hay.includes(w));
    });
}

function renderHoldingsAutocomplete(row, holdings) {
  const listEl = row.querySelector(".autocomplete-list");
  if (!holdings.length) {
    listEl.innerHTML = '<div class="autocomplete-item na">В holdings ничего не нашлось</div>';
    listEl.classList.add("open");
    return;
  }
  const more = holdings.length - HOLDINGS_SHOWN;
  holdings = holdings.slice(0, HOLDINGS_SHOWN);
  listEl.innerHTML =
    holdings
      .map(
        (t, i) => `<div class="autocomplete-item" data-idx="${i}">
        ${escapeHtml(t.name)} <span class="wear">${escapeHtml(t.wear)}</span>
        <span class="na">· ${t.floatValue != null ? `float ${Number(t.floatValue).toFixed(4)} · ` : ""}куплено ${fmtMoney(t.buyPrice)} ${fmtDate(t.buyDate)}</span>
      </div>`
      )
      .join("") +
    (more > 0 ? `<div class="autocomplete-item na">…и ещё ${more} — уточни поиск (например, добавь качество: mw, ft)</div>` : "");
  listEl.classList.add("open");

  listEl.querySelectorAll(".autocomplete-item[data-idx]").forEach((el, i) => {
    el.addEventListener("click", () => {
      const t = holdings[i];
      // holdingId — по нему закроем ровно эту позицию, а не первую попавшуюся
      // с таким же названием.
      row.selectedItem = { marketHashName: t.marketHashName, name: t.name, wear: t.wear, holdingId: t.id, buyPrice: t.buyPrice };
      row.querySelector(".modal-trade-item-search").value = `${t.name} (${t.wear})`;
      listEl.classList.remove("open");
      updateModalTradeTotal();
    });
  });
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
      updateModalTradeTotal();
    });
  });
}

function collectModalTradeRows(containerId) {
  return [...document.querySelectorAll(`#${containerId} .modal-trade-row`)]
    .map((row) => ({
      item: row.selectedItem,
      // Для отданных предметов известно, какую именно позицию закрывать.
      holdingId: row.selectedItem?.holdingId || null,
      price: parseFloat(row.querySelector(".modal-trade-item-price").value),
    }))
    .filter((r) => r.item && Number.isFinite(r.price) && r.price > 0);
}

/**
 * Строки, которые в сумму не попадут: предмет не выбран из подсказки (набрать
 * название мало — нужен клик) или не вписана цена. Молча выкидывать их нельзя:
 * итог тогда выходит неверным, а понять почему — никак.
 */
function findIncompleteTradeRows(containerId) {
  const kind = containerId === "modalTradeGivenItems" ? "also gave" : "received";
  const problems = [];
  for (const row of document.querySelectorAll(`#${containerId} .modal-trade-row`)) {
    const typed = row.querySelector(".modal-trade-item-search").value.trim();
    const price = parseFloat(row.querySelector(".modal-trade-item-price").value);
    const hasPrice = Number.isFinite(price) && price > 0;
    const complete = row.selectedItem && hasPrice;
    row.classList.toggle("incomplete", !!(typed || hasPrice) && !complete);
    if (complete || (!typed && !hasPrice)) continue; // пустая строка — просто ещё не заполнена

    if (!row.selectedItem && !hasPrice) problems.push(`${kind}: "${typed}" — pick it from the list and enter a value`);
    else if (!row.selectedItem) problems.push(`${kind}: "${typed}" — pick the item from the dropdown list`);
    else problems.push(`${kind}: ${row.selectedItem.name} — enter a value`);
  }
  return problems;
}

function updateModalTradeTotal() {
  const receivedTotal = collectModalTradeRows("modalTradeItems").reduce((sum, r) => sum + r.price, 0);
  const givenTotal = collectModalTradeRows("modalTradeGivenItems").reduce((sum, r) => sum + r.price, 0);
  document.getElementById("modalTradeReceivedTotal").textContent = fmtMoney(receivedTotal);
  document.getElementById("modalTradeGivenTotal").textContent = fmtMoney(givenTotal);
  document.getElementById("modalTradeNetTotal").textContent = fmtMoney(round2(receivedTotal - givenTotal));

  const problems = [...findIncompleteTradeRows("modalTradeItems"), ...findIncompleteTradeRows("modalTradeGivenItems")];
  const warningEl = document.getElementById("modalTradeWarning");
  warningEl.style.display = problems.length ? "block" : "none";
  warningEl.innerHTML = problems.length
    ? `⚠ ${problems.length} row(s) not counted — ${problems.map(escapeHtml).join("; ")}`
    : "";
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
  document.getElementById("modalTradeGivenItems").appendChild(createModalTradeRow("holdings"));
});
document.getElementById("modalTradeCancelBtn").addEventListener("click", hideModalTradeForm);

document.getElementById("modalTradeConfirmBtn").addEventListener("click", async () => {
  const receivedItems = collectModalTradeRows("modalTradeItems");
  const givenItems = collectModalTradeRows("modalTradeGivenItems");

  if (!receivedItems.length) {
    alert("Add at least one received item with a name and value");
    return;
  }

  // Недозаполненная строка раньше просто выпадала из суммы, и сделка
  // записывалась не на те деньги. Теперь говорим прямо, чего не хватает.
  const problems = [...findIncompleteTradeRows("modalTradeItems"), ...findIncompleteTradeRows("modalTradeGivenItems")];
  if (problems.length) {
    alert(`These rows are not counted yet:\n\n${problems.join("\n")}`);
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
    // Позиция выбрана из списка холдингов — закрываем ровно её. Старые
    // записи без holdingId (предмет набрали руками) ищем по названию, как
    // раньше, чтобы ничего не сломать.
    const existing = g.holdingId
      ? lastTrades.find((t) => t.id === g.holdingId)
      : lastTrades.find(
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

// Нажатие на подсказку не должно уводить фокус из поля: иначе форма
// перестаёт быть "в фокусе" ещё до того, как клик дойдёт до списка, и в
// старых браузерах без :has() он снова проваливается в блок под ним.
document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".autocomplete-item")) e.preventDefault();
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
  const floatInput = document.getElementById("floatValueInput");
  const floatValue = floatInput.value.trim();
  // Float — свойство одного конкретного предмета: у двух одинаковых скинов он
  // разный, поэтому на несколько строк сразу его вписать нельзя.
  if (floatValue && quantity > 1) {
    alert("Float belongs to one exact item — add such purchases one by one, or leave the float empty");
    floatInput.focus();
    return;
  }

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
        floatValue,
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
    floatInput.value = "";
    selectedItem = null;
    document.getElementById("buyDateInput").value = nowForDatetimeLocal();
  }
  await loadTrades();
});

// ---- Импорт покупок с CSFloat ----
// Два шага: сначала dryRun (сервер только смотрит и считает), показываем
// список и сумму, и лишь по кнопке пишем в таблицу. Уже импортированные
// сделки сервер отсеивает сам по externalId, так что повторный клик ничего
// не задваивает.
const csfloatImportBtn = document.getElementById("csfloatImportBtn");
const csfloatImportStatus = document.getElementById("csfloatImportStatus");
const csfloatImportPreview = document.getElementById("csfloatImportPreview");

async function csfloatImport(dryRun) {
  csfloatImportBtn.disabled = true;
  csfloatImportStatus.textContent = dryRun ? "Asking CSFloat..." : "Importing...";
  let data;
  try {
    const res = await fetch("/api/trades/import/csfloat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dryRun,
        days: Number(document.getElementById("csfloatImportDays").value) || 30,
        mode: document.getElementById("csfloatImportMode").value,
      }),
    });
    data = await res.json();
  } catch (err) {
    data = { ok: false, error: err.message };
  }
  csfloatImportBtn.disabled = false;
  return data;
}

csfloatImportBtn?.addEventListener("click", async () => {
  const data = await csfloatImport(true);
  if (!data.ok) {
    csfloatImportStatus.textContent = "";
    csfloatImportPreview.style.display = "none";
    errorBox.style.display = "block";
    errorBox.textContent = `CSFloat import failed: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  renderCsfloatPreview(data);
});

function renderCsfloatPreview(data) {
  const items = data.items || [];
  csfloatImportStatus.textContent = `${data.found} purchases on CSFloat, ${data.alreadyHave} already in the table${
    data.skipped ? `, ${data.skipped} entries skipped` : ""
  }`;

  if (!items.length) {
    csfloatImportPreview.style.display = "block";
    csfloatImportPreview.innerHTML = '<p class="empty-row">Nothing new to import.</p>';
    return;
  }

  const total = items.reduce((sum, it) => sum + it.buyPrice, 0);
  csfloatImportPreview.style.display = "block";
  csfloatImportPreview.innerHTML = `
    <p><b>${items.length}</b> new purchase(s), ${fmtMoney(total)} in total — all of them go in as bought on CSFloat.</p>
    <table class="trades-table">
      <thead><tr><th>Date</th><th>Item</th><th>Float</th><th>Price</th></tr></thead>
      <tbody>
        ${items
          .map(
            (it) => `<tr>
              <td>${it.buyDate ? fmtDate(it.buyDate) : '<span class="na">—</span>'}</td>
              <td>${escapeHtml(it.marketHashName)}${
                it.received === false ? ' <span class="na">(not sent yet)</span>' : ""
              }</td>
              <td>${it.floatValue != null ? it.floatValue.toFixed(6) : '<span class="na">—</span>'}</td>
              <td>${fmtMoney(it.buyPrice)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <button id="csfloatImportConfirm" class="btn-small">Add these ${items.length} to the table</button>`;

  document.getElementById("csfloatImportConfirm").addEventListener("click", async () => {
    const result = await csfloatImport(false);
    if (!result.ok) {
      errorBox.style.display = "block";
      errorBox.textContent = `CSFloat import failed: ${result.error}`;
      return;
    }
    csfloatImportPreview.style.display = "none";
    csfloatImportStatus.textContent = `Added ${result.added}${
      result.failed?.length ? `, ${result.failed.length} failed: ${result.failed[0]}` : ""
    }`;
    await loadTrades();
  });
}

// ---- Импорт продаж (Skinbux, CSFloat) ----
// Зеркало импорта покупок: там позиции открываются, тут закрываются. Блок один
// на обе площадки — отличаются только адрес и подписи. Сервер сам пропускает
// продажи клиентов через сайт — предметы в них не наши.
const SALES_ROW_LABELS = {
  match: "closes a position",
  already: "already imported",
  nomatch: "not in the tracker",
};

// Чем выбрана позиция из нескольких одинаковых скинов (см. tradeFloats.js).
const SALES_MATCH_LABELS = {
  exact: "by float — exactly the skin that was sold",
  float: "by float — this one is gone from your inventory",
  fifo: "by buy date — float of this position is unknown",
  held: "⚠ by buy date — your inventory still shows this float",
};

// Откуда известно, какой из одинаковых скинов продан. Skinbux float продажи
// не отдаёт, поэтому смотрим на инвентарь: предмет, который там всё ещё лежит,
// продать не могли. CSFloat float отдаёт — там совпадение точное.
function salesFloatNote(plan) {
  const floats = plan.floats || {};
  const parts = [];

  if (plan.byExact) parts.push(`Exact float match with the sold skin: <b>${plan.byExact}</b>.`);
  if (!plan.floatMatching) {
    parts.push(
      `Could not read your Skinbux inventory${floats.error ? ` (${escapeHtml(floats.error)})` : ""}, so identical skins without an exact float were picked by buy date only.`
    );
  } else if (plan.byFloat || plan.byFifo || plan.byHeld) {
    parts.push(
      `Picked by float: <b>${plan.byFloat || 0}</b> (gone from your inventory)` +
        `${plan.byFifo ? `, by buy date: ${plan.byFifo} (float unknown)` : ""}` +
        `${plan.byHeld ? `, <b>${plan.byHeld} questionable</b>: your inventory still shows that float` : ""}.`
    );
  }

  if (floats.filled) parts.push(`Float filled in from your inventory for ${floats.filled} position(s).`);
  if (floats.ambiguous?.length) {
    const names = floats.ambiguous.map((a) => `${escapeHtml(a.marketHashName)} (${a.positions})`).join(", ");
    parts.push(`Float still unknown where several identical skins sit together: ${names} — type it in the Holdings table to be exact.`);
  }

  return parts.length ? `<p class="na">${parts.join(" ")}</p>` : "";
}

function setupSalesImport({ prefix, label, endpoint }) {
  const btn = document.getElementById(`${prefix}ImportBtn`);
  const status = document.getElementById(`${prefix}ImportStatus`);
  const preview = document.getElementById(`${prefix}ImportPreview`);
  if (!btn) return;

  // Поправленные в предпросмотре цены покупки: holdingId -> новая цена.
  // Живут до подтверждения импорта, на сервер уходят вместе с ним.
  let buyPriceEdits = {};

  async function runImport(dryRun) {
    btn.disabled = true;
    status.textContent = dryRun ? `Asking ${label}...` : "Closing positions...";
    let data;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          days: Number(document.getElementById(`${prefix}ImportDays`).value) || 90,
          buyPrices: dryRun ? undefined : buyPriceEdits,
        }),
      });
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: err.message };
    }
    btn.disabled = false;
    return data;
  }

  function showError(error) {
    errorBox.style.display = "block";
    errorBox.textContent = `${label} import failed: ${error}`;
  }

  function render(plan) {
    const rows = (plan.rows || []).filter((r) => r.status !== "already");
    status.textContent = `${plan.matched} to close, ${plan.already} already in, ${plan.nomatch} without a position`;
    preview.style.display = "block";

    if (!rows.length) {
      preview.innerHTML = `<p class="empty-row">Nothing new to import.</p>${salesFloatNote(plan)}`;
      return;
    }

    preview.innerHTML = `
      <p><b>${plan.matched}</b> position(s) will be closed for ${fmtMoney(plan.matchedSum)}, profit ${fmtMoney(plan.profit)}${
        plan.source === "csfloat" ? " (after the 2% CSFloat fee)" : ""
      }.${
        plan.nomatch ? ` ${plan.nomatch} sold item(s) for ${fmtMoney(plan.nomatchSum)} have no position in the tracker — add them by hand if they were yours.` : ""
      }</p>
      ${salesFloatNote(plan)}
      <table class="trades-table">
        <thead><tr><th>Sold</th><th>Item</th><th>Float</th><th>Sold for</th><th>Bought for</th><th>Profit</th><th>What happens</th></tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const shownFloat = r.floatValue ?? r.soldFloat;
              return `<tr>
                <td>${fmtDate(r.soldAt)}</td>
                <td>${escapeHtml(r.marketHashName)}${r.viaSite ? ' <span class="na">via site</span>' : ""}</td>
                <td>${shownFloat != null ? Number(shownFloat).toFixed(6) : '<span class="na">—</span>'}</td>
                <td>${fmtMoney(r.price)}</td>
                <td>${
                  // Свою цену можно поправить прямо здесь: продажа уже видна, и
                  // ошибку в закупке дешевле исправить до закрытия позиции.
                  r.holdingId
                    ? `<input class="import-buy-price" type="number" step="0.01" min="0" value="${r.buyPrice ?? ""}" data-id="${escapeHtml(
                        r.holdingId
                      )}" data-price="${r.net ?? r.price}" title="Your buy price. Change it and the profit below updates; it is saved when you confirm the import." />`
                    : '<span class="na">—</span>'
                }</td>
                <td class="${r.profit >= 0 ? "profit" : "loss"}" data-profit-for="${escapeHtml(r.holdingId || "")}">${
                  r.profit != null ? fmtMoney(r.profit) : '<span class="na">—</span>'
                }</td>
                <td class="na">${escapeHtml(SALES_ROW_LABELS[r.status] || r.status)}${
                  r.matchedBy ? `, ${escapeHtml(SALES_MATCH_LABELS[r.matchedBy] || r.matchedBy)}` : ""
                }</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      ${plan.matched ? `<button class="btn-small" data-confirm-import>Close these ${plan.matched} position(s)</button>` : ""}`;

    buyPriceEdits = {};
    preview.querySelectorAll(".import-buy-price").forEach((input) => {
      const original = input.value;
      input.addEventListener("input", () => {
        const value = Number(input.value);
        const cell = preview.querySelector(`[data-profit-for="${input.dataset.id}"]`);
        if (!(value > 0)) {
          delete buyPriceEdits[input.dataset.id];
          if (cell) cell.textContent = "—";
          return;
        }
        if (input.value === original) delete buyPriceEdits[input.dataset.id];
        else buyPriceEdits[input.dataset.id] = value;

        const profit = Number(input.dataset.price) - value;
        if (cell) {
          cell.textContent = fmtMoney(Math.round(profit * 100) / 100);
          cell.className = profit >= 0 ? "profit" : "loss";
        }
      });
    });

    preview.querySelector("[data-confirm-import]")?.addEventListener("click", async () => {
      const result = await runImport(false);
      if (!result.ok) return showError(result.error);
      preview.style.display = "none";
      status.textContent = `Closed ${result.closed}${
        result.editedPrices ? `, ${result.editedPrices} buy price(s) updated` : ""
      }${result.failed?.length ? `, ${result.failed.length} failed: ${result.failed[0]}` : ""}`;
      buyPriceEdits = {};
      await loadTrades();
    });
  }

  btn.addEventListener("click", async () => {
    const data = await runImport(true);
    if (!data.ok) {
      status.textContent = "";
      preview.style.display = "none";
      return showError(data.error);
    }
    errorBox.style.display = "none";
    render(data);
  });
}

setupSalesImport({ prefix: "skinbux", label: "Skinbux", endpoint: "/api/trades/import/skinbux" });
setupSalesImport({ prefix: "csfloatSales", label: "CSFloat", endpoint: "/api/trades/import/csfloat-sales" });

// ---- Сверка с инвентарём: чего уже нет ----
// Импорт продаж закрывает только то, что продано через Skinbux. Проданное на
// Youpin или отданное в трейде из инвентаря просто исчезает, и позиция висит
// открытой. Здесь мы такие позиции показываем и подсвечиваем в таблице, а цену
// и дату продажи ты вписываешь сам — гадать за тебя тут нечего.
const inventoryCheckBtn = document.getElementById("inventoryCheckBtn");
const inventoryCheckStatus = document.getElementById("inventoryCheckStatus");
const inventoryCheckPreview = document.getElementById("inventoryCheckPreview");
let goneIds = new Set(); // позиции, которых нет в инвентаре — подсвечиваем в Holdings

inventoryCheckBtn?.addEventListener("click", async () => {
  inventoryCheckBtn.disabled = true;
  inventoryCheckStatus.textContent = "Reading your inventory...";
  let data;
  try {
    const res = await fetch("/api/trades/inventory-check", { method: "POST" });
    data = await res.json();
  } catch (err) {
    data = { ok: false, error: err.message };
  }
  inventoryCheckBtn.disabled = false;

  if (!data.ok) {
    inventoryCheckStatus.textContent = "";
    inventoryCheckPreview.style.display = "none";
    errorBox.style.display = "block";
    errorBox.textContent = `Inventory check failed: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  renderInventoryCheck(data);
});

function renderInventoryCheck(data) {
  const gone = data.rows.filter((r) => r.status === "gone");
  const unclear = data.rows.filter((r) => r.status === "unclear");
  goneIds = new Set(gone.map((r) => r.id));
  renderHolding(lastTrades.filter((t) => t.status === "holding")); // подсветить строки в Holdings

  inventoryCheckStatus.textContent =
    `${data.gone} gone, ${data.here} still there, ${data.unclear} unclear, ${data.locked} in trade ban · ${data.inventoryCount} item(s) in the inventory`;

  const notes = [];
  if (data.locked) {
    // Skinbux отдаёт только то, что можно обменять сейчас: заблокированных
    // предметов в его инвентаре нет вовсе, поэтому мы их не проверяем.
    notes.push(
      `${data.locked} position(s) for ${fmtMoney(data.lockedSum)} are under trade protection — Skinbux does not show locked items, so they are not checked.`
    );
  }
  if (data.floatsFilled) notes.push(`Float filled in from the inventory for ${data.floatsFilled} position(s).`);
  if (unclear.length) {
    notes.push(
      `${unclear.length} position(s) can't be judged: the float is unknown and identical skins are still in the inventory. Type the float in the Holdings table and run this again.`
    );
  }

  inventoryCheckPreview.style.display = "block";
  if (!gone.length) {
    inventoryCheckPreview.innerHTML = `<p>Everything we could check is still in your inventory.</p>${
      notes.length ? `<p class="na">${notes.map(escapeHtml).join(" ")}</p>` : ""
    }`;
    return;
  }

  inventoryCheckPreview.innerHTML = `
    <p><b>${gone.length}</b> position(s) for ${fmtMoney(data.goneSum)} are no longer in your inventory — looks sold. Fill in the price and date yourself.</p>
    ${notes.length ? `<p class="na">${notes.map(escapeHtml).join(" ")}</p>` : ""}
    <table class="trades-table">
      <thead><tr><th>Item</th><th>Float</th><th>Bought</th><th>How we know</th><th></th></tr></thead>
      <tbody>
        ${gone
          .map(
            (r) => `<tr>
              <td>${escapeHtml(r.name || r.marketHashName)} <span class="na">${escapeHtml(r.wear || "")}</span></td>
              <td>${r.floatValue != null ? r.floatValue.toFixed(6) : '<span class="na">—</span>'}</td>
              <td>${sourceLabel(r.buySource)} · ${fmtMoney(r.buyPrice)} · ${fmtDate(r.buyDate)}</td>
              <td class="na">${r.reason === "float" ? "its float is gone from the inventory" : "no item with this name left in the inventory"}</td>
              <td><button class="btn-small" data-action="sell-gone" data-id="${r.id}">Mark as sold</button></td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  inventoryCheckPreview.querySelectorAll("[data-action='sell-gone']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trade = lastTrades.find((t) => t.id === btn.dataset.id);
      if (trade) openTradeModal(trade);
    });
  });
}

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
// Float позиции: по нему импорт продаж со Skinbux отличает два одинаковых
// скина друг от друга. Приходит сам с CSFloat, подтягивается из инвентаря при
// импорте продаж, остальное можно вписать руками.
function floatCell(r) {
  const value = r.floatValue != null ? r.floatValue.toFixed(6) : '<span class="na">—</span>';
  return `${value} <button class="btn-small btn-secondary" data-action="edit-float" data-id="${r.id}" title="Edit float">✎</button>`;
}

// Цена, по которой позиция стоит на публичной витрине. Пусто — считается
// по формуле; вписанное число её перебивает.
function askPriceCell(r) {
  const value =
    r.askPrice != null
      ? `<b class="profit">${fmtMoney(r.askPrice)}</b>`
      : '<span class="na">auto</span>';
  return `${value} <button class="btn-small btn-secondary" data-action="edit-ask" data-id="${r.id}" title="Set the price for the Our Skins page">✎</button>`;
}

function renderHolding(rows) {
  const tbody = document.getElementById("holdingBody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No open positions yet — add a purchase above</td></tr>`;
    document.getElementById("holdingSelectAll").checked = false;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const lockCell = r.isLocked
        ? `<span class="lock-badge locked" title="Unlocks: ${fmtDate(r.unlockAt)}">🔒 ${r.daysLeft >= 2 ? `${r.daysLeft}d left` : `${r.hoursLeft}h left`}</span>`
        : `<span class="lock-badge unlocked" title="Unlocked: ${fmtDate(r.unlockAt)}">✅ sellable</span>`;
      const checked = selectedIds.has(r.id) ? "checked" : "";

      // Сверка с инвентарём отметила позицию как исчезнувшую — предмета на
      // аккаунте нет, строку видно сразу, без поиска по списку.
      const gone = goneIds.has(r.id);

      return `
        <tr data-row-key="${r.id}"${gone ? ' class="row-gone"' : ""}>
          <td><input type="checkbox" class="row-select" data-id="${r.id}" ${checked} /></td>
          <td>${escapeHtml(r.name)}${
            gone ? ' <span class="gone-badge" title="Not in your inventory any more — looks sold">not in inventory</span>' : ""
          }</td>
          <td>${escapeHtml(r.wear)}</td>
          <td class="float-cell">${floatCell(r)}</td>
          <td>${sourceLabel(r.buySource)}</td>
          <td>${fmtMoney(r.buyPrice)}</td>
          <td>${askPriceCell(r)}</td>
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
  tbody.querySelectorAll("[data-action='edit-float']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trade = lastTrades.find((t) => t.id === btn.dataset.id);
      editFloat(btn.dataset.id, trade?.floatValue);
    });
  });
  tbody.querySelectorAll("[data-action='edit-ask']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trade = lastTrades.find((t) => t.id === btn.dataset.id);
      editAskPrice(btn.dataset.id, trade?.askPrice);
    });
  });
}

async function editClientPaid(id, current, stillOwed) {
  const input = prompt(
    "How much of this purchase is already paid to the client, in dollars." +
      (stillOwed != null ? `\nStill owed right now: $${Number(stillOwed).toFixed(2)}.` : "") +
      "\nLeave empty or type 0 if nothing was paid yet.",
    current ? String(current) : ""
  );
  if (input === null) return;

  const value = input.trim();
  if (value && !(Number(value) >= 0)) {
    alert("Amount must be a number, zero or more");
    return;
  }

  const res = await fetch(`/api/trades/${id}/client-paid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientPaid: value === "" ? 0 : Number(value) }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert(data.error);
    return;
  }
  loadClientSales();
  loadTrades();
}

async function editAskPrice(id, current) {
  const input = prompt(
    "Price for this item on the public Our Skins page, in dollars.\nLeave empty to go back to the calculated one (Youpin + bracket percent, never below the Skinbux buyback).",
    current != null ? String(current) : ""
  );
  if (input === null) return;

  const value = input.trim();
  if (value && !(Number(value) > 0)) {
    alert("Price must be a positive number");
    return;
  }

  const res = await fetch(`/api/trades/${id}/ask-price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ askPrice: value === "" ? null : Number(value) }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not save: ${data.error}`;
    return;
  }
  errorBox.style.display = "none";
  loadTrades();
}

async function editFloat(id, current) {
  const input = prompt(
    "Float of this exact item (0 to 1). Leave empty to clear.\nThe Skinbux sales import uses it to tell identical skins apart.",
    current != null ? String(current) : ""
  );
  if (input === null) return;

  const value = input.trim();
  if (value && !(Number(value) >= 0 && Number(value) <= 1)) {
    alert("Float must be a number between 0 and 1");
    return;
  }

  const res = await fetch(`/api/trades/${id}/float`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ floatValue: value }),
  });
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not save float: ${data.error}`;
    return;
  }
  await loadTrades();
}

function renderSold(rows) {
  const tbody = document.getElementById("soldBody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No sales yet</td></tr>`;
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
          <td>${r.floatValue != null ? r.floatValue.toFixed(6) : '<span class="na">—</span>'}</td>
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
  renderDebtsCard();
}

// ---- Долги в нашу сторону ----
// Деньги, которых не видно ниоткуда: площадки о них не знают, в инвентаре их
// нет, в трекере тоже. Отдал скин под обещание заплатить — сумма вышла из
// оборота, но не пропала. Ведётся руками, иначе в капитале её просто нет.
let lastDebts = { debts: [], total: 0, count: 0 };

async function loadDebts() {
  const res = await fetch("/api/debts");
  lastDebts = await res.json();
  renderDebts();
  renderDebtsCard();
}

// Карточка живёт в общем ряду балансов, который перерисовывается целиком и
// своими данными, поэтому пересобираем её отдельно — и обязательно убирая
// прежнюю, иначе после каждого обновления в ряду копилась ещё одна.
function renderDebtsCard() {
  const container = document.getElementById("balancesCards");
  if (!container) return;
  container.querySelector("#debtsCard")?.remove();
  container.insertAdjacentHTML(
    "beforeend",
    `<div class="summary-card" id="debtsCard">
      <div class="label">Owed to me</div>
      <div class="value">${fmtMoney(lastDebts.total || 0)}</div>
      <div class="balance-extra">${lastDebts.count || 0} unpaid · hand-entered, see the list below</div>
    </div>`
  );
}

function renderDebts() {
  const body = document.getElementById("debtsBody");
  if (!body) return;

  // Подсказка в поле "кто должен": обычно это одни и те же люди.
  const names = [...new Set((lastDebts.debts || []).map((d) => d.who))];
  document.getElementById("debtWhoList").innerHTML = names
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");

  if (!lastDebts.debts?.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">Nobody owes you anything — or nothing is written down yet</td></tr>';
    return;
  }

  body.innerHTML = lastDebts.debts
    .map(
      (d) => `<tr${d.repaidAt ? ' class="debt-repaid"' : ""}>
        <td>${escapeHtml(d.who)}</td>
        <td>${fmtMoney(d.amount)}</td>
        <td>${fmtDate(d.date)}</td>
        <td>${escapeHtml(d.note || "")}</td>
        <td>${d.repaidAt ? `<span class="na">paid back ${fmtDate(d.repaidAt)}</span>` : "<b>owes</b>"}</td>
        <td>
          <button class="btn-small btn-secondary" data-action="debt-toggle" data-id="${d.id}" data-repaid="${!!d.repaidAt}">${
            d.repaidAt ? "Still owes" : "Paid back"
          }</button>
          <button class="btn-small btn-danger" data-action="debt-delete" data-id="${d.id}">Delete</button>
        </td>
      </tr>`
    )
    .join("");

  body.querySelectorAll("[data-action='debt-toggle']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await debtRequest(`/api/debts/${btn.dataset.id}/repaid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repaid: btn.dataset.repaid !== "true" }),
      });
    });
  });
  body.querySelectorAll("[data-action='debt-delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this record?")) return;
      await debtRequest(`/api/debts/${btn.dataset.id}`, { method: "DELETE" });
    });
  });
}

async function debtRequest(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!data.ok) {
    errorBox.style.display = "block";
    errorBox.textContent = `Could not save: ${data.error}`;
    return false;
  }
  errorBox.style.display = "none";
  await loadDebts();
  return true;
}

document.getElementById("debtAddBtn")?.addEventListener("click", async () => {
  const who = document.getElementById("debtWhoInput").value.trim();
  const amount = parseFloat(document.getElementById("debtAmountInput").value);
  if (!who) return alert("Type who owes you");
  if (!amount || amount <= 0) return alert("Enter the amount");

  const dateRaw = document.getElementById("debtDateInput").value;
  const ok = await debtRequest("/api/debts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      who,
      amount,
      note: document.getElementById("debtNoteInput").value.trim(),
      date: dateRaw ? new Date(dateRaw).toISOString() : null,
    }),
  });
  if (!ok) return;
  document.getElementById("debtAmountInput").value = "";
  document.getElementById("debtNoteInput").value = "";
});

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
      // Площадка с живым API (CSFloat): число приходит с их сервера, поэтому
      // карандаша нет — править нечего, при следующем чтении вернётся то же.
      const live = b.source === "api";
      const extras = [];
      if (live) extras.push(`<div class="balance-extra balance-live">из API ${escapeHtml(BALANCE_LABEL_OVERRIDES[s] || sourceLabel(s))}</div>`);
      if (b.source === "error") {
        extras.push(`<div class="balance-extra unstable" title="${escapeHtml(b.error || "")}">API не ответил — показан расчёт по продажам</div>`);
      }
      if (b.hold > 0) {
        const holdLine = live
          ? `+${fmtMoney(b.hold)} pending${b.nextUnlockAt ? ` · ближайшая разблокировка ${fmtDate(b.nextUnlockAt)}` : " · ждёт окончания защиты сделки"}`
          : `+${fmtMoney(b.hold)} hold · unlocks ${fmtDate(b.nextUnlockAt)} ${balanceEditBtn(s, "hold", b.hold)}`;
        extras.push(`<div class="balance-extra">${holdLine}</div>`);
        extras.push(...holdSplitLines(b.holdSplit));
      }
      if (b.frozen > 0 && !live) {
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
          <div class="value">${fmtMoney(b.active)} ${live ? "" : balanceEditBtn(s, "active", b.active)}</div>
          ${extras.join("")}
          ${withdrawBtn ? `<div class="balance-extra">${withdrawBtn}</div>` : ""}
        </div>`;
    })
    .join("");

  wireBalanceButtons(container);
}


// Чьи деньги лежат в холде Skinbux. Их API этого не знает (steamId в
// транзакциях нет), поэтому сервер сопоставляет транзакции с нашим журналом
// продаж по id — см. skinbuxAccount.splitHold.
function holdSplitLines(split) {
  if (!split) return [];
  const lines = [];
  if (split.mine > 0) {
    // "Не подтверждено" — это не отдельные деньги, а часть строки "моё":
    // продажи мимо сайта, которых нет ни в журнале, ни в трекере. Когда не
    // подтверждено всё (обычное дело — свои скины продаются не через сайт),
    // две строки показывали одну и ту же сумму и выглядели как ошибка.
    const unconfirmed = split.unconfirmed || { sum: 0, count: 0 };
    let note = "";
    if (unconfirmed.sum > 0) {
      note =
        Math.abs(unconfirmed.sum - split.mine) < 0.01
          ? ` · не подтверждено сделками (${unconfirmed.count} транз.)`
          : ` · из них не подтверждено ${fmtMoney(unconfirmed.sum)} (${unconfirmed.count} транз.)`;
    }
    // Маржа с клиентских продаж уже внутри "моё" — говорим об этом прямо,
    // иначе непонятно, куда делся заработок с клиентской сделки.
    const margin = split.clients?.margin > 0 ? ` · в т.ч. маржа с клиентов ${fmtMoney(split.clients.margin)}` : "";
    lines.push(`моё: ${fmtMoney(split.mine)}${margin}${note}`);
  }
  for (const [name, amount] of Object.entries(split.partners || {})) {
    lines.push(`${escapeHtml(name)} — вернуть: ${fmtMoney(amount)}`);
  }
  if (split.clients.gross > 0) {
    lines.push(
      `клиентам выплатить: ${fmtMoney(split.clients.payout)} (их продажи на ${fmtMoney(split.clients.gross)})`
    );
  }
  // Кому уже заплатил, пока деньги в холде: эти суммы в "моё", не в долг.
  if (split.paidAhead?.sum > 0) {
    lines.push(`уже выплачено заранее: ${fmtMoney(split.paidAhead.sum)} (${split.paidAhead.count} сделк.) — в долг не считается`);
  }
  return lines.map((l) => `<div class="balance-extra balance-split">${l}</div>`);
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
    body.innerHTML = '<tr><td colspan="10" class="empty-row">Nobody has sold you anything through the site yet.</td></tr>';
    return;
  }

  body.innerHTML = data.sales
    .map((s) => {
      // Отметить выплату можно и пока деньги ещё в холде у Skinbux: бывает,
      // что клиенту платишь раньше, и без этого сумма так и висела у него.
      const canPay = !s.paidAt && s.kind !== "manual" && (s.status === "hold" || s.status === "completed");
      // Сделки из вкладки Trade: клиент сдал свою сторону на Skinbux, деньги
      // висят у него trade-балансом, и "оплатить" тут значит отдать ему наши
      // скины, а не перевести деньги. Холд на этих деньгах ждём мы.
      const isTrade = s.kind === "trade";
      // Ручная сделка из трекера (Bought On: gaben.market): деньги клиенту
      // отданы сразу при покупке, поэтому кнопки выплаты у неё нет.
      const isManual = s.kind === "manual";
      // Продажа друга через наш аккаунт: деньги целиком его, нашей маржи нет,
      // и "выплачено" здесь значит "вернул ему". Пока не отмечено, сумма
      // считается долгом в банке на /capital.
      const isPartner = !!s.partner;
      let status;
      if (isManual) status = s.status === "completed" ? "manual · sold on Skinbux" : "manual · in stock";
      else if (s.paidAt) status = isPartner ? `returned ${fmtDate(s.paidAt)}` : isTrade ? `skins given ${fmtDate(s.paidAt)}` : `paid ${fmtDate(s.paidAt)}`;
      else if (isPartner && (s.status === "hold" || s.status === "completed")) status = "we owe it back";
      else if (isTrade && (s.status === "hold" || s.status === "completed")) status = "trade balance — owes him skins";
      else if (s.status === "hold" && s.unlockAt) status = `on hold until ${fmtDate(s.unlockAt)}`;
      else if (s.status === "completed") status = "released — client can withdraw";
      else status = SALE_STATUS_LABELS[s.status] || s.status;

      let action = "";
      if (canPay) {
        action = `<button class="btn-small btn-secondary" data-action="mark-paid" data-id="${s.id}" data-status="${escapeHtml(s.status)}" data-kind="${escapeHtml(s.kind || "sell")}">${isPartner ? "Returned" : isTrade ? "Skins given" : "Mark paid"}</button>`;
      } else if (s.paidAt) {
        action = `<button class="btn-small btn-secondary" data-action="unmark-paid" data-id="${s.id}">Undo</button>`;
      }
      // Ручная сделка живёт в трекере, а не в журнале сайта: её можно просто
      // удалить, если завёл по ошибке или дважды. Продажи через сайт отсюда
      // не удаляются — это настоящие обязательства перед клиентом, и строка
      // в журнале должна остаться даже когда деньги уже выплачены.
      if (isManual) {
        action = `<button class="btn-small btn-danger" data-action="delete-manual" data-id="${escapeHtml(
          s.tradeId || ""
        )}">Delete</button>`;
      }

      // Номер сделки — тот же, что клиент пишет в Telegram ("Угода #..."),
      // по нему строку и находишь.
      return `
        <tr>
          <td>${fmtDate(s.createdAt)}</td>
          <td>#${escapeHtml(String(s.id))}${isTrade ? ' <span class="na">trade</span>' : ""}${isManual ? ' <span class="na">manual</span>' : ""}${isPartner ? ` <span class="na">${escapeHtml(s.partner)}</span>` : ""}</td>
          <td>${
            s.steamId
              ? `<a href="https://steamcommunity.com/profiles/${escapeHtml(s.steamId)}" target="_blank">${escapeHtml(s.customerName || s.steamId)}</a>`
              : '<span class="na">off-site deal</span>'
          }${
            // Реквизиты выплаты клиент оставил сам при продаже — переводить
            // можно прямо отсюда, не спрашивая его в Telegram.
            s.payout && !s.paidAt ? `<div class="client-payout">${escapeHtml(s.payout)}</div>` : ""
          }</td>
          <td>${escapeHtml(s.items.join(", "))}</td>
          <td>${fmtMoney(s.totalPrice)}</td>
          <td>${
            // Частичная выплата бывает только у ручной покупки: в продажах
            // через сайт деньги идут одной суммой по кнопке "Mark paid".
            isManual
              ? `${s.clientPaid ? fmtMoney(s.clientPaid) : '<span class="na">—</span>'} <button class="btn-small btn-secondary" data-action="edit-client-paid" data-id="${escapeHtml(
                  s.tradeId || ""
                )}" title="How much of this purchase is already paid to the client">✎</button>`
              : '<span class="na">—</span>'
          }</td>
          <td>${s.skinbuxTotal ? fmtMoney(s.skinbuxTotal) : '<span class="na">—</span>'}</td>
          <td class="${s.profit >= 0 ? "profit" : "loss"}">${s.skinbuxTotal ? fmtMoney(s.profit) : '<span class="na">—</span>'}</td>
          <td>${escapeHtml(status)}</td>
          <td>${action}</td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll('[data-action="delete-manual"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteTrade(btn.dataset.id);
      loadClientSales();
    });
  });

  body.querySelectorAll('[data-action="edit-client-paid"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const sale = data.sales.find((x) => x.tradeId === btn.dataset.id);
      editClientPaid(btn.dataset.id, sale?.clientPaid, sale?.totalPrice);
    });
  });

  body.querySelectorAll('[data-action="mark-paid"]').forEach((btn) => {
    btn.addEventListener("click", () =>
      markSalePaid(btn.getAttribute("data-id"), btn.getAttribute("data-status"), btn.getAttribute("data-kind"))
    );
  });
  body.querySelectorAll('[data-action="unmark-paid"]').forEach((btn) => {
    btn.addEventListener("click", () => unmarkSalePaid(btn.getAttribute("data-id")));
  });
}

// Пока выплата не отмечена, сделка продолжает висеть в балансе у клиента.
async function markSalePaid(id, status, kind) {
  let question;
  if (kind === "trade") {
    // В обмене мы платим скинами, поэтому и спрашиваем про них.
    question = "Confirm you have sent him the skins for this trade? The amount leaves his trade balance.";
  } else if (status === "hold") {
    question = "Skinbux hasn't released these funds yet. Mark as paid anyway? It disappears from the client's balance.";
  } else {
    question = "Mark this payout as done? It disappears from the client's balance.";
  }
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
loadDebts();
setInterval(loadTrades, 60 * 1000);

// Ручные цены и продажи клиентов — только у владельца сайта; у друзей эти
// блоки не показываем и не грузим (сервер им всё равно ответит 403).
fetch("/api/me")
  .then((r) => r.json())
  .then((me) => {
    if (!me.isSiteOwner) return;
    isSiteOwner = true;
    document.getElementById("siteOwnerSections").style.display = "block";
    loadOverrides();
    loadClientSales();
    loadPricingSettings();
    loadPromoCodes();
    loadReferrals();
    loadReviews();
    loadCustomerBalances();
  });

// ---- Балансы клиентов (только владелец) ----
// Баланс в кабинете считается из журнала продаж: что продал, то и должны,
// минус отметки "выплачено". Журнал не знает о выплатах частями, бонусах и
// расчётах мимо сайта — поэтому здесь поправка по Steam ID, с заметкой и
// возможностью удалить. См. customerBalances.js.
const CUST_BAL_WALLETS = { available: "available", hold: "on hold", trade: "trade only" };

// Поправка со знаком: "+$25.00" / "-$25.00" читается с одного взгляда, а
// "$-25.00" из общего fmtMoney — нет.
function custBalDelta(v) {
  const n = Number(v) || 0;
  return `${n > 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

// Баланс клиента может уйти в минус (переплатили, отдали вперёд) — знак
// ставим перед долларом, "$-25.50" читается как опечатка.
function custBalMoney(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}
let custBalClients = [];

async function loadCustomerBalances() {
  const body = document.getElementById("custBalBody");
  if (!body) return;

  let data;
  try {
    data = await (await fetch("/api/customer-balances")).json();
  } catch {
    data = { ok: false };
  }
  if (!data.ok) return;

  custBalClients = data.clients || [];
  renderCustomerBalances();
  renderCustomerBalanceLog();
  describeCustomer();
}

function renderCustomerBalances() {
  const body = document.getElementById("custBalBody");

  // Подсказка в поле Steam ID: ник рядом с номером, иначе выбирать не из чего.
  document.getElementById("custBalSteamIdList").innerHTML = custBalClients
    .map((c) => `<option value="${escapeHtml(c.steamId)}" label="${escapeHtml(c.name || c.steamId)}"></option>`)
    .join("");

  if (!custBalClients.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-row">No clients yet — nobody has logged in or sold anything.</td></tr>';
    return;
  }

  body.innerHTML = custBalClients
    .map((c) => {
      const computed = c.computed.available + c.computed.hold + c.computed.trade;
      const adj = c.adjustment.available + c.adjustment.hold + c.adjustment.trade;
      return `<tr${c.total ? "" : ' class="debt-repaid"'}>
        <td><a href="https://steamcommunity.com/profiles/${escapeHtml(c.steamId)}" target="_blank">${escapeHtml(c.name || "(no name)")}</a></td>
        <td><span class="na">${escapeHtml(c.steamId)}</span></td>
        <td>${custBalMoney(computed)}</td>
        <td>${adj ? `<b class="${adj > 0 ? "loss" : "profit"}">${custBalDelta(adj)}</b>` : '<span class="na">—</span>'}</td>
        <td>${custBalMoney(c.balance.available)}</td>
        <td>${custBalMoney(c.balance.hold)}</td>
        <td>${custBalMoney(c.balance.trade)}</td>
        <td><b>${custBalMoney(c.total)}</b></td>
      </tr>`;
    })
    .join("");
}

// Список самих поправок: без него через месяц не вспомнить, почему у человека
// на сорок долларов больше, и откатить не получится.
function renderCustomerBalanceLog() {
  const card = document.getElementById("custBalLogCard");
  const body = document.getElementById("custBalLogBody");

  const rows = [];
  for (const c of custBalClients) {
    for (const e of c.entries || []) rows.push({ ...e, steamId: c.steamId, name: c.name });
  }
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  card.style.display = rows.length ? "block" : "none";
  if (!rows.length) {
    body.innerHTML = "";
    return;
  }

  body.innerHTML = rows
    .map(
      (e) => `<tr>
        <td>${fmtDate(e.createdAt)}</td>
        <td>${escapeHtml(e.name || e.steamId)}</td>
        <td>${CUST_BAL_WALLETS[e.bucket] || e.bucket}</td>
        <td class="${e.amount > 0 ? "loss" : "profit"}">${custBalDelta(e.amount)}</td>
        <td>${escapeHtml(e.note || "")}</td>
        <td><button class="btn-small btn-danger" data-action="cust-bal-delete" data-steamid="${escapeHtml(e.steamId)}" data-id="${e.id}">Undo</button></td>
      </tr>`
    )
    .join("");

  body.querySelectorAll("[data-action='cust-bal-delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this correction? The client's balance goes back to what the deals say.")) return;
      const res = await fetch(`/api/customer-balances/${encodeURIComponent(btn.dataset.steamid)}/${encodeURIComponent(btn.dataset.id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error);
      custBalClients = data.clients || [];
      renderCustomerBalances();
      renderCustomerBalanceLog();
      describeCustomer();
    });
  });
}

// Пока правишь — видно, кого именно и с какого числа. Без этого легко
// поправить незнакомый номер и не заметить.
function describeCustomer() {
  const status = document.getElementById("custBalStatus");
  const id = document.getElementById("custBalSteamIdInput").value.trim();
  if (!id) return (status.textContent = "");
  const c = custBalClients.find((x) => x.steamId === id);
  if (!c) {
    status.textContent = /^\d{17}$/.test(id)
      ? "no deals through the site — the correction will be their whole balance"
      : "Steam ID is 17 digits";
    return;
  }
  status.textContent = `${c.name || c.steamId}: sees ${custBalMoney(c.total)} now (${custBalMoney(c.balance.available)} available, ${custBalMoney(
    c.balance.hold
  )} on hold, ${custBalMoney(c.balance.trade)} trade)`;
}

document.getElementById("custBalSteamIdInput")?.addEventListener("input", describeCustomer);

document.getElementById("custBalAddBtn")?.addEventListener("click", async () => {
  const status = document.getElementById("custBalStatus");
  const steamId = document.getElementById("custBalSteamIdInput").value.trim();
  const amount = parseFloat(document.getElementById("custBalAmountInput").value);
  if (!/^\d{17}$/.test(steamId)) return alert("Steam ID is 17 digits (76561198...)");
  if (!amount) return alert("Enter the amount: plus adds to the balance, minus takes off it");

  const client = custBalClients.find((c) => c.steamId === steamId);
  const bucket = document.getElementById("custBalBucketSelect").value;
  const was = client ? client.balance[bucket] : 0;
  const who = client ? client.name || steamId : steamId;
  // Клиент это число видит у себя в кабинете, поэтому спрашиваем до записи.
  if (!confirm(`${who}: ${CUST_BAL_WALLETS[bucket]} ${custBalMoney(was)} -> ${custBalMoney(was + amount)}. Write it?`)) return;

  const res = await fetch("/api/customer-balances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      steamId,
      amount,
      bucket,
      note: document.getElementById("custBalNoteInput").value.trim(),
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    status.textContent = data.error;
    return;
  }
  custBalClients = data.clients || [];
  document.getElementById("custBalAmountInput").value = "";
  document.getElementById("custBalNoteInput").value = "";
  renderCustomerBalances();
  renderCustomerBalanceLog();
  describeCustomer();
});

// ---- Партнёры и промокоды (только владелец) ----
// Одно слово работает двумя способами: gaben.market/sicarios как ссылка и
// SICARIOS как промокод в корзине. Клиенту оно даёт бонус к выплате, партнёру
// — долю нашей маржи с приведённых им людей.
// ---- Відгуки (тільки власник) ----
async function loadReviews() {
  const body = document.getElementById("reviewsBody");
  if (!body) return;
  let data;
  try {
    data = await (await fetch("/api/reviews")).json();
  } catch {
    data = { ok: false };
  }
  if (!data.ok) return;
  if (!data.reviews.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-row">No reviews yet — clients leave them on their deals in the profile.</td></tr>';
    return;
  }
  body.innerHTML = data.reviews
    .map(
      (r) => `<tr${r.hidden ? ' class="debt-repaid"' : ""}>
        <td>${fmtDate(r.createdAt)}</td>
        <td><a href="https://steamcommunity.com/profiles/${escapeHtml(r.steamId)}" target="_blank">${escapeHtml(r.name || r.steamId)}</a></td>
        <td>#${escapeHtml(r.saleId)}</td>
        <td style="color: var(--accent); white-space: nowrap;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</td>
        <td>${escapeHtml(r.text || "")}</td>
        <td><button class="btn-small btn-secondary" data-action="review-hide" data-id="${escapeHtml(r.id)}" data-hidden="${r.hidden ? "0" : "1"}">${
          r.hidden ? "Show" : "Hide"
        }</button></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("[data-action='review-hide']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await fetch(`/api/reviews/${encodeURIComponent(btn.dataset.id)}/hidden`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: btn.dataset.hidden === "1" }),
      });
      loadReviews();
    });
  });
}

// ---- Реферальна програма (тільки власник) ----
// Заявки на вивід реферальних грошей: переказуєш руками за адресою з рядка і
// тиснеш Paid. Reject — якщо це накрутка (мультиакаунт, спам) — гроші тоді
// повертаються людині на баланс, і вона бачить заявку відхиленою.
async function loadReferrals() {
  const payoutsBody = document.getElementById("refPayoutsBody");
  const referrersBody = document.getElementById("refReferrersBody");
  if (!payoutsBody) return;

  let data;
  try {
    data = await (await fetch("/api/referrals")).json();
  } catch {
    data = { ok: false };
  }
  if (!data.ok) return;

  const steamLink = (steamId, name) =>
    `<a href="https://steamcommunity.com/profiles/${escapeHtml(steamId)}" target="_blank">${escapeHtml(name || steamId)}</a>`;
  const NETWORK_LABELS = {
    "usdt-trc20": "USDT TRC-20", "usdt-erc20": "USDT ERC-20", "usdt-bep20": "USDT BEP-20", "usdt-sol": "USDT Solana",
    "usdc-trc20": "USDC TRC-20", "usdc-erc20": "USDC ERC-20", "usdc-bep20": "USDC BEP-20",
  };

  payoutsBody.innerHTML = data.payouts.length
    ? data.payouts
        .map((p) => {
          const actions =
            p.status === "requested"
              ? `<button class="btn-small" data-action="ref-payout" data-status="paid" data-id="${escapeHtml(p.id)}">Paid</button>
                 <button class="btn-small btn-danger" data-action="ref-payout" data-status="rejected" data-id="${escapeHtml(p.id)}">Reject</button>`
              : `<button class="btn-small btn-secondary" data-action="ref-payout" data-status="requested" data-id="${escapeHtml(p.id)}">Undo</button>`;
          return `<tr${p.status === "requested" ? "" : ' class="debt-repaid"'}>
            <td>${fmtDate(p.createdAt)}</td>
            <td>${steamLink(p.steamId, p.customerName)}</td>
            <td><b>${fmtMoney(p.amount)}</b></td>
            <td>${escapeHtml(NETWORK_LABELS[p.network] || p.network || "")}<div class="client-payout">${escapeHtml(p.address || "")}</div></td>
            <td>${p.status === "paid" ? `paid ${fmtDate(p.paidAt)}` : escapeHtml(p.status)}</td>
            <td>${actions}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="6" class="empty-row">No withdrawal requests yet.</td></tr>';

  referrersBody.innerHTML = data.referrers.length
    ? data.referrers
        .map(
          (r) => `<tr>
            <td>${steamLink(r.steamId, r.customerName)}</td>
            <td><b>${escapeHtml(r.code.toUpperCase())}</b></td>
            <td>${r.clicks}</td>
            <td>${r.friends}</td>
            <td>${fmtMoney(r.volume)}</td>
            <td>${r.percent}%</td>
            <td>${fmtMoney(r.balance.pending)}</td>
            <td>${fmtMoney(r.balance.available)}</td>
            <td>${fmtMoney(r.balance.paid)}</td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="9" class="empty-row">Nobody has brought friends yet — codes appear in client profiles after their first sale.</td></tr>';

  payoutsBody.querySelectorAll("[data-action='ref-payout']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.status === "rejected" && !confirm("Reject this request? The money goes back to the client's referral balance.")) return;
      btn.disabled = true;
      const res = await fetch(`/api/referrals/payouts/${encodeURIComponent(btn.dataset.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: btn.dataset.status }),
      });
      const result = await res.json();
      if (!result.ok) alert(result.error || "Failed");
      loadReferrals();
    });
  });
}

async function loadPromoCodes() {
  const body = document.getElementById("promoBody");
  if (!body) return;

  let data;
  try {
    data = await (await fetch("/api/promo-codes")).json();
  } catch {
    data = { ok: false };
  }
  if (!data.ok) return;

  if (!data.codes.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty-row">No partners yet — add a code above and give out the link.</td></tr>';
    return;
  }

  body.innerHTML = data.codes
    .map((c) => {
      const link = `${location.origin}/${c.code}`;
      return `<tr${c.active ? "" : ' class="debt-repaid"'}>
        <td><b>${escapeHtml(c.code.toUpperCase())}</b>${c.name ? `<br><span class="na">${escapeHtml(c.name)}</span>` : ""}</td>
        <td><a href="${escapeHtml(link)}" target="_blank">/${escapeHtml(c.code)}</a> · +${c.bonusPercent}% client</td>
        <td>${c.clicks || 0}</td>
        <td>${c.customers}</td>
        <td>${c.deals}</td>
        <td>${fmtMoney(c.volume)}</td>
        <td class="profit">${fmtMoney(c.margin)}</td>
        <td>${fmtMoney(c.partnerDue)} <span class="na">(${c.partnerPercent}%)</span></td>
        <td>
          <button class="btn-small btn-secondary" data-action="promo-edit" data-code="${escapeHtml(c.code)}">Edit</button>
          <button class="btn-small btn-danger" data-action="promo-delete" data-code="${escapeHtml(c.code)}">Delete</button>
        </td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-action='promo-edit']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = data.codes.find((x) => x.code === btn.dataset.code);
      document.getElementById("promoCodeInput").value = c.code;
      document.getElementById("promoNameInput").value = c.name || "";
      document.getElementById("promoBonusInput").value = c.bonusPercent;
      document.getElementById("promoPartnerInput").value = c.partnerPercent;
    });
  });
  body.querySelectorAll("[data-action='promo-delete']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete code ${btn.dataset.code.toUpperCase()}? Deals already made keep their record.`)) return;
      await fetch(`/api/promo-codes/${encodeURIComponent(btn.dataset.code)}`, { method: "DELETE" });
      loadPromoCodes();
    });
  });
}

document.getElementById("promoSaveBtn")?.addEventListener("click", async () => {
  const status = document.getElementById("promoSaveStatus");
  const res = await fetch("/api/promo-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: document.getElementById("promoCodeInput").value.trim(),
      name: document.getElementById("promoNameInput").value.trim(),
      bonusPercent: Number(document.getElementById("promoBonusInput").value) || 0,
      partnerPercent: Number(document.getElementById("promoPartnerInput").value) || 0,
    }),
  });
  const data = await res.json();
  status.textContent = data.ok ? "saved" : data.error;
  if (!data.ok) return;
  setTimeout(() => (status.textContent = ""), 2000);
  loadPromoCodes();
});

// ---- Проценты (только владелец) ----
// Покупка: youpin + %; продажа: Skinbux − %; у трейда свои проценты на обе
// стороны — он от покупки и продажи не зависит.
const PRICING_FIELDS = {
  buyMarkupPercent: "buyMarkupInput",
  sellDiscountPercent: "sellDiscountInput",
  tradeMarkupPercent: "tradeMarkupInput",
  tradeDiscountPercent: "tradeDiscountInput",
  // Курс гривні — два, як в обміннику: виплата клієнту й продаж наших скінів.
  uahRateSell: "uahRateSellInput",
  uahRateBuy: "uahRateBuyInput",
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
    `trade +${data.tradeMarkupPercent}% / −${data.tradeDiscountPercent}%, ` +
    `₴ ${data.uahRateSell} pay / ${data.uahRateBuy} sell`;
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
