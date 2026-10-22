// Розділ Trade: ліворуч предмети клієнта, праворуч наша вітрина.
//
// Ліва сторона — інвентар клієнта з /api/account/inventory?mode=trade: в
// обміні ми беремо його предмети за 97% ціни Skinbux (при звичайному викупі —
// 95%). Права — популярні позиції (tradeCatalog.js), які ми під конкретний
// обмін докуповуємо на Youpin; якщо клієнт шукає щось своє, шукаємо по всьому
// каталогу цін (/api/public/trade-search), бо дістати можемо будь-який скін.
//
// Свою сторону клієнт здає сам, не чекаючи на нас: кнопка під лівою панеллю
// продає вибрані предмети на Skinbux (той самий автопродаж, що в кабінеті,
// /api/account/trade-sell), і їхня сума стає trade-балансом — грошима, які
// можна витратити тільки на наші скіни, зате одразу, без 7 днів холду. Холд
// на цих грошах чекаємо ми, і саме тому обмін іде день у день.
//
// Наші скіни досі віддаємо руками: бота, який шле трейди від нас, немає
// (у продажу обміни шле Skinbux), тому кнопка Telegram збирає готове
// повідомлення з обома сторонами, trade-балансом і різницею.
const SWAP_T = window.SWAP_CONFIG;
const TELEGRAM_USER = "gabenmarket_support";

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
const swapBalanceEl = document.getElementById("swapBalance");
const swapSellBtn = document.getElementById("swapSellBtn");
const swapSellStatusEl = document.getElementById("swapSellStatus");

let swapCustomer = null;
let swapTradeBalance = 0; // уже зданий у Skinbux бік клієнта, у доларах

let swapMine = []; // предмети клієнта
let swapOurs = []; // що зараз показано праворуч: вітрина або результат пошуку
let swapOursCatalog = []; // сама вітрина, щоб повертатись до неї після пошуку
const swapPickedMine = new Set(); // assetId — кожен предмет рівно один раз
const swapPickedOurs = new Map(); // marketHashName -> кількість
// Вибране не має губитись, коли предмет зник з поточного списку (змінили
// пошук), тому все, що колись бачили, тримаємо окремо.
const swapOursKnown = new Map(); // marketHashName -> предмет

if (swapAnyHintEl) swapAnyHintEl.textContent = SWAP_T.anySkinHint;

// Вибране в обміні переживає перемикання мови (UA/RU/EN — різні сторінки).
// Наша сторона — предмети з ціною (могли бути знайдені пошуком, а не з
// вітрини), сторона клієнта — лише assetId: відновлюємо, коли прийде
// інвентар, і лише те, що в ньому ще є.
const SWAP_KEY = "swapSelection";
let swapMineRestored = false;

function loadSwapSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SWAP_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function saveSwap() {
  const prev = loadSwapSaved();
  const data = {
    // Поки інвентар не відновили, не затираємо збережений вибір клієнта.
    mine: swapMineRestored ? [...swapPickedMine] : prev.mine || [],
    ours: [...swapPickedOurs].map(([name, qty]) => ({ item: swapOursKnown.get(name), qty })).filter((e) => e.item),
  };
  try {
    localStorage.setItem(SWAP_KEY, JSON.stringify(data));
  } catch {
    // приватний режим — просто не запам'ятаємо
  }
}

function restoreSwapOurs() {
  for (const { item, qty } of loadSwapSaved().ours || []) {
    if (!item?.marketHashName || !(qty > 0)) continue;
    swapOursKnown.set(item.marketHashName, item);
    swapPickedOurs.set(item.marketHashName, qty);
  }
}

function restoreSwapMine() {
  for (const assetId of loadSwapSaved().mine || []) {
    const it = swapMine.find((x) => x.assetId === assetId);
    if (it && it.tradable && it.sellAccept !== false && it.price != null) swapPickedMine.add(assetId);
  }
  swapMineRestored = true;
}

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
  // Валюту обирає людина в шапці (currency.js) — усередині все лишається в
  // доларах, змінюється тільки показ.
  return window.fmtPrice ? window.fmtPrice(n) : "$" + n.toFixed(2);
}

function swapFill(template, vars) {
  return (template || "").replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}

