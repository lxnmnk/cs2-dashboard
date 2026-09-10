// Особистий кабінет: інвентар клієнта тягнеться напряму зі Steam
// (/api/account/inventory), і на кожен предмет одразу порахована ціна
// викупу — та сама формула, що на "Продати" (sellQuote.js), просто без
// ручного пошуку. Сервер вже віддає тільки те, що реально можна продати
// (не-tradable типи предметів на кшталт медалей/монет відфільтровані), і
// відсортовано від найдорожчого.
// Локалізація — через window.ACCOUNT_CONFIG (кожна мовна версія сторінки
// задає свій текст перед підключенням цього файлу, як у quote-common.js).
const {
  saveErrorPrefix,
  savedLabel,
  needTradeUrlFirst,
  pricesLoading,
  steamBusy,
  sellFailedPrefix,
  acceptOnlyVia,
  offerLinkPending,
  scamWarning,
  senderTitle,
  steamIdLabel,
  levelLabel,
  registeredLabel,
  openProfile,
  priceUnknown,
  addLabel,
  addedLabel,
  removeLabel,
  nothingFound,
  tradeLockedLabel,
  unavailableLabel,
} = window.ACCOUNT_CONFIG;

// dateLocale і openOfferBtn беремо через конфіг, а не деструктуризацією:
// ці ж імена оголошує account-deals.js, а два звичайні <script> ділять одну
// глобальну область — повторний const ламає весь другий файл.
const CFG = window.ACCOUNT_CONFIG;

const inventoryListEl = document.getElementById("inventoryList");
const inventoryLoadingEl = document.getElementById("inventoryLoading");
const inventoryPrivateEl = document.getElementById("inventoryPrivate");
const inventoryEmptyEl = document.getElementById("inventoryEmpty");
const cartSection = document.getElementById("cartSection");
const cartList = document.getElementById("cartList");
const cartTotal = document.getElementById("cartTotal");
const sellAutoBtn = document.getElementById("sellAutoBtn");
const sellStatusEl = document.getElementById("sellStatus");
const cartClearBtn = document.getElementById("cartClearBtn");
const tradeUrlInput = document.getElementById("tradeUrlInput");
const tradeUrlSaveBtn = document.getElementById("tradeUrlSaveBtn");
const tradeUrlStatusEl = document.getElementById("tradeUrlStatus");
const sellResultModal = document.getElementById("sellResultModal");
const sellResultBody = document.getElementById("sellResultBody");

const sellResultTitle = document.getElementById("sellResultTitle");
const sellResultTitleText = sellResultTitle?.textContent;

document.getElementById("sellResultClose")?.addEventListener("click", () => {
  sellResultModal.style.display = "none";
  stopSaleWatch();
});

const MAX_RETRIES = 3;

// Фільтри тільки звужують показане: те, що вже в кошику, з нього не зникає,
// навіть якщо предмет випав з поточної вибірки.
const filters = createItemFilters({
  mount: document.getElementById("filtersPanel"),
  labels: window.ACCOUNT_CONFIG,
  onChange: () => renderInventoryList(),
});

let inventoryItems = [];
let inventoryRetries = 0;
let cart = []; // [{ assetId, marketHashName, price }] — по одному на кожен фізичний предмет

cartClearBtn?.addEventListener("click", () => {
  cart = [];
  renderInventoryList();
  renderCart();
});

const tradeUrlSaveLabel = tradeUrlSaveBtn?.textContent;

tradeUrlSaveBtn?.addEventListener("click", async () => {
  tradeUrlSaveBtn.disabled = true;
  tradeUrlStatusEl.textContent = "";
  tradeUrlStatusEl.classList.remove("field-error");

  const res = await fetch("/api/account/trade-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tradeUrl: tradeUrlInput.value.trim() }),
  });
  const data = await res.json();

  if (!data.ok) {
    tradeUrlSaveBtn.disabled = false;
    tradeUrlStatusEl.textContent = `${saveErrorPrefix}${data.error}`;
    tradeUrlStatusEl.classList.add("field-error");
    return;
  }

  window.ACCOUNT_CUSTOMER = data.customer;
  tradeUrlSaveBtn.textContent = savedLabel;
  setTimeout(() => {
    tradeUrlSaveBtn.textContent = tradeUrlSaveLabel;
    tradeUrlSaveBtn.disabled = false;
  }, 1500);
});

