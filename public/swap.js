// Розділ Trade: ліворуч предмети клієнта, праворуч наша вітрина.
//
// Ліва сторона — інвентар клієнта з /api/account/inventory?mode=trade: в
// обміні ми беремо його предмети за 97% ціни Skinbux (при звичайному викупі —
// 95%). Права — популярні позиції (tradeCatalog.js), які ми під конкретний
// обмін докуповуємо на Youpin; якщо клієнт шукає щось своє, шукаємо по всьому
// каталогу цін (/api/public/trade-search), бо дістати можемо будь-який скін.
//
// Сам обмін завершується в Telegram: бота, який сам відправляє трейди, у нас
// немає (у продажу обміни шле Skinbux, а не ми), тому кнопка збирає готове
// повідомлення з обома сторонами й різницею.
const SWAP_T = window.SWAP_CONFIG;
const TELEGRAM_USER = "lxnmnk";

const swapMineGrid = document.getElementById("swapMineGrid");
const swapOursGrid = document.getElementById("swapOursGrid");
const swapMineLoading = document.getElementById("swapMineLoading");
const swapOursLoading = document.getElementById("swapOursLoading");
const swapMineAuth = document.getElementById("swapMineAuth");
const swapMineTotalEl = document.getElementById("swapMineTotal");
const swapOursTotalEl = document.getElementById("swapOursTotal");
const swapGiveEl = document.getElementById("swapGive");
const swapGetEl = document.getElementById("swapGet");
const swapDiffEl = document.getElementById("swapDiff");
const swapTelegramBtn = document.getElementById("swapTelegram");
const swapAnyHintEl = document.getElementById("swapAnyHint");

let swapMine = []; // предмети клієнта
let swapOurs = []; // що зараз показано праворуч: вітрина або результат пошуку
let swapOursCatalog = []; // сама вітрина, щоб повертатись до неї після пошуку
const swapPickedMine = new Set(); // assetId — кожен предмет рівно один раз
const swapPickedOurs = new Map(); // marketHashName -> кількість
// Вибране не має губитись, коли предмет зник з поточного списку (змінили
// пошук), тому все, що колись бачили, тримаємо окремо.
const swapOursKnown = new Map(); // marketHashName -> предмет

if (swapAnyHintEl) swapAnyHintEl.textContent = SWAP_T.anySkinHint;

// Фільтри — та сама панель, що в кабінеті й на вітрині (item-filters.js):
// пошук (розуміє російську/українську), ціна, якість, StatTrak/Souvenir.
// Свої панелі фільтрів у кожної сторони, бо предмети там різні.
const swapMineFilters = createItemFilters({
  mount: document.getElementById("swapMineFilters"),
  labels: SWAP_T,
  onChange: () => renderMine(),
});
const swapOursFilters = createItemFilters({
  mount: document.getElementById("swapOursFilters"),
  labels: SWAP_T,
  onChange: () => onOursFiltersChange(),
});
const swapOursSearchInput = document.querySelector("#swapOursFilters .filters-search");

function swapEscape(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function swapMoney(n) {
  return "$" + n.toFixed(2);
}

function swapFill(template, vars) {
  return (template || "").replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}

function rememberOurs(items) {
  for (const it of items) swapOursKnown.set(it.marketHashName, it);
}

// ---- Ліва панель: предмети клієнта ----
async function loadMine() {
  const me = await fetch("/api/account/me").then((r) => r.json()).catch(() => ({}));
  if (!me.customer) {
    swapMineLoading.style.display = "none";
    swapMineAuth.style.display = "block";
    return;
  }

  const data = await fetch("/api/account/inventory?mode=trade")
    .then((r) => r.json())
    .catch(() => ({ ok: false }));
  if (!data.ok) {
    // PRICES_NOT_READY / ліміт Steam / приватний інвентар — окремих пояснень
    // тут не робимо, для цього є кабінет: там же видно й причину.
    swapMineLoading.textContent = SWAP_T.mineUnavailable;
    return;
  }
  swapMineLoading.style.display = "none";
  swapMine = data.items;
  renderMine();
}

function renderMine() {
  const visible = swapMineFilters.apply(swapMine);
  if (!visible.length) {
    swapMineGrid.innerHTML = `<p class="swap-empty">${swapEscape(swapMine.length ? SWAP_T.nothingFound : SWAP_T.mineEmpty)}</p>`;
    return;
  }

  swapMineGrid.innerHTML = visible
    .map((it) => {
      const img = it.icon ? `<img src="${swapEscape(it.icon)}" alt="" />` : "";
      const name = `<div class="swap-card-name">${swapEscape(it.name)}<span class="swap-card-wear">${swapEscape(it.wear || "")}</span></div>`;

      // Предмет у трейд-бані / не приймається Skinbux / без ціни — показуємо,
      // але взяти в обмін не можна: інакше клієнт дізнався б про це вже в
      // переписці.
      let reason = null;
      if (!it.tradable) reason = SWAP_T.tradeLocked;
      else if (it.sellAccept === false) reason = SWAP_T.notAccepted;
      else if (it.price == null) reason = SWAP_T.priceUnknown;

      if (reason) {
        return `<div class="swap-card unavailable">${img}${name}<span class="swap-card-na">${swapEscape(reason)}</span></div>`;
      }

      const picked = swapPickedMine.has(it.assetId);
      return `
        <div class="swap-card${picked ? " picked" : ""}" data-asset="${swapEscape(it.assetId)}">
          ${picked ? '<span class="swap-card-pick">✓</span>' : ""}
          ${img}${name}
          <span class="swap-card-price">${swapMoney(it.price)}</span>
        </div>`;
    })
    .join("");

  swapMineGrid.querySelectorAll("[data-asset]").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-asset");
      if (swapPickedMine.has(id)) swapPickedMine.delete(id);
      else swapPickedMine.add(id);
      renderMine();
      renderSummary();
    });
  });
}