function rememberOurs(items) {
  for (const it of items) swapOursKnown.set(it.marketHashName, it);
}

// ---- Ліва панель: предмети клієнта ----
async function loadMine({ refresh = false } = {}) {
  const me = await fetch("/api/account/me").then((r) => r.json()).catch(() => ({}));
  if (!me.customer) {
    swapMineLoading.style.display = "none";
    swapMineAuth.style.display = "block";
    return;
  }
  swapCustomer = me.customer;
  swapTradeBalance = Number(me.balance?.trade) || 0;

  // Після зданого обміну інвентар питаємо повз кеш — інакше продані предмети
  // ще хвилину висіли б у списку, і їх можна було б спробувати здати вдруге.
  const data = await fetch(`/api/account/inventory?mode=trade${refresh ? "&refresh=1" : ""}`)
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
  restoreSwapMine();
  renderMine();
  renderSummary();
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
  // Перша сторінка того самого каталогу, що і в "Купити скіни", але за цінами
  // обміну. Окремої вітрини популярного більше немає: з фільтрами й
  // категоріями людина доходить до потрібного швидше, ніж по короткому списку.
  const data = await fetch("/api/public/catalog?mode=trade")
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
  rememberOurs(data.items);
  // Збережений вибір міг прийти зі старими цінами — перераховуємо підсумок.
  renderSummary();
  swapOurs = data.items;
  renderOurs();
  renderOursPager(data);
}

function isSearching() {
  return (swapOursSearchInput?.value || "").trim().length >= 2;
}

let oursSearchTimer = null;
let oursSearchSeq = 0;

function onOursFiltersChange() {
  // Будь-яка зміна фільтра — новий запит до каталогу з першої сторінки.
  oursPage = 1;
  clearTimeout(oursSearchTimer);
  oursSearchTimer = setTimeout(runOursSearch, 350);
}

// Наша сторона обміну — той самий каталог, що й у "Купити скіни", тільки за
// цінами обміну (mode=trade). Раніше тут була коротка вітрина популярного і
// пошук по назві: якщо людина не знала, чого хоче, перебрати не було як.
let oursPage = 1;
let oursPages = 1;

async function runOursSearch() {
  const seq = ++oursSearchSeq;
  swapOursGrid.innerHTML = `<p class="swap-empty">${swapEscape(SWAP_T.searchingLabel)}</p>`;

  const params = new URLSearchParams({ mode: "trade", page: oursPage, ...swapOursFilters.params() });
  const query = swapOursSearchInput?.value.trim();
  if (query) params.set("q", query);
  if (swapCategory) params.set("category", swapCategory);

  const data = await fetch(`/api/public/catalog?${params}`)
    .then((r) => r.json())
    .catch(() => ({ ok: false, items: [] }));

  // Поки відповідь ішла, людина могла змінити фільтр — тоді ця вже не потрібна.
  if (seq !== oursSearchSeq) return;

  const items = data.items || [];
  oursPages = data.pages || 1;
  rememberOurs(items);
  swapOurs = items;
  renderOurs({ searched: true });
  renderOursPager(data);
}

function renderOursPager(data) {
  const pager = document.getElementById("swapOursPager");
  if (!pager) return;
  pager.style.display = (data.pages || 1) > 1 ? "flex" : "none";
  document.getElementById("swapOursPageLabel").textContent = `${data.page || 1} / ${data.pages || 1}`;
  document.getElementById("swapOursPrev").disabled = (data.page || 1) <= 1;
  document.getElementById("swapOursNext").disabled = (data.page || 1) >= (data.pages || 1);
}

// ---- Вкладки категорій на нашій стороні ----
let swapCategory = "";
document.querySelectorAll("#swapCatalogTabs .catalog-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#swapCatalogTabs .catalog-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    swapCategory = tab.dataset.category || "";
    oursPage = 1;
    runOursSearch();
  });
});

document.getElementById("swapOursPrev")?.addEventListener("click", () => {
  if (oursPage > 1) {
    oursPage--;
    runOursSearch();
  }
});
document.getElementById("swapOursNext")?.addEventListener("click", () => {
  if (oursPage < oursPages) {
    oursPage++;
    runOursSearch();
  }
});