sellAutoBtn?.addEventListener("click", async () => {
  if (!cart.length) return;
  if (!window.ACCOUNT_CUSTOMER?.tradeUrl) {
    sellStatusEl.textContent = needTradeUrlFirst;
    return;
  }

  sellAutoBtn.disabled = true;
  sellStatusEl.textContent = "";

  const res = await fetch("/api/account/sell", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetIds: cart.map((it) => it.assetId) }),
  });
  const data = await res.json();

  sellAutoBtn.disabled = false;

  if (!data.ok) {
    sellStatusEl.textContent = `${sellFailedPrefix}${data.error}`;
    return;
  }

  showSellResult(data);
  cart = [];
  renderInventoryList();
  renderCart();
});

// Вікно "обмін надіслано". Головне тут — пряме посилання саме на цей обмін і
// дані бота, який його шле: клієнту треба бачити, від кого чекати пропозицію,
// щоб не прийняти підроблену від шахрая з таким самим предметом.
function showSellResult(data) {
  if (sellResultTitle) sellResultTitle.textContent = sellResultTitleText;
  renderSellOffer(data);
  sellResultModal.style.display = "flex";
  watchSale(data);
}

function renderSellOffer(data) {
  const bot = data.profileDetails || {};
  const offerUrl = data.offerId ? `https://steamcommunity.com/tradeoffer/${data.offerId}/` : null;
  const profileUrl = data.steamId ? `https://steamcommunity.com/profiles/${data.steamId}` : null;
  const registered = bot.registrationDate
    ? new Date(bot.registrationDate).toLocaleDateString(CFG.dateLocale)
    : null;

  sellResultBody.innerHTML = `
    <p class="sell-result-lead">${escapeHtml(acceptOnlyVia)}</p>
    ${
      offerUrl
        ? `<a class="btn-gold sell-result-open" href="${escapeHtml(offerUrl)}" target="_blank">${escapeHtml(CFG.openOfferBtn)}</a>
           <p class="sell-result-url">${escapeHtml(offerUrl)}</p>`
        : `<p class="card-hint">${escapeHtml(offerLinkPending)}</p>`
    }
    <p class="sell-result-waiting">${escapeHtml(CFG.waitingForAccept)}</p>
    <div class="unstable sell-result-warning">${escapeHtml(scamWarning)}</div>

    <h4 class="sell-result-subtitle">${escapeHtml(senderTitle)}</h4>
    <div class="sender-card">
      ${bot.profileImageUrl ? `<img class="sender-avatar" src="${escapeHtml(bot.profileImageUrl)}" alt="" />` : ""}
      <div class="sender-info">
        <div class="sender-name">${escapeHtml(bot.displayName || "—")}</div>
        <div class="sender-line">${escapeHtml(steamIdLabel)}: ${escapeHtml(data.steamId || "—")}</div>
        ${bot.level != null ? `<div class="sender-line">${escapeHtml(levelLabel)}: ${bot.level}</div>` : ""}
        ${registered ? `<div class="sender-line">${escapeHtml(registeredLabel)}: ${escapeHtml(registered)}</div>` : ""}
        ${profileUrl ? `<a class="sender-line" href="${escapeHtml(profileUrl)}" target="_blank">${escapeHtml(openProfile)} →</a>` : ""}
      </div>
    </div>`;
}

// Поки вікно відкрите, самі стежимо за угодою: щойно клієнт прийме обмін,
// вікно змінюється на "предмет отримано". Без цього воно так і висіло з
// "бот надішле обмін", хоча все вже відбулося (скарга клієнта).
// Кожен запит смикає статус у Skinbux, тож не частіше ніж раз на 8 с і не
// довше пів години — далі обмін однаково протухає, а угода є в "Моїх угодах".
const SALE_WATCH_INTERVAL_MS = 8000;
const SALE_WATCH_MAX_MS = 30 * 60 * 1000;
let saleWatchTimer = null;
let saleWatchGen = 0;

function stopSaleWatch() {
  clearTimeout(saleWatchTimer);
  saleWatchGen++;
}

function watchSale(data) {
  stopSaleWatch();
  const gen = saleWatchGen;
  const startedAt = Date.now();

  const tick = async () => {
    let sale = null;
    let holdDays = null;
    try {
      const res = await fetch("/api/account/sales");
      const body = await res.json();
      sale = (body.sales || []).find((s) => String(s.id) === String(data.id)) || null;
      holdDays = body.holdDays;
    } catch {
      // мережа моргнула — спробуємо на наступному колі
    }
    // Вікно закрили або вже почався інший продаж — цей стеж більше не потрібен.
    if (gen !== saleWatchGen) return;

    if (sale && (sale.status === "hold" || sale.status === "completed")) return showSaleReceived(sale, holdDays);
    if (sale && (sale.status === "cancelled" || sale.status === "reverted")) return showSaleCancelled();
    if (sale?.offerId && !data.offerId) {
      data.offerId = sale.offerId;
      renderSellOffer(data);
    }
    if (Date.now() - startedAt < SALE_WATCH_MAX_MS) saleWatchTimer = setTimeout(tick, SALE_WATCH_INTERVAL_MS);
  };

  saleWatchTimer = setTimeout(tick, SALE_WATCH_INTERVAL_MS);
}

