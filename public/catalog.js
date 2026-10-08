// Каталог "Купити скіни": весь прайс Youpin з нашою націнкою, вкладками по
// категоріях, пошуком і фільтрами.
//
// Складу ми не тримаємо — купуємо під замовлення, тому тут один рядок на
// предмет, а не окремі лоти з конкретним float: такі дані дає лише платний
// доступ до сирих листингів, у нас його немає, і вигадувати числа не можна.
//
// Фільтри й сторінки рахує сервер (/api/public/catalog): предметів сорок
// тисяч, у браузер їх не віддати.
const C = window.CATALOG_CONFIG;
const TELEGRAM = "https://t.me/gabenmarket_support";

const grid = document.getElementById("catalogGrid");
const statusEl = document.getElementById("catalogStatus");
const pager = document.getElementById("catalogPager");
const pageLabel = document.getElementById("catalogPageLabel");

const state = { q: "", category: "", sort: "price_desc", min: "", max: "", wear: new Set(), special: "", page: 1, weapons: new Set() };

// Списки зброї приходять із першою відповіддю каталогу: вкладка "Ножі"
// розкривається переліком ножів, і там можна обрати конкретні.
let weaponsByCategory = null;

// Кошик переживає перезавантаження: людина може піти порівняти ціни й
// повернутись, і втрачати вибране на цьому не повинна.
const CART_KEY = "buyCart";
let cart = loadCart();

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // приватний режим — просто не запам'ятаємо
  }
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function esc(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const WEAR_CODES = {
  "Factory New": "FN",
  "Minimal Wear": "MW",
  "Field-Tested": "FT",
  "Well-Worn": "WW",
  "Battle-Scarred": "BS",
};

// ---- Каталог ----
let loadSeq = 0;

async function loadCatalog() {
  const seq = ++loadSeq;
  statusEl.style.display = "block";
  statusEl.textContent = C.loading;

  const params = new URLSearchParams({ page: state.page, sort: state.sort });
  if (state.q) params.set("q", state.q);
  if (state.category) params.set("category", state.category);
  if (state.min) params.set("min", state.min);
  if (state.max) params.set("max", state.max);
  if (state.wear.size) params.set("wear", [...state.wear].join(","));
  if (state.weapons.size) params.set("weapon", [...state.weapons].join(","));
  if (state.special) params.set("special", state.special);

  let data;
  try {
    data = await (await fetch(`/api/public/catalog?${params}`)).json();
  } catch {
    data = { ok: false };
  }
  // Поки відповідь ішла, людина могла змінити фільтр — тоді ця вже не потрібна.
  if (seq !== loadSeq) return;

  if (data.weapons && !weaponsByCategory) {
    weaponsByCategory = data.weapons;
    buildCategoryMenus();
  }

  if (!data.ok || !data.items.length) {
    grid.innerHTML = "";
    pager.style.display = "none";
    statusEl.textContent = C.nothing;
    return;
  }

  statusEl.style.display = "none";
  grid.innerHTML = data.items.map(cardHtml).join("");
  grid.querySelectorAll("[data-name]").forEach((card) => {
    card.addEventListener("click", () => toggleItem(card.dataset.name, data.items));
  });

  pager.style.display = data.pages > 1 ? "flex" : "none";
  pageLabel.textContent = `${C.page.replace("{n}", data.page).replace("{all}", data.pages)} · ${C.found.replace(
    "{n}",
    data.total
  )}`;
  document.getElementById("catalogPrev").disabled = data.page <= 1;
  document.getElementById("catalogNext").disabled = data.page >= data.pages;
}

function cardHtml(it) {
  const picked = cart.some((c) => c.marketHashName === it.marketHashName);
  const code = WEAR_CODES[it.wear] || "";
  const [weapon, skin] = String(it.name).split(" | ");
  const img = it.icon ? `<img class="inventory-card-img" src="${esc(it.icon)}" alt="" />` : "";

  return `
    <div class="inventory-card selectable${picked ? " selected" : ""}" data-name="${esc(it.marketHashName)}" role="button" tabindex="0">
      ${picked ? '<span class="inventory-card-check">✓</span>' : ""}
      ${code ? `<div class="inventory-card-top"><span class="wear-code wear-${code}">${code}</span></div>` : ""}
      ${img}
      <div class="inventory-card-name">
        ${skin ? `<span class="item-weapon">${esc(weapon)}</span><span class="item-skin">${esc(skin)}</span>` : `<span class="item-skin">${esc(weapon)}</span>`}
      </div>
      <span class="inventory-card-price">${money(it.price)}</span>
    </div>`;
}

function toggleItem(marketHashName, items) {
  const at = cart.findIndex((c) => c.marketHashName === marketHashName);
  if (at >= 0) cart.splice(at, 1);
  else {
    const it = items.find((i) => i.marketHashName === marketHashName);
    if (it) cart.push({ marketHashName: it.marketHashName, name: it.name, wear: it.wear, price: it.price, icon: it.icon });
  }
  saveCart();
  renderCart();
  loadCatalog();
}

// ---- Кошик ----
// Оплати на сайті поки немає: кнопка збирає готове повідомлення в Telegram зі
// списком і сумою, щоб людині не довелось переписувати назви руками.
function renderCart() {
  const list = document.getElementById("cartList");
  const total = cart.reduce((sum, it) => sum + it.price, 0);

  document.getElementById("cartCount").textContent = String(cart.length);
  document.getElementById("cartTotalTop").textContent = money(total);
  document.getElementById("cartTotal").textContent = money(total);
  document.getElementById("cartEmptyLine").style.display = cart.length ? "none" : "block";

  list.innerHTML = cart
    .map(
      (it) => `
        <div class="cart-item">
          ${it.icon ? `<img class="cart-item-img" src="${esc(it.icon)}" alt="" />` : ""}
          <span class="cart-item-name">${esc(it.name)}<br /><span class="na">${esc(it.wear || "")}</span></span>
          <span class="cart-item-price">${money(it.price)}</span>
          <button class="cart-item-remove" type="button" data-remove="${esc(it.marketHashName)}">✕</button>
        </div>`
    )
    .join("");

  list.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      cart = cart.filter((c) => c.marketHashName !== btn.dataset.remove);
      saveCart();
      renderCart();
      loadCatalog();
    });
  });

  const lines = [C.msgIntro, "", ...cart.map((it) => `• ${it.marketHashName} — ${money(it.price)}`), "", `${C.msgTotal} ${money(total)}`];
  const link = document.getElementById("cartTelegramLink");
  link.href = cart.length ? `${TELEGRAM}?text=${encodeURIComponent(lines.join("\n"))}` : TELEGRAM;
  link.classList.toggle("disabled", !cart.length);
}