// ---- Права панель: вітрина і пошук по всьому каталогу ----
// Ціни на сервері з'являються не миттєво (після рестарту снапшот збирається
// хвилину-другу), і в цей момент вітрина порожня — тому не пишемо одразу
// "недоступна", а мовчки пробуємо ще кілька разів.
const CATALOG_RETRIES = 5;
const CATALOG_RETRY_MS = 8000;

async function loadOurs(attempt = 0) {
  const data = await fetch("/api/public/trade-catalog")
    .then((r) => r.json())
    .catch(() => ({ ok: false }));

  if (!data.ok || !data.items.length) {
    if (attempt < CATALOG_RETRIES) {
      swapOursLoading.textContent = SWAP_T.catalogLoading;
      setTimeout(() => loadOurs(attempt + 1), CATALOG_RETRY_MS);
      return;
    }
    swapOursLoading.textContent = SWAP_T.oursUnavailable;
    return;
  }

  swapOursLoading.style.display = "none";
  swapOursCatalog = data.items;
  rememberOurs(data.items);
  if (!isSearching()) {
    swapOurs = swapOursCatalog;
    renderOurs();
  }
}

function isSearching() {
  return (swapOursSearchInput?.value || "").trim().length >= 2;
}

let oursSearchTimer = null;
let oursSearchSeq = 0;

function onOursFiltersChange() {
  if (!isSearching()) {
    clearTimeout(oursSearchTimer);
    swapOurs = swapOursCatalog;
    renderOurs();
    return;
  }

  // Пошук іде на сервер, тому чекаємо, поки людина допише назву.
  clearTimeout(oursSearchTimer);
  oursSearchTimer = setTimeout(runOursSearch, 350);
}

async function runOursSearch() {
  const query = swapOursSearchInput.value.trim();
  const seq = ++oursSearchSeq;

  swapOursGrid.innerHTML = `<p class="swap-empty">${swapEscape(SWAP_T.searchingLabel)}</p>`;
  const data = await fetch(`/api/public/trade-search?q=${encodeURIComponent(query)}`)
    .then((r) => r.json())
    .catch(() => ({ ok: false, items: [] }));

  // Поки відповідь ішла, людина могла дописати назву — тоді цей результат уже
  // не актуальний.
  if (seq !== oursSearchSeq) return;

  const items = data.items || [];
  rememberOurs(items);
  swapOurs = items;
  renderOurs({ searched: true });
}

