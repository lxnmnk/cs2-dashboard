// Особистий кабінет: інвентар клієнта тягнеться напряму зі Steam
// (/api/account/inventory), і на кожен предмет одразу порахована ціна
// викупу — та сама формула, що на "Продати" (sellQuote.js), просто без
// ручного пошуку. Сервер вже віддає тільки те, що реально можна продати
// (не-tradable типи предметів на кшталт медалей/монет відфільтровані), і
// відсортовано від найдорожчого.
// Локалізація — через window.ACCOUNT_CONFIG (кожна мовна версія сторінки
// задає свій текст перед підключенням цього файлу, як у quote-common.js).
const {
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
const cartPickedLine = document.getElementById("cartPickedLine");
const cartPayout = document.getElementById("cartPayout");
const cartEmptyLine = document.getElementById("cartEmptyLine");
const payoutBlock = document.getElementById("payoutBlock");
const payoutDateLine = document.getElementById("payoutDateLine");
const payoutMethodSub = document.getElementById("payoutMethodSub");
const cartItemsCount = document.getElementById("cartItemsCount");

// ---- Промокод ----
// Бонус платиться з нашої маржі, тому ціни після коду інші — і показати їх
// треба тими самими, що потім порахує сервер. Тому після застосування просто
// перечитуємо інвентар, а не множимо числа в браузері.
const promoInput = document.getElementById("promoInput");
const promoStatus = document.getElementById("promoStatus");

async function showPromo(promo) {
  if (!promo) {
    promoStatus.textContent = "";
    return;
  }
  promoInput.value = promo.code.toUpperCase();
  promoStatus.textContent = (CFG.promoApplied || "")
    .replace("{code}", promo.code.toUpperCase())
    .replace("{n}", promo.bonusPercent);
  promoStatus.classList.remove("field-error");
}

document.getElementById("promoApplyBtn")?.addEventListener("click", async () => {
  const code = promoInput.value.trim();
  let data;
  try {
    const res = await fetch("/api/account/promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    data = await res.json();
  } catch (err) {
    data = { ok: false };
  }

  if (!data.ok) {
    promoStatus.textContent = CFG.promoNotFound || "";
    promoStatus.classList.add("field-error");
    return;
  }
  showPromo(data.promo);
  // Ціни змінились — перечитуємо інвентар і кошик за новими.
  loadInventory();
});

// Код міг приїхати з партнерським посиланням ще до входу — показуємо його.
fetch("/api/account/promo")
  .then((r) => r.json())
  .then((d) => showPromo(d.promo))
  .catch(() => {});

// Куди слати гроші. Виплату власник робить руками, тож це підказка для нього
// в панелі, а не автоматичний переказ.
let payoutMethod = "card";
document.querySelectorAll(".payout-method").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".payout-method").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    payoutMethod = btn.dataset.method;
    payoutMethodSub.textContent = payoutMethod === "crypto" ? CFG.payoutCryptoSub || "" : CFG.payoutCardSub || "";
    // Крипта рахується в доларах, картка — у гривні. Перемикаємо показ самі,
    // щоб людина бачила суму в тій валюті, в якій її й отримає. Без
    // перезавантаження: воно скинуло б щойно обрані предмети.
    window.setCurrency?.(payoutMethod === "crypto" ? "USD" : "UAH", { reload: false });
    showPayoutFields();
    renderInventoryList();
    renderCart();
  });
});

// ---- Реквізити виплати ----
// Куди саме слати гроші, людина пише тут, а не потім у Telegram: власник
// бачить реквізити разом з угодою і переказує, щойно знімається холд.
//
// Перевіряємо те саме, що й сервер (payoutDetails.js) — він лишається
// головним, але сказати про помилку до натискання "Продати" чесніше, ніж
// після. Повідомлення беремо з конфігу сторінки, щоб вони були мовою, якою
// людина читає решту сайту.
const payoutCardFields = document.getElementById("payoutCardFields");
const payoutCryptoFields = document.getElementById("payoutCryptoFields");
const payoutBank = document.getElementById("payoutBank");
const payoutBankName = document.getElementById("payoutBankName");
const payoutCardNumber = document.getElementById("payoutCardNumber");
const payoutHolder = document.getElementById("payoutHolder");
const payoutNetwork = document.getElementById("payoutNetwork");
const payoutAddress = document.getElementById("payoutAddress");
const payoutError = document.getElementById("payoutError");

