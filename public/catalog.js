// Каталог "Купити скіни" (/api/public/market).
//
// Один рядок на предмет (стек) з ціною "від" і кількістю лотів. Перемикач
// Instant / P2P звужує до лотів у наявності (трейд за хвилини) або від
// продавців (до 12 год). Клік по картці відкриває сторінку предмета, де вже
// конкретні лоти з float і кнопкою "Купити" (market-item.js).
//
// Фільтри й сторінки рахує сервер: предметів десятки тисяч.
const C = window.CATALOG_CONFIG;

const grid = document.getElementById("catalogGrid");
const statusEl = document.getElementById("catalogStatus");
const pager = document.getElementById("catalogPager");
const pageLabel = document.getElementById("catalogPageLabel");

const state = {
  q: "",
  category: "",
  sort: "price_desc",
  min: "",
  max: "",
  wear: new Set(),
  special: "",
  page: 1,
  weapons: new Set(),
  delivery: "",
};

// Обраний тип доставки переживає перехід на сторінку предмета і назад.
// ?delivery=p2p у посиланні (стара /my-skins веде сюди) важливіший.
try {
  const fromUrl = new URLSearchParams(location.search).get("delivery");
  const saved = fromUrl ?? localStorage.getItem("buyDelivery");
  if (saved === "instant" || saved === "p2p") state.delivery = saved;
} catch {
  // приватний режим — просто не запам'ятаємо
}

const ownSection = document.getElementById("ownSection");
const ownGrid = document.getElementById("ownGrid");

// Наші власні скіни: окремим рядом над лотами майданчика. Трейд шлемо самі,
// тому це P2P; під трейдлоком — з датою, коли віддамо.
// Без фільтрів наших предметів понад сотню — увесь ряд закрив би ринок.
// Показуємо перші OWN_PREVIEW, решту — по кнопці.
const OWN_PREVIEW = 12;
let ownExpanded = false;

function renderOwn(own) {
  if (!ownSection) return;
  const list = own || [];
  ownSection.style.display = list.length ? "block" : "none";
  const shown = ownExpanded ? list : list.slice(0, OWN_PREVIEW);
  ownGrid.innerHTML =
    shown.map(ownCardHtml).join("") +
    (list.length > shown.length
      ? `<button id="ownShowAll" class="btn-outline own-show-all" type="button">${esc(C.showAll.replace("{n}", list.length))}</button>`
      : "");
  document.getElementById("ownShowAll")?.addEventListener("click", () => {
    ownExpanded = true;
    renderOwn(list);
  });
}

function ownCardHtml(it) {
  const [weapon, skin] = String(it.name).replace(/^★ /, "").split(" | ");
  const tags = [
    it.wear ? `<span class="wear-code wear-${esc(it.wear)}">${esc(it.wear)}</span>` : "",
    it.phase ? `<span class="item-phase">${esc(it.phase)}</span>` : "",
    it.stattrak ? '<span class="tag-stattrak">ST</span>' : "",
    it.souvenir ? '<span class="tag-souvenir">SV</span>' : "",
  ].filter(Boolean);
  const days = it.locked ? Math.max(1, Math.ceil((new Date(it.unlockAt) - Date.now()) / 86400000)) : 0;
  return `
    <a class="inventory-card selectable market-card" href="${esc(`${C.itemUrl}?own=${encodeURIComponent(it.ownId)}`)}">
      ${tags.length ? `<div class="inventory-card-top">${tags.join('<span class="dot">·</span>')}</div>` : ""}
      ${it.icon ? `<img class="inventory-card-img" src="${esc(it.icon)}" alt="" loading="lazy" />` : ""}
      <div class="inventory-card-name">
        ${skin ? `<span class="item-weapon">${esc(weapon)}</span><span class="item-skin">${esc(skin)}</span>` : `<span class="item-skin">${esc(weapon)}</span>`}
      </div>
      <div class="market-card-meta">
        <span class="delivery-tag p2p"><span class="delivery-dot p2p"></span>P2P</span>
        ${it.float != null ? `<span class="market-card-float">${Number(it.float).toFixed(4)}</span>` : ""}
      </div>
      ${days ? `<span class="card-lock">🔒 ${esc(C.lockedDays.replace("{n}", days))}</span>` : ""}
      <span class="inventory-card-price">${money(it.price)}</span>
    </a>`;
}

// Списки зброї приходять із першою відповіддю каталогу: вкладка "Ножі"
// розкривається переліком ножів, і там можна обрати конкретні.
let weaponsByCategory = null;