function renderOurs({ searched = false } = {}) {
  // Рядок пошуку для правої сторони вже відпрацював на сервері, але решта
  // фільтрів (ціна, якість) звужує і вітрину, і результат пошуку.
  const visible = swapOursFilters.apply(swapOurs);
  if (!visible.length) {
    const message = searched || isSearching() ? SWAP_T.searchEmpty : SWAP_T.nothingFound;
    swapOursGrid.innerHTML = `<p class="swap-empty">${swapEscape(message)}</p>`;
    return;
  }

  swapOursGrid.innerHTML = visible
    .map((it) => {
      const qty = swapPickedOurs.get(it.marketHashName) || 0;
      const img = it.icon ? `<img src="${swapEscape(it.icon)}" alt="" />` : "";
      return `
        <div class="swap-card${qty ? " picked" : ""}" data-name="${swapEscape(it.marketHashName)}">
          ${qty ? `<span class="swap-card-pick">× ${qty}</span>` : ""}
          ${img}
          <div class="swap-card-name">${swapEscape(it.name)}<span class="swap-card-wear">${swapEscape(it.wear || "")}</span></div>
          <span class="swap-card-price">${swapMoney(it.price)}</span>
        </div>`;
    })
    .join("");

  // Клік додає ще один такий предмет, правий клік прибирає: однакових ножів
  // можна взяти кілька, тому це не перемикач, як ліворуч.
  swapOursGrid.querySelectorAll("[data-name]").forEach((card) => {
    const name = card.getAttribute("data-name");
    card.addEventListener("click", () => {
      swapPickedOurs.set(name, (swapPickedOurs.get(name) || 0) + 1);
      renderOurs({ searched });
      renderSummary();
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const qty = (swapPickedOurs.get(name) || 0) - 1;
      if (qty > 0) swapPickedOurs.set(name, qty);
      else swapPickedOurs.delete(name);
      renderOurs({ searched });
      renderSummary();
    });
  });
}

// ---- Підсумок ----
function pickedMineItems() {
  return swapMine.filter((it) => swapPickedMine.has(it.assetId));
}

function pickedOursItems() {
  return [...swapPickedOurs]
    .map(([name, qty]) => ({ item: swapOursKnown.get(name), qty }))
    .filter((e) => e.item);
}

function renderSummary() {
  const mine = pickedMineItems();
  const ours = pickedOursItems();
  const mineSum = mine.reduce((sum, it) => sum + it.price, 0);
  const oursSum = ours.reduce((sum, e) => sum + e.item.price * e.qty, 0);
  const oursCount = ours.reduce((sum, e) => sum + e.qty, 0);

  swapMineTotalEl.textContent = swapMoney(mineSum);
  swapOursTotalEl.textContent = swapMoney(oursSum);
  swapGiveEl.innerHTML = `${swapEscape(SWAP_T.summaryGive)}<b>${swapMoney(mineSum)} · ${mine.length}</b>`;
  swapGetEl.innerHTML = `${swapEscape(SWAP_T.summaryGet)}<b>${swapMoney(oursSum)} · ${oursCount}</b>`;

  const diff = Math.round((oursSum - mineSum) * 100) / 100;
  if (diff > 0) {
    swapDiffEl.className = "swap-summary-diff";
    swapDiffEl.innerHTML = `${swapEscape(SWAP_T.diffYouPay)}<b>${swapMoney(diff)}</b>`;
  } else if (diff < 0) {
    swapDiffEl.className = "swap-summary-diff";
    swapDiffEl.innerHTML = `${swapEscape(SWAP_T.diffWePay)}<b>${swapMoney(-diff)}</b>`;
  } else {
    swapDiffEl.className = "swap-summary-diff even";
    swapDiffEl.innerHTML = `<b>${swapEscape(SWAP_T.diffEven)}</b>`;
  }

  const empty = !mine.length && !oursCount;
  swapTelegramBtn.classList.toggle("disabled", empty);
  swapTelegramBtn.href = empty ? "#" : telegramLink(mine, ours, mineSum, oursSum, diff);
}

function telegramLink(mine, ours, mineSum, oursSum, diff) {
  const lines = [SWAP_T.msgIntro];
  if (mine.length) {
    lines.push("", SWAP_T.msgGive);
    lines.push(...mine.map((it) => `• ${it.marketHashName} — ${swapMoney(it.price)}`));
  }
  if (ours.length) {
    lines.push("", SWAP_T.msgGet);
    lines.push(
      ...ours.map(
        ({ item, qty }) => `• ${item.marketHashName}${qty > 1 ? " × " + qty : ""} — ${swapMoney(item.price * qty)}`
      )
    );
  }
  lines.push(
    "",
    swapFill(SWAP_T.msgTotals, { give: swapMoney(mineSum), get: swapMoney(oursSum) }),
    diff > 0
      ? swapFill(SWAP_T.msgYouPay, { amount: swapMoney(diff) })
      : diff < 0
        ? swapFill(SWAP_T.msgWePay, { amount: swapMoney(-diff) })
        : SWAP_T.msgEven
  );
  return `https://t.me/${TELEGRAM_USER}?text=${encodeURIComponent(lines.join("\n"))}`;
}

loadMine();
loadOurs();
renderSummary();