// Мережі не перекладаються: людина звіряє напис із тим, що бачить у своєму
// гаманці. chain — за яким форматом перевіряти адресу.
const PAYOUT_NETWORKS = [
  { value: "usdt-trc20", label: "USDT TRC-20", chain: "tron" },
  { value: "usdt-erc20", label: "USDT ERC-20", chain: "evm" },
  { value: "usdt-bep20", label: "USDT BEP-20", chain: "evm" },
  { value: "usdt-sol", label: "USDT Solana", chain: "solana" },
  { value: "usdc-trc20", label: "USDC TRC-20", chain: "tron" },
  { value: "usdc-erc20", label: "USDC ERC-20", chain: "evm" },
  { value: "usdc-bep20", label: "USDC BEP-20", chain: "evm" },
];
const PAYOUT_ADDRESS_RE = {
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

function fillPayoutSelects() {
  if (!payoutBank) return;
  const banks = CFG.payoutBanks || {};
  payoutBank.innerHTML =
    `<option value="" disabled selected>${escapeHtml(CFG.payoutBankLabel || "")}</option>` +
    Object.entries(banks).map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join("");
  payoutBankName.placeholder = CFG.payoutBankNamePlaceholder || "";
  payoutCardNumber.placeholder = CFG.payoutCardPlaceholder || "";
  payoutHolder.placeholder = CFG.payoutHolderPlaceholder || "";

  payoutNetwork.innerHTML =
    `<option value="" disabled selected>${escapeHtml(CFG.payoutNetworkLabel || "")}</option>` +
    PAYOUT_NETWORKS.map((n) => `<option value="${n.value}">${n.label}</option>`).join("");
  payoutAddress.placeholder = CFG.payoutAddressPlaceholder || "";
}

function showPayoutFields() {
  if (!payoutCardFields) return;
  payoutCardFields.style.display = payoutMethod === "card" ? "" : "none";
  payoutCryptoFields.style.display = payoutMethod === "crypto" ? "" : "none";
  payoutError.textContent = "";
}

// "Інший банк" — єдиний випадок, коли треба вписати назву руками.
payoutBank?.addEventListener("change", () => {
  payoutBankName.style.display = payoutBank.value === "other" ? "" : "none";
  payoutError.textContent = "";
});

// Номер зручніше читати групами по чотири — і зводити з тим, що в застосунку.
payoutCardNumber?.addEventListener("input", () => {
  const digits = payoutCardNumber.value.replace(/\D/g, "").slice(0, 16);
  payoutCardNumber.value = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  payoutError.textContent = "";
});
payoutHolder?.addEventListener("input", () => (payoutError.textContent = ""));
payoutAddress?.addEventListener("input", () => (payoutError.textContent = ""));
payoutNetwork?.addEventListener("change", () => (payoutError.textContent = ""));

function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Реквізити для запиту, або null — тоді в payoutError лежить причина. */
function collectPayoutDetails() {
  payoutError.textContent = "";
  const fail = (msg) => {
    payoutError.textContent = msg || "";
    return null;
  };

  if (payoutMethod === "card") {
    const bank = payoutBank.value;
    if (!bank) return fail(CFG.payoutErrBank);
    const bankName = payoutBankName.value.trim();
    if (bank === "other" && bankName.length < 2) return fail(CFG.payoutErrBankName);

    const card = payoutCardNumber.value.replace(/\D/g, "");
    if (card.length !== 16) return fail(CFG.payoutErrCard);
    if (!luhnValid(card)) return fail(CFG.payoutErrCardCheck);

    const holder = payoutHolder.value.trim().replace(/\s+/g, " ");
    if (!/^[\p{L}'’-]{2,}(\s+[\p{L}'’-]{2,})+$/u.test(holder)) return fail(CFG.payoutErrHolder);

    return { bank, bankName, cardNumber: card, holder };
  }

  const network = payoutNetwork.value;
  if (!network) return fail(CFG.payoutErrNetwork);
  const chain = PAYOUT_NETWORKS.find((n) => n.value === network)?.chain;
  const address = payoutAddress.value.trim();
  if (!PAYOUT_ADDRESS_RE[chain].test(address)) return fail(CFG.payoutErrAddress);
  return { network, address };
}

// Реквізити з минулої угоди: людина продає не вперше, і переписувати номер
// картки щоразу — зайвий привід помилитись.
fetch("/api/account/payout")
  .then((r) => r.json())
  .then((data) => {
    const d = data?.details;
    if (!d) return;
    if (d.method === "card") {
      payoutBank.value = d.bank || "";
      payoutBankName.value = d.bankName || "";
      payoutBankName.style.display = d.bank === "other" ? "" : "none";
      payoutCardNumber.value = (d.cardNumber || "").replace(/(\d{4})(?=\d)/g, "$1 ");
      payoutHolder.value = d.holder || "";
    } else if (d.method === "crypto") {
      payoutNetwork.value = d.network || "";
      payoutAddress.value = d.address || "";
    }
  })
  .catch(() => {});

