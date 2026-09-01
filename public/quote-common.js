// Спільна логіка "пошук предмета -> кошик -> сума -> Telegram" для всіх
// мовних версій публічних сторінок (sell-quote*.html/buy-quote*.html). Що
// питати і якою мовою писати — задається через window.QUOTE_CONFIG, який
// кожна сторінка визначає в невеликому inline-скрипті перед підключенням
// цього файлу:
//   window.QUOTE_CONFIG = {
//     quoteEndpoint: "/api/public/sell-quote",
//     messageIntro: "Привіт! Хочу продати:",   // перший рядок Telegram-повідомлення
//     totalLabel: "Разом:",                     // підпис перед сумою в повідомленні
//     priceNote: "за ціною з сайту",             // хвіст повідомлення в дужках
//     removeLabel: "Прибрати",                   // title кнопки видалення з кошика
//     uah: { enabled: true, rate: 45 },           // показувати ціну ще й в гривнях
//   };
const { quoteEndpoint, messageIntro, totalLabel, priceNote, removeLabel, uah } = window.QUOTE_CONFIG;

const searchInput = document.getElementById("itemSearch");
const autocompleteList = document.getElementById("autocompleteList");
const unstableBox = document.getElementById("unstableBox");
const cartSection = document.getElementById("cartSection");
const cartList = document.getElementById("cartList");
const cartTotal = document.getElementById("cartTotal");
const cartTelegramLink = document.getElementById("cartTelegramLink");
const cartClearBtn = document.getElementById("cartClearBtn");

// { marketHashName: string, price: number, qty: number }[] — один і той самий
// предмет, обраний повторно, збільшує qty замість дублювання рядка.
let cart = [];

let debounceTimer = null;

searchInput.addEventListener("input", () => {
  unstableBox.style.display = "none";
  const q = searchInput.value.trim();
  clearTimeout(debounceTimer);

  if (q.length < 2) {
    closeAutocomplete();
    return;
  }

  debounceTimer = setTimeout(async () => {
    const res = await fetch(`/api/public/item-search?q=${encodeURIComponent(q)}`);
    renderAutocomplete(await res.json());
  }, 250);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".autocomplete-wrap")) closeAutocomplete();
});

cartClearBtn.addEventListener("click", () => {
  cart = [];
  renderCart();
});

function renderAutocomplete(items) {
  if (!items.length) return closeAutocomplete();

  autocompleteList.innerHTML = items
    .map(
      (it) =>
        `<div class="autocomplete-item" data-name="${escapeHtml(it.marketHashName)}">${escapeHtml(
          it.name
        )} <span class="wear">${escapeHtml(it.wear || "")}</span></div>`
    )
    .join("");
  autocompleteList.classList.add("open");

  autocompleteList.querySelectorAll(".autocomplete-item").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.getAttribute("data-name");
      closeAutocomplete();
      searchInput.value = "";
      searchInput.focus();
      addItem(name);
    });
  });
}

function closeAutocomplete() {
  autocompleteList.classList.remove("open");
  autocompleteList.innerHTML = "";
}

async function addItem(name) {
  unstableBox.style.display = "none";
  const res = await fetch(`${quoteEndpoint}?name=${encodeURIComponent(name)}`);
  const data = await res.json();

  if (!data.ok) {
    unstableBox.style.display = "block";
    return;
  }

  const existing = cart.find((it) => it.marketHashName === name);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ marketHashName: name, price: data.price, qty: 1, image: data.image, imageFull: data.imageFull });
  }
  renderCart();
}

function removeItem(name) {
  cart = cart.filter((it) => it.marketHashName !== name);
  renderCart();
}

// "1234" -> "1 234" — розділювач тисяч, однаковий незалежно від мови сторінки.
function groupThousands(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// $25.05 -> "$25.05" або, якщо увімкнено uah, "$25.05 (1 127 ₴)".
function formatPrice(usd) {
  const usdStr = `$${usd.toFixed(2)}`;
  if (!uah?.enabled) return usdStr;
  const uahAmount = groupThousands(Math.round(usd * uah.rate));
  return `${usdStr} (${uahAmount} ₴)`;
}

function renderCart() {
  if (!cart.length) {
    cartSection.style.display = "none";
    cartList.innerHTML = "";
    return;
  }

  cartSection.style.display = "block";
  cartList.innerHTML = cart
    .map((it) => {
      const thumb = it.image
        ? `<span class="skin-thumb-wrap">
             <img class="skin-thumb" src="${escapeHtml(it.image)}" alt="" />
             <img class="skin-thumb-full" src="${escapeHtml(it.imageFull || it.image)}" alt="" />
           </span>`
        : "";
      return `
        <div class="cart-item">
          ${thumb}
          <span class="cart-item-name">${escapeHtml(it.marketHashName)}</span>
          ${it.qty > 1 ? `<span class="cart-item-qty">× ${it.qty}</span>` : ""}
          <span class="cart-item-price">${formatPrice(it.price * it.qty)}</span>
          <button class="cart-item-remove" type="button" data-name="${escapeHtml(it.marketHashName)}" title="${escapeHtml(removeLabel)}">✕</button>
        </div>`;
    })
    .join("");

  cartList.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeItem(btn.getAttribute("data-name")));
  });

  const total = cart.reduce((sum, it) => sum + it.price * it.qty, 0);
  cartTotal.textContent = formatPrice(total);

  const lines = cart.map(
    (it) => `${it.marketHashName}${it.qty > 1 ? ` × ${it.qty}` : ""} — ${formatPrice(it.price * it.qty)}`
  );
  const message = `${messageIntro}\n${lines.join("\n")}\n\n${totalLabel} ${formatPrice(total)} (${priceNote}).`;
  cartTelegramLink.href = `https://t.me/lxnmnk?text=${encodeURIComponent(message)}`;
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