function renderOurs({ searched = false } = {}) {
  // Рядок пошуку для правої сторони вже відпрацював на сервері, але решта
  // фільтрів (ціна, якість) звужує і вітрину, і результат пошуку.
  // Сервер уже відібрав за фільтрами — тут нічого не досіюємо, інакше
  // сторінка з 24 предметів ще й ужималась би вдруге.
  const visible = swapOurs;
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
          ${qty ? `<span class="swap-card-pick">× ${qty}</span><button type="button" class="swap-card-minus" aria-label="−">−</button>` : ""}
          ${img}
          <div class="swap-card-name">${swapEscape(it.name)}<span class="swap-card-wear">${swapEscape(it.wear || "")}</span></div>
          <span class="swap-card-price">${swapMoney(it.price)}</span>
        </div>`;
    })
    .join("");

  // Клік додає ще один такий предмет; прибирає кнопка "−" на картці або
  // правий клік: однакових ножів можна взяти кілька, тому це не перемикач,
  // як ліворуч. Кнопка — для телефона, де правого кліку немає.
  swapOursGrid.querySelectorAll("[data-name]").forEach((card) => {
    const name = card.getAttribute("data-name");
    const removeOne = () => {
      const qty = (swapPickedOurs.get(name) || 0) - 1;
      if (qty > 0) swapPickedOurs.set(name, qty);
      else swapPickedOurs.delete(name);
      renderOurs({ searched });
      renderSummary();
    };
    card.addEventListener("click", (e) => {
      if (e.target.closest(".swap-card-minus")) return removeOne();
      swapPickedOurs.set(name, (swapPickedOurs.get(name) || 0) + 1);
      renderOurs({ searched });
      renderSummary();
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      removeOne();
    });
  });
}

// ---- Що вже обрано ----
// Галочка "× 1" на картці видно лише доти, доки предмет є в поточному списку:
// варто змінити пошук чи перезавантажити сторінку — і вітрина знову показує
// популярне, а обраний ніж зник з очей. Сума при цьому стоїть, і забрати
// предмет нема як. Тому обране окремим рядком над сіткою, з ціною і хрестиком.
const swapMineChosen = document.getElementById("swapMineChosen");
const swapOursChosen = document.getElementById("swapOursChosen");

function renderChosenRow(el, entries, onRemove, onClear) {
  if (!el) return;
  if (!entries.length) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }

  el.style.display = "";
  el.innerHTML = `
    <span class="swap-chosen-title">${swapEscape(SWAP_T.chosenTitle)}</span>
    ${entries
      .map(
        (e) => `<button type="button" class="swap-chosen-chip" data-key="${swapEscape(e.key)}">
          ${swapEscape(e.label)}${e.qty > 1 ? ` × ${e.qty}` : ""}
          <span class="swap-chosen-price">${swapMoney(e.sum)}</span>
          <span class="swap-chosen-x">✕</span>
        </button>`
      )
      .join("")}
    <button type="button" class="swap-chosen-clear">${swapEscape(SWAP_T.chosenClear)}</button>`;

  el.querySelectorAll("[data-key]").forEach((chip) => {
    chip.addEventListener("click", () => onRemove(chip.getAttribute("data-key")));
  });
  el.querySelector(".swap-chosen-clear").addEventListener("click", onClear);
}

function renderChosen() {
  renderChosenRow(
    swapMineChosen,
    pickedMineItems().map((it) => ({ key: it.assetId, label: `${it.name || it.marketHashName}`, qty: 1, sum: it.price })),
    (assetId) => {
      swapPickedMine.delete(assetId);
      renderMine();
      renderSummary();
    },
    () => {
      swapPickedMine.clear();
      renderMine();
      renderSummary();
    }
  );

  renderChosenRow(
    swapOursChosen,
    pickedOursItems().map(({ item, qty }) => ({
      key: item.marketHashName,
      label: `${item.name || item.marketHashName}${item.wear ? ` (${item.wear})` : ""}`,
      qty,
      sum: item.price * qty,
    })),
    (name) => {
      swapPickedOurs.delete(name);
      renderOurs({ searched: isSearching() });
      renderSummary();
    },
    () => {
      swapPickedOurs.clear();
      renderOurs({ searched: isSearching() });
      renderSummary();
    }
  );
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
  saveSwap();
  renderChosen();
  const mine = pickedMineItems();
  const ours = pickedOursItems();
  const mineSum = mine.reduce((sum, it) => sum + it.price, 0);
  const oursSum = ours.reduce((sum, e) => sum + e.item.price * e.qty, 0);
  const oursCount = ours.reduce((sum, e) => sum + e.qty, 0);
  // Бік клієнта — це і вибрані зараз предмети, і те, що він уже здав раніше
  // (trade-баланс). Інакше здані предмети зникали з інвентарю, і різниця
  // рахувалась так, ніби він не дав нічого.
  const giveSum = Math.round((mineSum + swapTradeBalance) * 100) / 100;

  swapMineTotalEl.textContent = swapMoney(mineSum);
  swapOursTotalEl.textContent = swapMoney(oursSum);
  swapGiveEl.innerHTML = `${swapEscape(SWAP_T.summaryGive)}<b>${swapMoney(giveSum)} · ${mine.length}</b>`;
  swapGetEl.innerHTML = `${swapEscape(SWAP_T.summaryGet)}<b>${swapMoney(oursSum)} · ${oursCount}</b>`;

  if (swapBalanceEl) {
    swapBalanceEl.style.display = swapTradeBalance ? "" : "none";
    swapBalanceEl.innerHTML = swapFill(swapEscape(SWAP_T.balanceLine), {
      amount: `<b>${swapMoney(swapTradeBalance)}</b>`,
    });
  }
  renderSellButton(mine);

  const diff = Math.round((oursSum - giveSum) * 100) / 100;
  if (diff > 0) {
    swapDiffEl.className = "swap-summary-diff";
    swapDiffEl.innerHTML = `${swapEscape(SWAP_T.diffYouPay)}<b>${swapMoney(diff)}</b>`;
  } else if (diff < 0) {
    swapDiffEl.className = "swap-summary-diff";
    // Trade-баланс ми віддаємо скінами, а не грошима, тому "доплачуємо ми"
    // тут писати не можна — це залишок, який клієнту треба добрати нашими
    // скінами. "Доплачуємо ми" лишається для випадку, коли баланс нульовий,
    // а його бік просто дорожчий за наш.
    swapDiffEl.innerHTML = swapTradeBalance
      ? swapFill(swapEscape(SWAP_T.diffLeftover), { amount: `<b>${swapMoney(-diff)}</b>` })
      : `${swapEscape(SWAP_T.diffWePay)}<b>${swapMoney(-diff)}</b>`;
  } else {
    swapDiffEl.className = "swap-summary-diff even";
    swapDiffEl.innerHTML = `<b>${swapEscape(SWAP_T.diffEven)}</b>`;
  }

  const empty = !mine.length && !oursCount && !swapTradeBalance;
  swapTelegramBtn.classList.toggle("disabled", empty);
  swapTelegramBtn.href = empty ? "#" : telegramLink(mine, ours, giveSum, oursSum, diff);
}

function telegramLink(mine, ours, giveSum, oursSum, diff) {
  const lines = [SWAP_T.msgIntro];
  if (mine.length) {
    lines.push("", SWAP_T.msgGive);
    lines.push(...mine.map((it) => `• ${it.marketHashName} — ${swapMoney(it.price)}`));
  }
  // Про вже зданий бік пишемо окремим рядком: за ним я в панелі бачу, що
  // гроші за його скіни в мене вже є, і треба лише віддати наші.
  if (swapTradeBalance) {
    lines.push("", swapFill(SWAP_T.msgBalance, { amount: swapMoney(swapTradeBalance) }));
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
    swapFill(SWAP_T.msgTotals, { give: swapMoney(giveSum), get: swapMoney(oursSum) }),
    diff > 0
      ? swapFill(SWAP_T.msgYouPay, { amount: swapMoney(diff) })
      : diff < 0
        ? swapFill(SWAP_T.msgWePay, { amount: swapMoney(-diff) })
        : SWAP_T.msgEven
  );
  return `https://t.me/${TELEGRAM_USER}?text=${encodeURIComponent(lines.join("\n"))}`;
}