document.getElementById("cartOpenBtn").addEventListener("click", () => {
  document.getElementById("cartModal").style.display = "flex";
});
document.getElementById("cartModalClose").addEventListener("click", () => {
  document.getElementById("cartModal").style.display = "none";
});
document.getElementById("cartClearBtn").addEventListener("click", () => {
  cart = [];
  saveCart();
  renderCart();
  loadCatalog();
});

// ---- Фільтри ----
let searchTimer;
document.getElementById("catalogSearch").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    state.page = 1;
    loadCatalog();
  }, 250);
});

document.getElementById("catalogSort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  state.page = 1;
  loadCatalog();
});

// ---- Вкладки категорій і випадайки зі зброєю ----
// Клік по вкладці перемикає категорію; якщо всередині є конкретна зброя —
// під вкладкою розкривається список, де можна лишити тільки потрібне.
function buildCategoryMenus() {
  document.querySelectorAll(".catalog-tab").forEach((tab) => {
    const category = tab.dataset.category;
    const list = weaponsByCategory[category];
    if (!list?.length) return;

    tab.classList.add("has-menu");
    const menu = document.createElement("div");
    menu.className = "catalog-menu";
    menu.innerHTML = `
      <label class="catalog-menu-all"><input type="checkbox" data-all="1" /> ${esc(C.selectAll || "Select all")}</label>
      ${list.map((w) => `<label><input type="checkbox" value="${esc(w)}" /> ${esc(w)}</label>`).join("")}`;
    tab.parentElement.insertBefore(menu, tab.nextSibling);
    tab.menu = menu;

    menu.addEventListener("change", (e) => {
      const box = e.target;
      if (box.dataset.all) {
        menu.querySelectorAll('input[value]').forEach((b) => (b.checked = box.checked));
      }
      // Вибрана зброя має сенс лише разом зі своєю категорією.
      state.category = category;
      state.weapons = new Set([...menu.querySelectorAll("input[value]:checked")].map((b) => b.value));
      state.page = 1;
      markActiveTab(tab);
      loadCatalog();
    });
  });
}

function markActiveTab(tab) {
  document.querySelectorAll(".catalog-tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
}

function closeMenus(except) {
  document.querySelectorAll(".catalog-menu.open").forEach((m) => {
    if (m !== except) m.classList.remove("open");
  });
}

document.querySelectorAll(".catalog-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    const switching = state.category !== (tab.dataset.category || "");
    markActiveTab(tab);
    state.category = tab.dataset.category || "";
    // Переходиш в іншу категорію — вибрана зброя попередньої більше не діє.
    if (switching) {
      state.weapons.clear();
      document.querySelectorAll(".catalog-menu input").forEach((b) => (b.checked = false));
    }
    state.page = 1;

    if (tab.menu) {
      const open = !tab.menu.classList.contains("open");
      closeMenus(tab.menu);
      tab.menu.classList.toggle("open", open);
    } else {
      closeMenus();
    }
    loadCatalog();
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".catalog-menu")) closeMenus();
});

for (const id of ["catalogMin", "catalogMax"]) {
  document.getElementById(id).addEventListener("input", (e) => {
    state[id === "catalogMin" ? "min" : "max"] = e.target.value;
    state.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCatalog, 350);
  });
}

document.querySelectorAll("[data-wear]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const code = btn.dataset.wear;
    btn.classList.toggle("active");
    if (state.wear.has(code)) state.wear.delete(code);
    else state.wear.add(code);
    state.page = 1;
    loadCatalog();
  });
});

document.querySelectorAll('input[name="special"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    state.special = radio.value;
    state.page = 1;
    loadCatalog();
  });
});

document.getElementById("catalogReset").addEventListener("click", () => {
  state.q = state.min = state.max = state.special = "";
  state.wear.clear();
  state.weapons.clear();
  document.querySelectorAll(".catalog-menu input").forEach((b) => (b.checked = false));
  state.page = 1;
  document.getElementById("catalogSearch").value = "";
  document.getElementById("catalogMin").value = "";
  document.getElementById("catalogMax").value = "";
  document.querySelectorAll("[data-wear]").forEach((b) => b.classList.remove("active"));
  document.querySelector('input[name="special"][value=""]').checked = true;
  loadCatalog();
});

document.getElementById("catalogPrev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page--;
    loadCatalog();
    window.scrollTo({ top: grid.offsetTop - 80, behavior: "smooth" });
  }
});
document.getElementById("catalogNext").addEventListener("click", () => {
  state.page++;
  loadCatalog();
  window.scrollTo({ top: grid.offsetTop - 80, behavior: "smooth" });
});

renderCart();
loadCatalog();
