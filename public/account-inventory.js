// Особистий кабінет: інвентар клієнта тягнеться напряму зі Steam
// (/api/account/inventory), і на кожен предмет одразу порахована ціна
// викупу — та сама формула, що на "Продати" (sellQuote.js), просто без
// ручного пошуку. Кошик і повідомлення в Telegram — той самий патерн, що на
// buy-quote/sell-quote (public/quote-common.js) і my-skins (public/my-skins.js).
const inventoryListEl = document.getElementById("inventoryList");
const inventoryLoadingEl = document.getElementById("inventoryLoading");
const inventoryPrivateEl = document.getElementById("inventoryPrivate");
const inventoryEmptyEl = document.getElementById("inventoryEmpty");
const cartSection = document.getElementById("cartSection");
const cartList = document.getElementById("cartList");
const cartTotal = document.getElementById("cartTotal");
const cartTelegramLink = document.getElementById("cartTelegramLink");
const cartClearBtn = document.getElementById("cartClearBtn");

let inventoryItems = [];
let cart = []; // { marketHashName, price, qty }

cartClearBtn?.addEventListener("click", () => {
  cart = [];
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
    inventoryPrivateEl.style.display = "block";
    return;
  }

  inventoryItems = data.items;
  renderInventoryList();
}

function renderInventoryList() {
  if (!inventoryItems.length) {
    inventoryEmptyEl.style.display = "block";
    inventoryListEl.innerHTML = "";
    return;
  }

  inventoryListEl.innerHTML = inventoryItems
    .map((it) => {
      const thumb = it.icon
        ? `<span class="skin-thumb-wrap"><img class="skin-thumb" src="${escapeHtml(it.icon)}" alt="" /></span>`
        : "";
      let status;
      let addBtn = "";
      if (!it.tradable) {
        status = `<span class="lock-tag locked">🔒 у трейд-бані</span>`;
      } else if (it.price == null) {
        status = `<span class="lock-tag locked">ціна невідома</span>`;
      } else {
        status = `<span class="cart-item-price">$${it.price.toFixed(2)}</span>`;
        addBtn = `<button class="skin-item-add" type="button" data-asset="${escapeHtml(it.assetId)}">Додати</button>`;
      }
      return `
        <div class="cart-item">
          ${thumb}
          <span class="cart-item-name">${escapeHtml(it.marketHashName)}</span>
          ${status}
          ${addBtn}
        </div>`;
    })
    .join("");

  inventoryListEl.querySelectorAll(".skin-item-add").forEach((btn) => {
    btn.addEventListener("click", () => addItem(btn.getAttribute("data-asset")));
  });
}

function addItem(assetId) {
  const item = inventoryItems.find((it) => it.assetId === assetId);
  if (!item || item.price == null) return;

  const existing = cart.find((it) => it.marketHashName === item.marketHashName);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ marketHashName: item.marketHashName, price: item.price, qty: 1 });
  }
  renderCart();
}

function removeItem(name) {
  cart = cart.filter((it) => it.marketHashName !== name);
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
          ${it.qty > 1 ? `<span class="cart-item-qty">× ${it.qty}</span>` : ""}
          <span class="cart-item-price">$${(it.price * it.qty).toFixed(2)}</span>
          <button class="cart-item-remove" type="button" data-name="${escapeHtml(it.marketHashName)}" title="Прибрати">✕</button>
        </div>`
    )
    .join("");

  cartList.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeItem(btn.getAttribute("data-name")));
  });

  const total = cart.reduce((sum, it) => sum + it.price * it.qty, 0);
  cartTotal.textContent = `$${total.toFixed(2)}`;

  const lines = cart.map(
    (it) => `${it.marketHashName}${it.qty > 1 ? ` × ${it.qty}` : ""} — $${(it.price * it.qty).toFixed(2)}`
  );
  const message = `Привіт! Хочу продати ці скіни зі свого інвентарю:\n${lines.join("\n")}\n\nРазом: $${total.toFixed(2)}.`;
  cartTelegramLink.href = `https://t.me/lxnmnk?text=${encodeURIComponent(message)}`;
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
