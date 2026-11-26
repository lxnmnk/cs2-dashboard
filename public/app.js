const tbody = document.getElementById("pricesBody");
const updatedAtEl = document.getElementById("updatedAt");
const errorBox = document.getElementById("errorBox");

function fmtPrice(v) {
  return v == null ? '<span class="na">—</span>' : `$${v.toFixed(2)}`;
}

let marketUrls = {};
let sortState = { field: "profitUsd", direction: "desc" }; // desc = сначала прибыльнее
let lastResponse = null; // последние данные с сервера, чтобы пересортировка не дёргала API заново
let selectedRowKey = null; // marketHashName строки, по которой кликнули — подсветка buy/sell только там

function sortRows(rows) {
  const { field, direction } = sortState;
  if (!field) return rows;

  const sorted = [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];

    // null/undefined всегда в конец, независимо от направления
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    return direction === "asc" ? av - bv : bv - av;
  });

  return sorted;
}

function updateSortArrows() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sort === sortState.field) {
      arrow.textContent = sortState.direction === "asc" ? "▲" : "▼";
    } else {
      arrow.textContent = "";
    }
  });
}

function buildMarketUrl(source, marketHashName) {
  const template = marketUrls[source];
  if (!template) return null;
  return template.replace("{name}", encodeURIComponent(marketHashName));
}

function fmtSide(value, source, marketHashName) {
  if (value == null) return '<span class="na">—</span>';

  const text = `$${value.toFixed(2)}`;
  const url = buildMarketUrl(source, marketHashName);
  if (!url) return text;

  return `<a class="price-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Open on marketplace">${text}</a>`;
}

function renderRows(rows) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="17" class="loading">No items match the current filters</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const profitClass = r.profitUsd == null ? "" : r.profitUsd >= 0 ? "profit-positive" : "profit-negative";
      const selected = r.marketHashName === selectedRowKey;
      return `
        <tr class="${selected ? "row-selected" : ""}" data-row-key="${escapeHtml(r.marketHashName)}">
          <td>${escapeHtml(r.name)} <button type="button" class="pc-btn" data-price-chart="${escapeHtml(r.marketHashName)}" data-chart-title="${escapeHtml(r.marketHashName)}" title="История цен">📈</button></td>
          <td>${escapeHtml(r.wear)}</td>
          <td class="${cellRole("csfloat", "ask", r)}">${fmtSide(r.prices.csfloat.ask, "csfloat", r.linkName)}</td>
          <td class="${cellRole("csfloat", "bid", r)}">${fmtSide(r.prices.csfloat.bid, "csfloat", r.linkName)}</td>
          <td class="${cellRole("youpin", "ask", r)}">${fmtSide(r.prices.youpin.ask, "youpin", r.linkName)}</td>
          <td class="${cellRole("youpin", "bid", r)}">${fmtSide(r.prices.youpin.bid, "youpin", r.linkName)}</td>
          <td class="${cellRole("buff", "ask", r)}">${fmtSide(r.prices.buff.ask, "buff", r.linkName)}</td>
          <td class="${cellRole("buff", "bid", r)}">${fmtSide(r.prices.buff.bid, "buff", r.linkName)}</td>
          <td class="${cellRole("skinbux", "bid", r)}">${fmtSide(r.prices.skinbux.bid, "skinbux", r.linkName)}</td>
          <td class="buyout-col">${buyoutCell(r, "skinplace")}</td>
          <td class="buyout-col">${buyoutCell(r, "skins")}</td>
          <td class="${cellRole("csmoney", "ask", r)}">${fmtSide(r.prices.csmoney.ask, "csmoney", r.linkName)}</td>
          <td class="${cellRole("csmoney", "bid", r)}">${fmtSide(r.prices.csmoney.bid, "csmoney", r.linkName)}</td>
          <td>${fmtSourceSide(r.bestBuySource, r.bestBuySide)}</td>
          <td>${fmtSourceSide(r.bestSellSource, r.bestSellSide)}</td>
          <td class="${profitClass}">${fmtPrice(r.profitUsd)}</td>
          <td class="${profitClass}">${r.profitPercent != null ? r.profitPercent.toFixed(1) + "%" : '<span class="na">—</span>'}</td>
        </tr>
      `;
    })
    .join("");
}

// Подсвечивает ячейку, если именно она использована как сторона покупки/продажи
// в текущей связке этой строки (r.bestBuySource/Side, r.bestSellSource/Side) —
// но только у строки, по которой кликнули (selectedRowKey), чтобы не подсвечивать
// сразу всю таблицу. Работает и в режиме "любой" (связка своя для каждой строки),
// и при ручном выборе конкретной площадки+стороны в "Buy On"/"Sell On".
function cellRole(source, side, r) {
  if (r.marketHashName !== selectedRowKey) return "";
  if (r.bestBuySource === source && r.bestBuySide === side) return "cell-buy";
  if (r.bestSellSource === source && r.bestSellSide === side) return "cell-sell";
  return "";
}

