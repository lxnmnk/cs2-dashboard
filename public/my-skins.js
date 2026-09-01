// Публічна вітрина "Мої скіни в наявності" — не пошук по каталогу (як
// buy-quote), а фіксований список того, що реально лежить на руках у
// власника сайту (/api/public/my-skins), включно з предметами в трейд-бані.
// Локалізація — через window.MY_SKINS_CONFIG (кожна мовна версія сторінки
// задає свій текст перед підключенням цього файлу).
const {
  lockedLabel,
  readyLabel,
  addLabel,
  messageIntro,
  totalLabel,
  priceNote,
  removeLabel,
} = window.MY_SKINS_CONFIG;

const skinsListEl = document.getElementById("skinsList");
const emptyStateEl = document.getElementById("emptyState");
const cartSection = document.getElementById("cartSection");
const cartList = document.getElementById("cartList");
const cartTotal = document.getElementById("cartTotal");
const cartTelegramLink = document.getElementById("cartTelegramLink");
const cartClearBtn = document.getElementById("cartClearBtn");

let skins = [];
let cart = []; // { marketHashName, price, qty }

cartClearBtn.addEventListener("click", () => {
  cart = [];
  renderCart();
});

async function loadSkins() {
  const res = await fetch("/api/public/my-skins");
  skins = await res.json();
  renderSkinsList();
}

function formatUnlockDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function renderSkinsList() {
  if (!skins.length) {
    emptyStateEl.style.display = "block";
    skinsListEl.innerHTML = "";
    return;
  }
  emptyStateEl.style.display = "none";

  skinsListEl.innerHTML = skins
    .map((s) => {
      const tag = s.isLocked
        ? `<span class="lock-tag locked">🔒 ${lockedLabel} ${formatUnlockDate(s.unlockAt)}</span>`
        : `<span class="lock-tag ready">✅ ${readyLabel}</span>`;
      const thumb = s.image
        ? `<span class="skin-thumb-wrap">
             <img class="skin-thumb" src="${escapeHtml(s.image)}" alt="" />
             <img class="skin-thumb-full" src="${escapeHtml(s.imageFull || s.image)}" alt="" />
           </span>`
        : "";
      return `
        <div class="cart-item">
          ${thumb}
          <span class="cart-item-name">${escapeHtml(s.marketHashName)}${tag}</span>
          <span class="cart-item-price">$${s.price.toFixed(2)}</span>
          <button class="skin-item-add" type="button" data-name="${escapeHtml(s.marketHashName)}">${addLabel}</button>
        </div>`;
    })
    .join("");

  skinsListEl.querySelectorAll(".skin-item-add").forEach((btn) => {
    btn.addEventListener("click", () => addItem(btn.getAttribute("data-name")));
  });
}

function addItem(name) {
  const skin = skins.find((s) => s.marketHashName === name);
  if (!skin) return;

  const existing = cart.find((it) => it.marketHashName === name);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ marketHashName: name, price: skin.price, qty: 1 });
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
          <button class="cart-item-remove" type="button" data-name="${escapeHtml(it.marketHashName)}" title="${escapeHtml(removeLabel)}">✕</button>
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
  const message = `${messageIntro}\n${lines.join("\n")}\n\n${totalLabel} $${total.toFixed(2)} (${priceNote}).`;
  cartTelegramLink.href = `https://t.me/lxnmnk?text=${encodeURIComponent(message)}`;
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

loadSkins();