// ---- Здати свій бік: автопродаж на Skinbux -> trade-баланс ----
// Вікно з обміном від бота Skinbux — те саме, що в кабінеті
// (sell-offer-modal.js), тільки текст про гроші інший: тут вони стають
// trade-балансом одразу, а не лягають у холд на 7 днів.
const swapSaleModal = document.getElementById("swapSaleModal")
  ? createSellOfferModal({
      modal: document.getElementById("swapSaleModal"),
      body: document.getElementById("swapSaleBody"),
      title: document.getElementById("swapSaleTitle"),
      closeBtn: document.getElementById("swapSaleClose"),
      texts: SWAP_T,
      receivedText: (sale) =>
        swapFill(swapEscape(SWAP_T.receivedText), {
          amount: `<b>${swapMoney(Number(sale.totalPrice))}</b>`,
        }),
      // Гроші вже на trade-балансі — лишається домовитись, які наші скіни
      // клієнт за них забирає, а це досі Telegram.
      receivedButton: { label: SWAP_T.receivedBtn, onClick: () => swapTelegramBtn.click() },
      onFinished: () => refreshTradeBalance().then(() => loadMine({ refresh: true })),
    })
  : null;

function renderSellButton(picked) {
  if (!swapSellBtn) return;
  swapSellBtn.style.display = swapCustomer ? "" : "none";
  swapSellBtn.disabled = !picked.length;
  swapSellBtn.textContent = picked.length
    ? swapFill(SWAP_T.sellBtn, {
        amount: swapMoney(picked.reduce((sum, it) => sum + it.price, 0)),
        count: picked.length,
      })
    : SWAP_T.sellBtnEmpty;
}