function fmtSourceSide(source, side) {
  if (!source) return '<span class="na">—</span>';
  return side ? `${source} · ${side}` : source;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadData() {
  const search = document.getElementById("searchInput").value;
  const minProfitUsd = document.getElementById("minProfitUsd").value;
  const minProfitPercent = document.getElementById("minProfitPercent").value;
  const viewMode = document.getElementById("viewMode").value;
  const excludeStatTrak = document.getElementById("excludeStatTrak").checked;
  const excludeSouvenir = document.getElementById("excludeSouvenir").checked;
  const excludeStickers = document.getElementById("excludeStickers").checked;
  const minPrice = document.getElementById("minPrice").value;
  const maxPrice = document.getElementById("maxPrice").value;
  const buySource = document.getElementById("buySource").value;
  const sellSource = document.getElementById("sellSource").value;
  const maxCsfloatSpread = document.getElementById("maxCsfloatSpread").value;
  const maxYoupinSpread = document.getElementById("maxYoupinSpread").value;
  const maxBuffSpread = document.getElementById("maxBuffSpread").value;
  const phase = document.getElementById("phaseFilter").value;

  const params = new URLSearchParams({
    search,
    minProfitUsd,
    minProfitPercent,
    maxResults: 300,
    excludeStatTrak: excludeStatTrak ? "true" : "false",
    excludeSouvenir: excludeSouvenir ? "true" : "false",
    excludeStickers: excludeStickers ? "true" : "false",
    minPrice: minPrice === "" ? "" : minPrice,
    maxPrice: maxPrice === "" ? "" : maxPrice,
    buySource,
    sellSource,
    maxCsfloatSpreadPercent: maxCsfloatSpread === "" ? "" : maxCsfloatSpread,
    maxYoupinSpreadPercent: maxYoupinSpread === "" ? "" : maxYoupinSpread,
    maxBuffSpreadPercent: maxBuffSpread === "" ? "" : maxBuffSpread,
    phase,
  });

  const res = await fetch(`/api/items?${params.toString()}`);
  const data = await res.json();

  const buySourceOnly = buySource.split(":")[0];
  const sellSourceOnly = sellSource.split(":")[0];

  if (data.error) {
    errorBox.style.display = "block";
    errorBox.textContent = `Price refresh error: ${data.error}`;
  } else if (buySource !== "any" && sellSource !== "any" && buySourceOnly === sellSourceOnly) {
    errorBox.style.display = "block";
    errorBox.textContent = "Buying and selling on the same source isn't possible — pick different marketplaces.";
  } else {
    errorBox.style.display = "none";
  }

  updatedAtEl.textContent = data.updatedAt
    ? `Updated: ${new Date(data.updatedAt).toLocaleString("en-US")} · items: ${data.total}`
    : "No data yet";

  lastResponse = { data, viewMode };
  renderCurrentView();
}

function renderCurrentView() {
  if (!lastResponse) return;
  const { data, viewMode } = lastResponse;
  const rowsToShow = viewMode === "top" ? data.topProfitable : data.all;
  renderRows(sortRows(rowsToShow));
  updateSortArrows();
}

// ---- Skin.place и Skins.com: цена выкупа по кнопке ----
// Общего прайса у них нет: сервер ищет такой же предмет на CSFloat и смотрит,
// сколько площадка даёт за него в инвентаре продавца (buyoutLookup.js).
// Каждая проверка — несколько запросов с паузами, поэтому только по кнопке.
// Колонки видит только владелец: запрос идёт от его входа на площадках.
// Результаты держим, пока страница открыта, — таблица перерисовывается раз в
// минуту, и цена не должна пропадать.
const buyoutResults = {}; // `${source}|${marketHashName}` -> { loading } | { error } | result

function buyoutCell(r, source) {
  const res = buyoutResults[`${source}|${r.marketHashName}`];
  const button = (label) =>
    `<button class="btn-small btn-secondary buyout-btn" data-buyout="${source}" data-name="${escapeHtml(r.marketHashName)}">${label}</button>`;

  if (!res) return button("Request");
  if (res.loading) return '<span class="na">checking…</span>';
  if (res.error) {
    return `<span class="profit-negative buyout-error" data-error="${escapeHtml(res.error)}" title="${escapeHtml(
      res.error
    )}">error</span> ${button("↻")}`;
  }

  if (res.price == null) {
    return `<span class="na" title="${escapeHtml(res.skipReason || "")}">⚠ not buying</span>`;
  }

  // Сколько это к лучшей цене покупки в строке: купил там — сразу сдал сюда.
  const vsBuy =
    r.bestBuyPrice > 0 ? ((res.price - r.bestBuyPrice) / r.bestBuyPrice) * 100 : null;
  const details = [
    res.instant ? null : `⚠ ${res.skipReason}`,
    res.matchedBy === "float" ? `float ${res.float.toFixed(4)}, same as a CSFloat listing` : "same item name on CSFloat",
    res.csfloatPrice != null ? `CSFloat ask $${res.csfloatPrice.toFixed(2)}` : null,
    vsBuy != null ? `${vsBuy >= 0 ? "+" : ""}${vsBuy.toFixed(1)}% vs best buy $${r.bestBuyPrice.toFixed(2)}` : null,
    `checked ${new Date(res.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  ].filter(Boolean);
  const vsClass = vsBuy == null ? "" : vsBuy >= 0 ? "profit-positive" : "profit-negative";
  return `<span class="${res.instant ? "" : "buyout-blocked"}" title="${escapeHtml(details.join(" · "))}">${res.instant ? "" : "⚠ "}$${res.price.toFixed(2)}</span>${
    vsBuy != null ? ` <span class="buyout-vs ${vsClass}">${vsBuy >= 0 ? "+" : ""}${vsBuy.toFixed(1)}%</span>` : ""
  }`;
}

async function requestBuyout(source, marketHashName) {
  const key = `${source}|${marketHashName}`;
  buyoutResults[key] = { loading: true };
  renderCurrentView();
  try {
    const res = await fetch(`/api/buyout/${source}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketHashName }),
    });
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
  renderCurrentView();
}