// Валюту обирає людина (currency.js): усередині все лишається в доларах,
// змінюється тільки те, як число показано.
function money(n) {
  return window.fmtPrice ? window.fmtPrice(n) : `$${(Number(n) || 0).toFixed(2)}`;
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/** Введене людиною число -> долари, в яких рахує сервер. */
function toUsd(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return "";
  return window.Currency?.code === "UAH" ? (n / (window.Currency.rate || 45.5)).toFixed(2) : String(n);
}

// Підписи полів ціни показують ту валюту, яку обрала людина.
(function markCurrencyInFilters() {
  const symbol = window.Currency?.code === "UAH" ? "₴" : "$";
  document.querySelectorAll(".catalog-filters .filters-range label").forEach((label) => {
    label.childNodes.forEach((node) => {
      if (node.nodeType === 3 && node.textContent.includes("$")) {
        node.textContent = node.textContent.replace("$", symbol);
      }
    });
  });
})();

function itemUrl(it) {
  const p = new URLSearchParams({ id: it.stackId });
  if (state.delivery) p.set("delivery", state.delivery);
  return `${C.itemUrl}?${p}`;
}

// ---- Каталог ----
let loadSeq = 0;

async function loadCatalog() {
  const seq = ++loadSeq;
  statusEl.style.display = "block";
  statusEl.textContent = C.loading;
  // Сітка з сірих карток на час запиту: ряд порожнечі з написом "Завантажую"
  // виглядає як зламана сторінка, особливо коли міняєш фільтр і чекаєш.
  grid.innerHTML = Array.from({ length: 12 })
    .map(
      () => `<div class="inventory-card skeleton-card">
          <div class="skeleton-box skeleton-img"></div>
          <div class="skeleton-box skeleton-line"></div>
          <div class="skeleton-box skeleton-line short"></div>
        </div>`
    )
    .join("");

  const params = new URLSearchParams({ page: state.page, sort: state.sort });
  if (state.q) params.set("q", state.q);
  if (state.category) params.set("category", state.category);
  // Сервер рахує в доларах, а людина вводить у своїй валюті — переводимо тут.
  if (state.min) params.set("min", toUsd(state.min));
  if (state.max) params.set("max", toUsd(state.max));
  if (state.wear.size) params.set("wear", [...state.wear].join(","));
  if (state.weapons.size) params.set("weapon", [...state.weapons].join(","));
  if (state.special) params.set("special", state.special);
  if (state.delivery) params.set("delivery", state.delivery);

  let data;
  try {
    data = await (await fetch(`/api/public/market?${params}`)).json();
  } catch {
    data = { ok: false };
  }
  // Поки відповідь ішла, людина могла змінити фільтр — тоді ця вже не потрібна.
  if (seq !== loadSeq) return;

  if (data.weapons && !weaponsByCategory) {
    weaponsByCategory = data.weapons;
    buildCategoryMenus();
  }

  renderOwn(data.ok && state.page === 1 ? data.own : []);

  if (!data.ok) {
    grid.innerHTML = "";
    pager.style.display = "none";
    statusEl.textContent = data.error === "BUSY" ? C.busy : C.nothing;
    return;
  }

  // Сервер прибирає лоти з цінником без ринку вже після того, як сторінку
  // нарізано, тож сторінка може вийти неповною або навіть порожньою, а далі
  // ще є товар. Тому гортання лишаємо, а загальну кількість не пишемо — вона
  // рахує й приховані лоти.
  statusEl.style.display = data.items.length ? "none" : "block";
  if (!data.items.length) statusEl.textContent = C.nothing;
  grid.innerHTML = data.items.map(cardHtml).join("");

  pager.style.display = data.pages > 1 ? "flex" : "none";
  pageLabel.textContent = C.page.replace("{n}", data.page).replace("{all}", data.pages);
  document.getElementById("catalogPrev").disabled = data.page <= 1;
  document.getElementById("catalogNext").disabled = data.page >= data.pages;
}

function floatRange(it) {
  if (it.minFloat == null) return "";
  const a = it.minFloat.toFixed(3);
  const b = (it.maxFloat ?? it.minFloat).toFixed(3);
  return a === b ? a : `${a}–${b}`;
}

function cardHtml(it) {
  const [weapon, skin] = String(it.name).replace(/^★ /, "").split(" | ");
  const img = it.icon ? `<img class="inventory-card-img" src="${esc(it.icon)}" alt="" loading="lazy" />` : "";
  const tags = [
    it.wear ? `<span class="wear-code wear-${esc(it.wear)}">${esc(it.wear)}</span>` : "",
    it.phase ? `<span class="item-phase">${esc(it.phase)}</span>` : "",
    it.stattrak ? '<span class="tag-stattrak">ST</span>' : "",
    it.souvenir ? '<span class="tag-souvenir">SV</span>' : "",
  ].filter(Boolean);
  const range = floatRange(it);

  return `
    <a class="inventory-card selectable market-card" href="${esc(itemUrl(it))}">
      ${tags.length ? `<div class="inventory-card-top">${tags.join('<span class="dot">·</span>')}</div>` : ""}
      ${img}
      <div class="inventory-card-name">
        ${skin ? `<span class="item-weapon">${esc(weapon)}</span><span class="item-skin">${esc(skin)}</span>` : `<span class="item-skin">${esc(weapon)}</span>`}
      </div>
      <div class="market-card-meta">
        <span>${esc(C.offers.replace("{n}", it.count))}</span>
        ${range ? `<span class="market-card-float">${esc(range)}</span>` : ""}
      </div>
      <span class="inventory-card-price">${esc(C.from)} ${money(it.price)}</span>
    </a>`;
}

// ---- Перемикач Instant / P2P ----
function markDelivery() {
  document.querySelectorAll("[data-delivery]").forEach((b) => {
    b.classList.toggle("active", (b.dataset.delivery || "") === state.delivery);
  });
}
document.querySelectorAll("[data-delivery]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.delivery = btn.dataset.delivery || "";
    try {
      localStorage.setItem("buyDelivery", state.delivery);
    } catch {
      // не запам'ятаємо — не страшно
    }
    state.page = 1;
    markDelivery();
    loadCatalog();
  });
});

// ---- Фільтри ----
let searchTimer;
document.getElementById("catalogSearch").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    state.page = 1;
    loadCatalog();
  }, 350);
});

document.getElementById("catalogSort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  state.page = 1;
  loadCatalog();
});

// ---- Вкладки категорій і випадайки зі зброєю ----
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
        menu.querySelectorAll("input[value]").forEach((b) => (b.checked = box.checked));
      }
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
    searchTimer = setTimeout(loadCatalog, 450);
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

markDelivery();
loadCatalog();
