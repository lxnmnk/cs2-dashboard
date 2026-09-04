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
  sellSuccessPrefix,
  sellSuccessFromWord,
  sellSuccessSuffix,
  priceUnknown,
  addLabel,
  addedLabel,
  removeLabel,
} = window.ACCOUNT_CONFIG;

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

const MAX_RETRIES = 3;

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

  sellStatusEl.innerHTML = `${sellSuccessPrefix}${data.profileDetails ? `${sellSuccessFromWord}<b>${escapeHtml(data.profileDetails.displayName)}</b>` : ""}${sellSuccessSuffix}`;
  cart = [];
  renderInventoryList();
  renderCart();
});

async function loadInventory() {
  inventoryLoadingEl.style.display = "block";
  inventoryPrivateEl.style.display = "none";
  inventoryEmptyEl.style.display = "none";

  let data;
  try {
    const res = await fetch("/api/account/inventory");
    data = await res.json();
  } catch {
    data = { ok: false, error: "NETWORK" };
  }

  inventoryLoadingEl.style.display = "none";

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

  inventoryListEl.innerHTML = inventoryItems
    .map((it) => {
      const img = it.icon ? `<img class="inventory-card-img" src="${escapeHtml(it.icon)}" alt="" />` : "";
      const nameHtml = `${escapeHtml(it.name)}${it.wear ? `<br><span class="cart-item-price" style="font-size:11px;color:var(--muted);font-weight:400;">${escapeHtml(it.wear)}</span>` : ""}`;

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