function showSaleReceived(sale, holdDays) {
  stopSaleWatch();
  const amount = `$${Number(sale.totalPrice).toFixed(2)}`;
  let text;
  if (sale.status === "hold") {
    const days = holdDays || 7;
    const unlockAt = sale.unlockAt ? new Date(sale.unlockAt) : new Date(Date.now() + days * 86400000);
    const date = unlockAt.toLocaleDateString(CFG.dateLocale, { day: "numeric", month: "long" });
    text = fillSaleText(CFG.receivedHoldText, { amount, date, days });
  } else {
    text = fillSaleText(CFG.receivedAvailableText, { amount });
  }

  if (sellResultTitle) sellResultTitle.textContent = CFG.receivedTitle;
  sellResultBody.innerHTML = `
    <div class="sell-received">
      <div class="sell-received-icon">✓</div>
      <p class="sell-received-lead">${escapeHtml(CFG.receivedLead)}</p>
      <p class="sell-received-text">${text}</p>
      <button id="sellResultDealsBtn" class="btn-gold" type="button">${escapeHtml(CFG.myDealsBtn)}</button>
    </div>`;
  document.getElementById("sellResultDealsBtn").addEventListener("click", () => {
    sellResultModal.style.display = "none";
    document.getElementById("accountPillBtn")?.click();
  });

  // Шапка й інвентар теж уже застаріли: предмет пішов, гроші лягли в холд.
  window.refreshNavBalance?.();
  inventoryRetries = 0;
  loadInventory({ refresh: true });
}

function showSaleCancelled() {
  stopSaleWatch();
  if (sellResultTitle) sellResultTitle.textContent = CFG.cancelledTitle;
  sellResultBody.innerHTML = `
    <div class="sell-received sell-received-cancelled">
      <div class="sell-received-icon">✕</div>
      <p class="sell-received-text">${escapeHtml(CFG.cancelledText)}</p>
    </div>`;
  inventoryRetries = 0;
  loadInventory({ refresh: true });
}

// Шаблон з {amount}/{date}/{days}: сам текст екрануємо, підставлені значення
// виділяємо жирним.
function fillSaleText(template, vars) {
  return escapeHtml(template || "").replace(/\{(\w+)\}/g, (m, key) =>
    key in vars ? `<b>${escapeHtml(String(vars[key]))}</b>` : m
  );
}

// Кнопка "Оновити": просить сервер сходити в Steam повз кеш. Потрібна, бо
// щойно отриманий предмет інакше не з'явиться, доки кеш не протухне.
const inventoryRefreshBtn = document.getElementById("inventoryRefreshBtn");
inventoryRefreshBtn?.addEventListener("click", () => {
  inventoryRetries = 0;
  loadInventory({ refresh: true });
});

async function loadInventory({ refresh = false } = {}) {
  if (inventoryRefreshBtn) inventoryRefreshBtn.disabled = true;
  inventoryLoadingEl.style.display = "block";
  inventoryPrivateEl.style.display = "none";
  inventoryEmptyEl.style.display = "none";

  let data;
  try {
    const res = await fetch(`/api/account/inventory${refresh ? "?refresh=1" : ""}`);
    data = await res.json();
  } catch {
    data = { ok: false, error: "NETWORK" };
  }

  inventoryLoadingEl.style.display = "none";
  if (inventoryRefreshBtn) inventoryRefreshBtn.disabled = false;

  if (!data.ok) {
    // Тимчасові причини (ціни на сервері ще не завантажились; Steam ліміт по
    // IP) — не помилка інвентарю клієнта: показуємо, що чекаємо, і пробуємо
    // ще раз самі, замість поради міняти приватність, яка тут ні до чого.
    // Спроб рівно MAX_RETRIES: нескінченний цикл повторів сам тримав би
    // Steam у ліміті, з якого сторінка вже не вийшла б.
    const retryMessage = { PRICES_NOT_READY: pricesLoading, STEAM_RATE_LIMITED: steamBusy }[data.error];
    if (retryMessage) {
      inventoryLoadingEl.textContent = retryMessage;
      inventoryLoadingEl.style.display = "block";
      if (inventoryRetries < MAX_RETRIES) {
        inventoryRetries += 1;
        setTimeout(loadInventory, 8000);
      }
      return;
    }
    inventoryPrivateEl.style.display = "block";
    return;
  }

  inventoryRetries = 0;
  inventoryItems = data.items;
  renderInventoryList();
}

