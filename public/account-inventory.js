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

// Кошик переживає перемикання мови (UA/RU/EN — різні сторінки). Зберігаємо
// лише assetId, а ціни при відновленні беремо свіжі з інвентарю.
const CART_KEY = "sellCart";
let cartRestored = false;

function saveCart() {
  if (!cartRestored) return; // інвентар ще не завантажився — не затираємо збережене
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart.map((it) => it.assetId)));
  } catch {
    // приватний режим — просто не запам'ятаємо
  }
}

function restoreCart() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
  } catch {
    saved = [];
  }
  cart = [];
  for (const assetId of Array.isArray(saved) ? saved : []) {
    const item = inventoryItems.find((it) => it.assetId === assetId);
    // Продане, у трейд-бані чи без ціни — у кошик не повертаємо.
    if (item && item.tradable && item.sellAccept !== false && item.price != null) {
      cart.push({ assetId, marketHashName: item.marketHashName, price: item.price });
    }
  }
  cartRestored = true;
}

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
    // Ціни, які клієнт бачив у кошику: сервер не продасть дешевше за них.
    body: JSON.stringify({
      assetIds: cart.map((it) => it.assetId),
      expectedPrices: Object.fromEntries(cart.map((it) => [it.assetId, it.price])),
    }),
  });
  const data = await res.json();

  sellAutoBtn.disabled = false;

  if (data.error === "PRICE_CHANGED") {
    await repriceCart();
    sellStatusEl.textContent = CFG.priceChanged;
    return;
  }
  if (!data.ok) {
    sellStatusEl.textContent = `${sellFailedPrefix}${data.error}`;
    return;
  }

  sellOfferModal.show(data);
  cart = [];
  renderInventoryList();
  renderCart();
});

// Ціна на Skinbux поїхала вниз: перечитуємо інвентар і ставимо в кошик нові
// ціни, щоб клієнт побачив суму, яку реально отримає, перш ніж тиснути знову.
// Те, що зникло з інвентарю або лишилось без ціни, з кошика прибираємо.
async function repriceCart() {
  inventoryRetries = 0;
  await loadInventory({ refresh: true });
  cart = cart
    .map((c) => {
      const fresh = inventoryItems.find((it) => it.assetId === c.assetId);
      return fresh && fresh.price != null ? { ...c, price: fresh.price } : null;
    })
    .filter(Boolean);
  renderInventoryList();
  renderCart();
}

// Вікно "обмін надіслано" й стеж за угодою — спільний код із розділом Trade
// (sell-offer-modal.js). Тут лишається тільки те, що для кабінету своє: гроші
// лягають у холд на 7 днів, а після прийняття обміну є куди відправити —
// у "Мої угоди".
const sellOfferModal = createSellOfferModal({
  modal: sellResultModal,
  body: sellResultBody,
  title: sellResultTitle,
  closeBtn: document.getElementById("sellResultClose"),
  texts: {
    acceptOnlyVia,
    openOfferBtn: CFG.openOfferBtn,
    offerLinkPending,
    waitingForAccept: CFG.waitingForAccept,
    scamWarning,
    senderTitle,
    steamIdLabel,
    levelLabel,
    registeredLabel,
    openProfile,
    dateLocale: CFG.dateLocale,
    receivedTitle: CFG.receivedTitle,
    receivedLead: CFG.receivedLead,
    cancelledTitle: CFG.cancelledTitle,
    cancelledText: CFG.cancelledText,
  },
  receivedText: (sale, holdDays) => {
    const amount = `$${Number(sale.totalPrice).toFixed(2)}`;
    if (sale.status !== "hold") return fillSaleText(CFG.receivedAvailableText, { amount });
    const days = holdDays || 7;
    const unlockAt = sale.unlockAt ? new Date(sale.unlockAt) : new Date(Date.now() + days * 86400000);
    const date = unlockAt.toLocaleDateString(CFG.dateLocale, { day: "numeric", month: "long" });
    return fillSaleText(CFG.receivedHoldText, { amount, date, days });
  },
  receivedButton: { label: CFG.myDealsBtn, onClick: () => document.getElementById("accountPillBtn")?.click() },
  // Предмет пішов, гроші лягли в холд — шапка й інвентар уже застаріли.
  onFinished: () => {
    window.refreshNavBalance?.();
    inventoryRetries = 0;
    loadInventory({ refresh: true });
  },
});

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
  if (!cartRestored) {
    restoreCart();
    renderCart();
  }
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
  saveCart();
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