fetch("/api/me")
  .then((r) => r.json())
  .then((me) => {
    if (me.isSiteOwner) document.body.classList.add("show-buyout");
  })
  .catch(() => {});

tbody.addEventListener("click", (e) => {
  // Подсказка при наведении легко теряется — по клику показываем текст целиком.
  const buyoutError = e.target.closest(".buyout-error");
  if (buyoutError) {
    alert(buyoutError.dataset.error);
    return;
  }
  const buyoutBtn = e.target.closest("[data-buyout]");
  if (buyoutBtn) {
    requestBuyout(buyoutBtn.dataset.buyout, buyoutBtn.dataset.name);
    return; // кнопка — не клик по строке, подсветку не трогаем
  }
  if (e.target.closest("a")) return; // клик по цене — открываем площадку, не трогаем подсветку
  const row = e.target.closest("tr[data-row-key]");
  if (!row) return;

  const key = row.dataset.rowKey;
  selectedRowKey = selectedRowKey === key ? null : key; // повторный клик снимает подсветку
  renderCurrentView();
});

document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const field = th.dataset.sort;
    if (sortState.field === field) {
      sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
    } else {
      sortState.field = field;
      sortState.direction = "desc";
    }
    renderCurrentView(); // пересортировка уже загруженных данных, без нового запроса
  });
});

document.getElementById("applyBtn").addEventListener("click", loadData);
document.getElementById("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadData();
});

// ---- Item name autocomplete for the search box ----
const searchInput = document.getElementById("searchInput");
const searchAutocompleteList = document.getElementById("searchAutocompleteList");
let searchAutocompleteDebounce = null;

searchInput.addEventListener("input", () => {
  clearTimeout(searchAutocompleteDebounce);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchAutocompleteList.classList.remove("open");
    return;
  }
  searchAutocompleteDebounce = setTimeout(async () => {
    const res = await fetch(`/api/item-search?q=${encodeURIComponent(q)}`);
    const items = await res.json();
    renderSearchAutocomplete(items);
  }, 200);
});

document.addEventListener("click", (e) => {
  if (!searchAutocompleteList.contains(e.target) && e.target !== searchInput) {
    searchAutocompleteList.classList.remove("open");
  }
});

function renderSearchAutocomplete(items) {
  if (!items.length) {
    searchAutocompleteList.classList.remove("open");
    return;
  }
  searchAutocompleteList.innerHTML = items
    .map(
      (it, i) => `<div class="autocomplete-item" data-idx="${i}">
        ${escapeHtml(it.name)} <span class="wear">${escapeHtml(it.wear)}</span>
      </div>`
    )
    .join("");
  searchAutocompleteList.classList.add("open");

  searchAutocompleteList.querySelectorAll(".autocomplete-item").forEach((el, i) => {
    el.addEventListener("click", () => {
      searchInput.value = items[i].marketHashName;
      searchAutocompleteList.classList.remove("open");
      loadData();
    });
  });
}

document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";
  await fetch("/api/refresh", { method: "POST" });
  await loadData();
  btn.disabled = false;
  btn.textContent = "Refresh Now";
});

async function loadMarketUrls() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    marketUrls = cfg.marketUrls || {};
  } catch (e) {
    console.warn("Failed to load marketUrls:", e);
  }
}

loadMarketUrls().then(loadData);
setInterval(loadData, 60 * 1000); // pull cached data once a minute without hitting external APIs