function renderInventoryList() {
  if (!inventoryItems.length) {
    inventoryEmptyEl.style.display = "block";
    inventoryListEl.innerHTML = "";
    return;
  }
  inventoryEmptyEl.style.display = "none";

  const visible = filters.apply(inventoryItems);
  if (!visible.length) {
    inventoryListEl.innerHTML = `<p class="filters-empty">${escapeHtml(nothingFound)}</p>`;
    return;
  }

  inventoryListEl.innerHTML = visible
    .map((it) => {
      const img = it.icon ? `<img class="inventory-card-img" src="${escapeHtml(it.icon)}" alt="" />` : "";
      const nameHtml = `${escapeHtml(it.name)}${it.wear ? `<br><span class="cart-item-price" style="font-size:11px;color:var(--muted);font-weight:400;">${escapeHtml(it.wear)}</span>` : ""}`;

      // Предмет у трейд-бані показуємо, але продати його не можна, поки Steam
      // його не відпустить — раніше такі просто зникали зі списку.
      if (!it.tradable) {
        return `
          <div class="inventory-card">
            ${img}
            <div class="inventory-card-name">${nameHtml}</div>
            <span class="lock-tag locked">🔒 ${escapeHtml(it.tradableAfter || tradeLockedLabel)}</span>
            ${it.price != null ? `<span class="inventory-card-price">$${it.price.toFixed(2)}</span>` : ""}
          </div>`;
      }

      // Skinbux цей предмет не приймає — показуємо, але без кнопки продажу.
      // Раніше клієнт дізнавався про це лише коли тиснув "Продати".
      if (it.sellAccept === false) {
        return `
          <div class="inventory-card">
            ${img}
            <div class="inventory-card-name">${nameHtml}</div>
            <span class="inventory-card-na">${escapeHtml(unavailableLabel)}</span>
          </div>`;
      }

      if (it.price == null) {
        return `
          <div class="inventory-card">
            ${img}
            <div class="inventory-card-name">${nameHtml}</div>
            <span class="inventory-card-na">${priceUnknown}</span>
          </div>`;
      }

      const added = cart.some((c) => c.assetId === it.assetId);
      return `
        <div class="inventory-card">
          ${img}
          <div class="inventory-card-name">${nameHtml}</div>
          <span class="inventory-card-price">$${it.price.toFixed(2)}</span>
          <button class="skin-item-add" type="button" data-asset="${escapeHtml(it.assetId)}" ${added ? "disabled" : ""}>${added ? addedLabel : addLabel}</button>
        </div>`;
    })
    .join("");

  inventoryListEl.querySelectorAll("[data-asset]").forEach((btn) => {
    btn.addEventListener("click", () => addItem(btn.getAttribute("data-asset")));
  });
}

// Кожен фізичний предмет (assetId) можна додати в кошик лише один раз —
// кількість = скільки таких предметів реально є в інвентарі, не більше.
function addItem(assetId) {
  const item = inventoryItems.find((it) => it.assetId === assetId);
  if (!item || item.price == null) return;
  if (cart.some((c) => c.assetId === assetId)) return;

  cart.push({ assetId, marketHashName: item.marketHashName, price: item.price });
  renderInventoryList();
  renderCart();
}

function removeItem(assetId) {
  cart = cart.filter((it) => it.assetId !== assetId);
  renderInventoryList();
  renderCart();
}

function renderCart() {
  if (!cart.length) {
    cartSection.style.display = "none";
    cartList.innerHTML = "";
    return;
  }

  cartSection.style.display = "block";
  cartList.innerHTML = cart
    .map(
      (it) => `
        <div class="cart-item">
          <span class="cart-item-name">${escapeHtml(it.marketHashName)}</span>
          <span class="cart-item-price">$${it.price.toFixed(2)}</span>
          <button class="cart-item-remove" type="button" data-asset="${escapeHtml(it.assetId)}" title="${escapeHtml(removeLabel)}">✕</button>
        </div>`
    )
    .join("");

  cartList.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeItem(btn.getAttribute("data-asset")));
  });

  const total = cart.reduce((sum, it) => sum + it.price, 0);
  cartTotal.textContent = `$${total.toFixed(2)}`;
  sellStatusEl.textContent = "";
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