fillPayoutSelects();
showPayoutFields();
const cartTotal = document.getElementById("cartTotal");
const sellAutoBtn = document.getElementById("sellAutoBtn");
const sellStatusEl = document.getElementById("sellStatus");
const cartClearBtn = document.getElementById("cartClearBtn");
// Посилання на обмін редагується у профілі — тут лише нагадування з
// посиланням туди, і лише коли його ще немає.
const tradeUrlMissingEl = document.getElementById("tradeUrlMissing");
const sellResultModal = document.getElementById("sellResultModal");
const sellResultBody = document.getElementById("sellResultBody");

const sellResultTitle = document.getElementById("sellResultTitle");

const MAX_RETRIES = 3;

// Панелі фільтрів тут немає: ціна, якість і StatTrak на власному інвентарі
// нікому не потрібні — людині треба знайти конкретний скін. Лишився пошук над
// сіткою, він розуміє російську й українську (item-aliases.js). Пошук тільки
// звужує показане: те, що вже в кошику, з нього не зникає.
let searchQuery = "";
const filters = {
  apply: (items) => {
    if (!searchQuery) return items;
    return items.filter((it) => {
      const text = `${it.marketHashName} ${it.searchAlt || ""}`;
      return window.matchesQuery ? window.matchesQuery(text, searchQuery) : text.toLowerCase().includes(searchQuery);
    });
  },
  setQuery: (value) => {
    searchQuery = String(value || "").trim().toLowerCase();
    renderInventoryList();
  },
};

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

sellAutoBtn?.addEventListener("click", async () => {
  if (!cart.length) return;
  if (!window.ACCOUNT_CUSTOMER?.tradeUrl) {
    sellStatusEl.textContent = needTradeUrlFirst;
    if (tradeUrlMissingEl) tradeUrlMissingEl.style.display = "block";
    return;
  }

  // Без реквізитів продаж не починаємо: обмін пішов би, а платити не було б
  // куди — і далі все одно довелося б домовлятись у Telegram.
  const payoutDetails = collectPayoutDetails();
  if (!payoutDetails) {
    payoutBlock?.scrollIntoView({ block: "center", behavior: "smooth" });
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
      payoutMethod,
      payoutDetails,
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
    // Сума в тій же валюті, що й решта сторінки — інакше після продажу
    // людина бачила долари там, де щойно дивилась на гривні.
    const amount = price(sale.totalPrice);
    if (sale.status !== "hold") return fillSaleText(CFG.receivedAvailableText, { amount });
    const days = holdDays || 7;
    const unlockAt = sale.unlockAt ? new Date(sale.unlockAt) : new Date(Date.now() + days * 86400000);
    const date = unlockAt.toLocaleDateString(CFG.dateLocale, { day: "numeric", month: "long" });
    return fillSaleText(CFG.receivedHoldText, { amount, date, days });
  },
  // Вікна "Мої угоди" більше немає — угоди живуть на сторінці профілю.
  receivedButton: {
    label: CFG.myDealsBtn,
    onClick: () => (window.location.href = document.getElementById("accountPillBtn")?.getAttribute("href") || "/profile"),
  },
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
  }
  // Кошик тримає власні копії цін, тож після перечитування інвентаря їх треба
  // оновити: інакше після введення промокоду картки показували нову ціну, а
  // кошик — стару, і продаж пішов би за старою.
  syncCartPrices();
  renderCart();
  renderInventoryList();
}

/** Підтягує в кошик свіжі ціни; зниклі з інвентаря предмети прибирає. */
function syncCartPrices() {
  cart = cart
    .map((it) => {
      const fresh = inventoryItems.find((i) => i.assetId === it.assetId);
      return fresh && fresh.price != null ? { ...it, price: fresh.price } : null;
    })
    .filter(Boolean);
}

// ---- Картка предмета ----
// Зверху — якість і float, бо саме за ними впізнають конкретний екземпляр:
// два однакові ножі відрізняються тільки цим числом. Назву ріжемо на дві
// частини ("★ Karambit" / "Case Hardened"): так зброя й сам скін читаються
// з одного погляду, а довга назва не переносилась у три рядки.
const WEAR_CODES = {
  "Factory New": "FN",
  "Minimal Wear": "MW",
  "Field-Tested": "FT",
  "Well-Worn": "WW",
  "Battle-Scarred": "BS",
};