async function refreshTradeBalance() {
  const me = await fetch("/api/account/me")
    .then((r) => r.json())
    .catch(() => ({}));
  swapTradeBalance = Number(me.balance?.trade) || 0;
  renderSummary();
  window.refreshNavBalance?.();
}

swapSellBtn?.addEventListener("click", async () => {
  const picked = pickedMineItems();
  if (!picked.length) return;
  // Без посилання на обмін Skinbux не має куди надіслати трейд. Зберігається
  // вона в кабінеті, там же і підказка, де її взяти.
  if (!swapCustomer?.tradeUrl) {
    swapSellStatusEl.innerHTML = `${swapEscape(SWAP_T.sellNeedTradeUrl)} <a href="${swapEscape(
      SWAP_T.accountUrl || "/account"
    )}">${swapEscape(SWAP_T.sellNeedTradeUrlLink)}</a>`;
    return;
  }

  swapSellBtn.disabled = true;
  swapSellStatusEl.textContent = SWAP_T.sellSending;

  let data;
  try {
    const res = await fetch("/api/account/trade-sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ціни, які клієнт бачив на картках: сервер не продасть дешевше.
      body: JSON.stringify({
        assetIds: picked.map((it) => it.assetId),
        expectedPrices: Object.fromEntries(picked.map((it) => [it.assetId, it.price])),
      }),
    });
    data = await res.json();
  } catch {
    data = { ok: false, error: SWAP_T.sellNetwork };
  }

  swapSellBtn.disabled = false;

  // Ціна на Skinbux встигла поїхати вниз: перечитуємо інвентар, щоб клієнт
  // побачив нові суми, перш ніж тиснути ще раз.
  if (data.error === "PRICE_CHANGED") {
    swapSellStatusEl.textContent = SWAP_T.sellPriceChanged;
    await loadMine({ refresh: true });
    return;
  }
  if (!data.ok) {
    swapSellStatusEl.textContent = `${SWAP_T.sellFailedPrefix}${data.error}`;
    return;
  }

  swapSellStatusEl.textContent = SWAP_T.sellWaitAccept;
  swapPickedMine.clear();
  renderMine();
  renderSummary();
  swapSaleModal?.show(data);
});

restoreSwapOurs();
loadMine();
loadOurs();
renderSummary();

// Курс гривні приходить із сервера після першої відмальовки — перемальовуємо
// обидві сторони обміну, коли він приїхав.
document.addEventListener("currency-rate", () => {
  renderMine();
  renderOurs();
  renderSummary();
});
