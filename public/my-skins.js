// Публічна вітрина "Наші скіни в наявності" — не пошук по каталогу (як
// buy-quote), а фіксований список того, що реально лежить на руках у
// власника сайту (/api/public/my-skins), включно з предметами в трейд-бані.
// Локалізація — через window.MY_SKINS_CONFIG (кожна мовна версія сторінки
// задає свій текст перед підключенням цього файлу).
//
// Кожен елемент відповіді — окремий фізичний предмет, тому в кошик він
// додається рівно один раз: раніше кількість нарощувалась без обмеження, і
// можна було "забронювати" 32 ножі, коли в наявності 10.
const {
  lockedLabel,
  readyLabel,
  addLabel,
  addedLabel,
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
let cart = []; // індекси предметів у skins — по одному запису на кожен предмет

// Фільтри звужують те, що показано, але не чіпають кошик: якщо предмет уже
// доданий, він лишається в кошику, навіть коли випав з поточного фільтра.
const filters = createItemFilters({
  mount: document.getElementById("filtersPanel"),
  labels: {
    ...window.MY_SKINS_CONFIG,
    readyLabel: window.MY_SKINS_CONFIG.filtersReadyLabel,
    lockedLabel: window.MY_SKINS_CONFIG.filtersLockedLabel,
  },
  showStatus: true,
  onChange: renderSkinsList,
});

cartClearBtn.addEventListener("click", () => {
  cart = [];
  renderSkinsList();
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

  // Індекс у повному списку зберігаємо: кошик посилається саме на нього, тож
  // після зміни фільтра позначки "Додано" не з'їжджають на сусідні предмети.
  const visible = filters.apply(skins.map((s, idx) => ({ ...s, idx })));
  if (!visible.length) {
    skinsListEl.innerHTML = `<p class="filters-empty">${escapeHtml(window.MY_SKINS_CONFIG.nothingFound)}</p>`;
    return;
  }

  skinsListEl.innerHTML = visible
    .map((s) => {
      const idx = s.idx;
      return renderCard(s, idx);
    })
    .join("");

  skinsListEl.querySelectorAll(".skin-item-add").forEach((btn) => {
    btn.addEventListener("click", () => addItem(Number(btn.getAttribute("data-idx"))));
  });
}

function renderCard(s, idx) {
  const tag = s.isLocked
    ? `<span class="lock-tag locked">🔒 ${lockedLabel} ${formatUnlockDate(s.unlockAt)}</span>`
    : `<span class="lock-tag ready">✅ ${readyLabel}</span>`;
  const src = s.imageFull || s.image; // 96px іконки на картці помітно милять
  const img = src ? `<img class="inventory-card-img" src="${escapeHtml(src)}" alt="" />` : "";
  const added = cart.includes(idx);

  return `
    <div class="inventory-card">
      ${img}
      <div class="inventory-card-name">${escapeHtml(s.marketHashName)}</div>
      ${tag}
      <span class="inventory-card-price">$${s.price.toFixed(2)}</span>
      <button class="skin-item-add" type="button" data-idx="${idx}" ${added ? "disabled" : ""}>${
    added ? addedLabel : addLabel
  }</button>
    </div>`;
}

function addItem(idx) {
  if (!skins[idx] || cart.includes(idx)) return;
  cart.push(idx);
  renderSkinsList();
  renderCart();
}

function removeItem(idx) {
  cart = cart.filter((i) => i !== idx);
  renderSkinsList();
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
    .map((idx) => {
      const s = skins[idx];
      return `
        <div class="cart-item">
          <span class="cart-item-name">${escapeHtml(s.marketHashName)}</span>
          <span class="cart-item-price">$${s.price.toFixed(2)}</span>
          <button class="cart-item-remove" type="button" data-idx="${idx}" title="${escapeHtml(removeLabel)}">✕</button>
        </div>`;
    })
    .join("");

  cartList.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeItem(Number(btn.getAttribute("data-idx"))));
  });

  const total = cart.reduce((sum, idx) => sum + skins[idx].price, 0);
  cartTotal.textContent = `$${total.toFixed(2)}`;

  // У повідомленні однакові предмети згортаємо в один рядок з кількістю —
  // так зрозуміліше, ніж десять однакових рядків підряд.
  const grouped = new Map();
  for (const idx of cart) {
    const s = skins[idx];
    const entry = grouped.get(s.marketHashName) || { qty: 0, sum: 0 };
    entry.qty += 1;
    entry.sum += s.price;
    grouped.set(s.marketHashName, entry);
  }
  const lines = [...grouped].map(
    ([name, { qty, sum }]) => `${name}${qty > 1 ? ` × ${qty}` : ""} — $${sum.toFixed(2)}`
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