function itemTopHtml(it) {
  const code = WEAR_CODES[it.wear] || "";
  const parts = [];
  if (code) parts.push(`<span class="wear-code wear-${code}">${code}</span>`);
  // float з точністю до чотирьох знаків: далі цифри вже нічого не вирішують
  // ні для ціни, ні для впізнавання.
  if (it.float != null) parts.push(`<span class="item-float">${Number(it.float).toFixed(4)}</span>`);
  if (it.phase) parts.push(`<span class="item-phase">${escapeHtml(it.phase)}</span>`);
  return parts.length ? `<div class="inventory-card-top">${parts.join('<span class="dot">·</span>')}</div>` : "";
}

function itemNameHtml(it) {
  const [weapon, skin] = String(it.name || it.marketHashName).split(" | ");
  if (!skin) return `<span class="item-skin">${escapeHtml(weapon)}</span>`;
  return `<span class="item-weapon">${escapeHtml(weapon)}</span><span class="item-skin">${escapeHtml(skin)}</span>`;
}

function renderInventoryList() {
  if (!inventoryItems.length) {
    inventoryEmptyEl.style.display = "block";
    inventoryListEl.innerHTML = "";
    return;
  }
  inventoryEmptyEl.style.display = "none";

  const visible = [...filters.apply(inventoryItems)].sort(SORTS[sortKey].cmp);
  if (!visible.length) {
    inventoryListEl.innerHTML = `<p class="filters-empty">${escapeHtml(nothingFound)}</p>`;
    return;
  }

  inventoryListEl.innerHTML = visible
    .map((it) => {
      const img = it.icon ? `<img class="inventory-card-img" src="${escapeHtml(it.icon)}" alt="" />` : "";
      const nameHtml = itemNameHtml(it);
      const topHtml = itemTopHtml(it);

      // Предмет у трейд-бані показуємо, але продати його не можна, поки Steam
      // його не відпустить — раніше такі просто зникали зі списку.
      if (!it.tradable) {
        return `
          <div class="inventory-card">
            ${topHtml}
            ${img}
            <div class="inventory-card-name">${nameHtml}</div>
            <span class="lock-tag locked">🔒 ${escapeHtml(it.tradableAfter || tradeLockedLabel)}</span>
            ${it.price != null ? `<span class="inventory-card-price">${price(it.price)}</span>` : ""}
          </div>`;
      }

      // Skinbux цей предмет не приймає — показуємо, але без кнопки продажу.
      // Раніше клієнт дізнавався про це лише коли тиснув "Продати".
      if (it.sellAccept === false) {
        return `
          <div class="inventory-card">
            ${topHtml}
            ${img}
            <div class="inventory-card-name">${nameHtml}</div>
            <span class="inventory-card-na">${escapeHtml(unavailableLabel)}</span>
          </div>`;
      }

      if (it.price == null) {
        return `
          <div class="inventory-card">
            ${topHtml}
            ${img}
            <div class="inventory-card-name">${nameHtml}</div>
            <span class="inventory-card-na">${priceUnknown}</span>
          </div>`;
      }

      // Вибір — кліком по самій картці: кнопка на кожному предметі була
      // зайвим кліком, а при продажу десятка предметів — десятьма.
      const added = cart.some((c) => c.assetId === it.assetId);
      return `
        <div class="inventory-card selectable${added ? " selected" : ""}" data-asset="${escapeHtml(it.assetId)}" role="button" tabindex="0">
          ${added ? `<span class="inventory-card-check">✓</span>` : ""}
          ${topHtml}
          ${img}
          <div class="inventory-card-name">${nameHtml}</div>
          <span class="inventory-card-price">${price(it.price)}</span>
        </div>`;
    })
    .join("");

  inventoryListEl.querySelectorAll("[data-asset]").forEach((card) => {
    const toggle = () => toggleItem(card.getAttribute("data-asset"));
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });
  renderSelectionControls(visible);
}

// ---- Панель над сіткою: сортування, вибір усього, підсумок вибраного ----
const sortEl = document.getElementById("inventorySort");
const selectAllBtn = document.getElementById("selectAllBtn");
const selectionSummaryEl = document.getElementById("selectionSummary");

const SORTS = {
  priceDesc: { label: CFG.sortPriceDesc, cmp: (a, b) => (b.price ?? -1) - (a.price ?? -1) },
  priceAsc: { label: CFG.sortPriceAsc, cmp: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) },
};
let sortKey = "priceDesc";

const searchEl = document.getElementById("inventorySearch");
let searchTimer;
searchEl?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => filters.setQuery(searchEl.value), 200);
});

if (sortEl) {
  sortEl.innerHTML = Object.entries(SORTS)
    .map(([key, s]) => `<option value="${key}">${escapeHtml(s.label)}</option>`)
    .join("");
  sortEl.addEventListener("change", () => {
    sortKey = sortEl.value;
    renderInventoryList();
  });
}

/** Предмет можна покласти в кошик: не в трейд-бані, приймається, з ціною. */
function isSellable(it) {
  return it.tradable && it.sellAccept !== false && it.price != null;
}

function renderSelectionControls(visible) {
  if (!selectAllBtn) return;
  const sellable = visible.filter(isSellable);
  const allPicked = sellable.length > 0 && sellable.every((it) => cart.some((c) => c.assetId === it.assetId));

  selectAllBtn.textContent = allPicked ? CFG.clearSelectionLabel : CFG.selectAllLabel;
  selectAllBtn.disabled = !sellable.length;
  selectAllBtn.onclick = () => {
    if (allPicked) {
      // Знімаємо вибір лише з того, що зараз видно: відфільтроване з кошика
      // не прибираємо, інакше людина б губила вибір, змінивши фільтр.
      const ids = new Set(sellable.map((it) => it.assetId));
      cart = cart.filter((c) => !ids.has(c.assetId));
    } else {
      for (const it of sellable) {
        if (!cart.some((c) => c.assetId === it.assetId)) {
          cart.push({ assetId: it.assetId, marketHashName: it.marketHashName, price: it.price });
        }
      }
    }
    renderInventoryList();
    renderCart();
  };

  const sum = cart.reduce((acc, it) => acc + it.price, 0);
  selectionSummaryEl.textContent = cart.length
    ? (CFG.selectedSummary || "").replace("{n}", cart.length).replace("{sum}", price(sum))
    : "";
}

function toggleItem(assetId) {
  if (cart.some((c) => c.assetId === assetId)) removeItem(assetId);
  else addItem(assetId);
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
  const sellBtn = document.getElementById("sellAutoBtn");
  const total = cart.reduce((sum, it) => sum + it.price, 0);

  // Назв предметів тут немає: вони вже на картках. Натомість те, чого на
  // картках не видно — скільки вийде разом, куди і коли прийдуть гроші.
  // Блок виплати показуємо і на порожньому кошику: людина має бачити умови
  // до того, як щось обере, а не після.
  cartPickedLine.textContent = (CFG.cartPicked || "").replace("{n}", cart.length);
  cartTotal.textContent = price(total);
  cartPayout.textContent = price(total);
  cartItemsCount.textContent = String(cart.length);
  cartEmptyLine.textContent = cart.length ? "" : CFG.cartEmpty || "";
  if (sellBtn) sellBtn.disabled = !cart.length;

  // Дата виплати: гроші приходять після холду Steam — 7 днів від обміну.
  const unlock = new Date(Date.now() + 7 * 86400000);
  payoutDateLine.innerHTML = `${escapeHtml(
    (CFG.payoutDateLine || "").replace("{date}", unlock.toLocaleDateString(CFG.dateLocale || "uk-UA"))
  )}<span class="payout-hint">${escapeHtml(CFG.payoutHint || "")}</span>`;
  payoutMethodSub.textContent = payoutMethod === "crypto" ? CFG.payoutCryptoSub || "" : CFG.payoutCardSub || "";

  sellStatusEl.textContent = "";
}

// Підписи, які не змінюються від вибору — ставимо один раз при завантаженні.
function fillCartLabels() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text || "";
  };
  set("itemsRowLabel", CFG.itemsRowLabel);
  set("feeRowLabel", CFG.feeRowLabel);
  set("feeRowValue", CFG.feeRowValue);
  set("toBePaidLabel", CFG.toBePaidLabel);
  set("botNote", CFG.botNote);
  const help = document.getElementById("helpNote");
  if (help) {
    help.innerHTML = escapeHtml(CFG.helpNote || "").replace(
      "{tg}",
      '<a href="https://t.me/gabenmarket_support" target="_blank">@gabenmarket_support</a>'
    );
  }
}
fillCartLabels();
// Малюємо кошик одразу, не чекаючи інвентаря: умови виплати мають бути на
// екрані з першої секунди, навіть поки нічого не обрано.
renderCart();

// Курс гривні приходить із сервера трохи пізніше за першу відмальовку —
// перемальовуємо ціни, коли він приїхав.
document.addEventListener("currency-rate", () => {
  renderInventoryList();
  renderCart();
});

// Ціну показуємо у валюті, яку обрала людина (currency.js). Усередині все
// лишається в доларах — міняється тільки показ.
function price(usd) {
  return window.fmtPrice ? window.fmtPrice(usd) : `$${(Number(usd) || 0).toFixed(2)}`;
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
