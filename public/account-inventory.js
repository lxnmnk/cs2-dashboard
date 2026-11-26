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
// Мінімальна сума одного продажу; сервер перевіряє те саме й підкаже своє
// значення в помилці MIN_SALE, якщо його змінили в config.json.
let MIN_SALE = 10;

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
    // WELCOME підставляє сайт, а не людина: після першого продажу прибираємо.
    if (promoInput.value === "WELCOME") promoInput.value = "";
    return;
  }
  promoInput.value = promo.code.toUpperCase();
  if (promo.welcome) {
    promoStatus.textContent = REF_TEXT.welcomeApplied.replace("{n}", promo.bonusPercent);
    promoStatus.classList.remove("field-error");
    return;
  }
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
    // Реферальний код є, просто не для цієї людини — кажемо чому, а не
    // "такого коду немає".
    promoStatus.textContent = REF_TEXT[data.error] || CFG.promoNotFound || "";
    promoStatus.classList.add("field-error");
    return;
  }
  showPromo(data.promo);
  // Ціни змінились — перечитуємо інвентар і кошик за новими.
  loadInventory();
});

// ---- Реферальні гроші — до цієї виплати ----
// Хто запрошує друзів (вкладка "Реферали" в профілі), може не виводити
// зароблене окремо, а додати до виплати за свій продаж — без мінімуму. Тексти
// тут, а не в ACCOUNT_CONFIG трьох сторінок: це один рядок на одну галочку.
const REF_TEXT = {
  uk: {
    welcomeApplied: "🎁 WELCOME +{n}% — уже в цінах першого продажу. На частині скінів ціна обмежена ринком.",
    itemBonus: "+{amount} з промокодом",
    cartBonus: "Бонус за промокод",
    WELCOME_USED: "WELCOME діє лише на перший продаж",
    reviewBonus: "🎁 Бонус за відгук: +{n}% — уже в цінах цього продажу",
    reviewInvite: "🎁 Залиш відгук про угоду #{id} у профілі — і отримай +{n}% до цього продажу",
    add: "Додати реферальні {amount} до цієї виплати",
    REFERRAL_NOT_NEW: "Цей код — тільки для нових клієнтів, а ти вже продавав у нас",
    REFERRAL_OWN: "Це твій власний код — його дають друзям, собі застосувати не можна",
    REFERRAL_TAKEN: "Ти вже закріплений за іншим кодом — він діє назавжди",
    campaignOn: "🖤 Black Friday: +{amount} до звичайної ціни — вже в сумі нижче",
    campaignOnEmpty: "🖤 Black Friday: +{n}% до кожного скіна при виплаті на картку",
    PAYOUT_METHOD: "🖤 Black Friday діє лише при виплаті на картку в гривні — обери картку, і ціни зростуть",
    USED: "Ти вже продавав за Black Friday — акція діє один раз на клієнта",
  },
  ru: {
    welcomeApplied: "🎁 WELCOME +{n}% — уже в ценах первой продажи. На части скинов цена ограничена рынком.",
    itemBonus: "+{amount} с промокодом",
    cartBonus: "Бонус по промокоду",
    WELCOME_USED: "WELCOME действует только на первую продажу",
    reviewBonus: "🎁 Бонус за отзыв: +{n}% — уже в ценах этой продажи",
    reviewInvite: "🎁 Оставь отзыв о сделке #{id} в профиле — и получи +{n}% к этой продаже",
    add: "Добавить реферальные {amount} к этой выплате",
    REFERRAL_NOT_NEW: "Этот код — только для новых клиентов, а ты уже продавал у нас",
    REFERRAL_OWN: "Это твой собственный код — его дают друзьям, себе применить нельзя",
    REFERRAL_TAKEN: "Ты уже закреплён за другим кодом — он действует навсегда",
    campaignOn: "🖤 Black Friday: +{amount} к обычной цене — уже в сумме ниже",
    campaignOnEmpty: "🖤 Black Friday: +{n}% к каждому скину при выплате на карту",
    PAYOUT_METHOD: "🖤 Black Friday действует только при выплате на украинскую карту в гривне — это есть на украинской версии сайта",
    USED: "Ты уже продавал по Black Friday — акция действует один раз на клиента",
  },
  en: {
    welcomeApplied: "🎁 WELCOME +{n}% — already in your first sale's prices. Some skins are capped at market price.",
    itemBonus: "+{amount} with promo code",
    cartBonus: "Promo code bonus",
    WELCOME_USED: "WELCOME only works on your first sale",
    reviewBonus: "🎁 Review bonus: +{n}% — already in this sale's prices",
    reviewInvite: "🎁 Review deal #{id} in your profile and get +{n}% on this sale",
    add: "Add your referral {amount} to this payout",
    REFERRAL_NOT_NEW: "This code is for new clients only — you've already sold with us",
    REFERRAL_OWN: "That's your own code — it's for your friends, you can't apply it yourself",
    REFERRAL_TAKEN: "You're already tied to another code — that's for good",
    campaignOn: "🖤 Black Friday: +{amount} on top of the usual price — already in the total below",
    campaignOnEmpty: "🖤 Black Friday: +{n}% on every skin when paid to a card",
    PAYOUT_METHOD: "🖤 Black Friday only works for payouts to a Ukrainian card in UAH — that's on the Ukrainian version of the site",
    USED: "You've already sold under Black Friday — it's once per client",
  },
}[{ ru: "ru", en: "en" }[document.documentElement.lang] || "uk"];

let referralTopUp = 0; // 0 — нема чого додавати
const referralToggle = document.createElement("label");
referralToggle.className = "cart-referral";
referralToggle.style.display = "none";
referralToggle.innerHTML = '<input type="checkbox" id="useReferralBalance" /><span></span>';
promoStatus?.after(referralToggle);
const useReferralInput = referralToggle.querySelector("input");
useReferralInput.addEventListener("change", () => renderCart());

async function loadReferralBalance() {
  try {
    const data = await (await fetch("/api/account/referral")).json();
    const available = data.ok ? data.balance?.available || 0 : 0;
    referralTopUp = available > 0 ? available : 0;
    referralToggle.style.display = referralTopUp > 0 ? "" : "none";
    if (!referralTopUp) useReferralInput.checked = false;
    referralToggle.querySelector("span").textContent = REF_TEXT.add.replace("{amount}", `$${available.toFixed(2)}`);
    renderCart();
  } catch {
    // не увійшов чи мережа — галочки просто не буде
  }
}
loadReferralBalance();

// Код міг приїхати з партнерським посиланням ще до входу — показуємо його.
// Не підійшов (свій, чи людина вже наш клієнт) — показуємо код і причину.
// Бонус за відгук: є — кажемо, що він уже в цінах; немає, але є угода з
// розмороженими грошима без відгуку — запрошуємо його лишити.
const reviewLine = document.createElement("p");
reviewLine.className = "cart-review-bonus";
reviewLine.style.display = "none";
referralToggle.after(reviewLine);

// Акція (Black Friday): діє вона зараз для цього продажу чи ні і чому.
// Стан приходить разом з інвентарем — він залежить від способу виплати.
let campaignState = null; // { campaign, applied, blocked }
const campaignLine = document.createElement("p");
campaignLine.className = "cart-campaign";
campaignLine.style.display = "none";
reviewLine.after(campaignLine);

function renderCampaignLine(total, baseTotal) {
  const c = campaignState;
  if (!c?.campaign) {
    campaignLine.style.display = "none";
    return;
  }
  let text;
  if (c.applied) {
    const extra = total - baseTotal;
    text =
      cart.length && extra > 0.005
        ? REF_TEXT.campaignOn.replace("{amount}", price(extra))
        : REF_TEXT.campaignOnEmpty.replace("{n}", c.campaign.bonusPercent);
  } else {
    text = REF_TEXT[c.blocked] || "";
  }
  campaignLine.textContent = text;
  campaignLine.classList.toggle("is-off", !c.applied);
  campaignLine.style.display = text ? "" : "none";
}

function refreshPromoLine() {
  return fetch("/api/account/promo")
    .then((r) => r.json())
    .then((d) => {
      reviewLine.style.display = "none";
      if (d.reviewBonus) {
        reviewLine.textContent = REF_TEXT.reviewBonus.replace("{n}", d.reviewBonus);
        reviewLine.style.display = "";
      } else if (d.reviewInvite) {
        const profileUrl = { ru: "/ru/profile", en: "/en/profile" }[document.documentElement.lang] || "/profile";
        reviewLine.innerHTML = `<a href="${profileUrl}">${escapeHtml(
          REF_TEXT.reviewInvite.replace("{id}", d.reviewInvite.saleId).replace("{n}", d.reviewBonusPercent)
        )}</a>`;
        reviewLine.style.display = "";
      }
      if (d.promo) return showPromo(d.promo);
      if (d.rejected) {
        promoInput.value = d.rejected.code.toUpperCase();
        promoStatus.textContent = REF_TEXT[d.rejected.reason] || "";
        promoStatus.classList.add("field-error");
        return;
      }
      showPromo(null);
    })
    .catch(() => {});
}
refreshPromoLine();

// ---- Спосіб виплати і реквізити ----
// Виплату власник робить руками, тож усе це — дані для нього: куди саме
// переказати гроші, коли закінчиться холд.
//
// Способів вісім (картка плюс сім мереж), і розгорнутим списком вони займали
// б половину кошика. Тому видно лише обраний, решта — за "змінити": один
// рядок у спокої, сітка на час вибору.
let payoutMethod = "card"; // card | crypto — те, що розуміє сервер
let payoutNetwork = null; // для crypto: мережу треба знати окремо

// Назви мереж не перекладаємо: людина звіряє напис із тим, що бачить у
// гаманці. chain — за яким форматом перевіряти адресу.
// Українська картка є тільки на українській версії сайту: решті платимо в
// крипті. Прапорець задає сторінка (CFG), а не цей файл — мовні відмінності
// живуть у мовних файлах.
const PAYOUT_CARD_ENABLED = CFG.payoutCardEnabled !== false;
const PAYOUT_OPTIONS = [
  { id: "card", kind: "card", coin: "\u20b4", coinClass: "coin-uah" },
  { id: "usdt-trc20", kind: "crypto", coin: "\u20ae", coinClass: "coin-usdt", title: "USDT", badge: "TRC-20", chain: "tron" },
  { id: "usdt-erc20", kind: "crypto", coin: "\u20ae", coinClass: "coin-usdt", title: "USDT", badge: "ERC-20", chain: "evm" },
  { id: "usdt-bep20", kind: "crypto", coin: "\u20ae", coinClass: "coin-usdt", title: "USDT", badge: "BEP-20", chain: "evm" },
  { id: "usdt-sol", kind: "crypto", coin: "\u20ae", coinClass: "coin-usdt", title: "USDT", badge: "Solana", chain: "solana" },
  { id: "usdc-trc20", kind: "crypto", coin: "$", coinClass: "coin-usdc", title: "USDC", badge: "TRC-20", chain: "tron" },
  { id: "usdc-erc20", kind: "crypto", coin: "$", coinClass: "coin-usdc", title: "USDC", badge: "ERC-20", chain: "evm" },
  { id: "usdc-bep20", kind: "crypto", coin: "$", coinClass: "coin-usdc", title: "USDC", badge: "BEP-20", chain: "evm" },
].filter((o) => o.kind !== "card" || PAYOUT_CARD_ENABLED);

const PAYOUT_ADDRESS_RE = {
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

const payoutSelected = document.getElementById("payoutSelected");
const payoutSelectedIcon = document.getElementById("payoutSelectedIcon");
const payoutSelectedTitle = document.getElementById("payoutSelectedTitle");
const payoutSelectedSub = document.getElementById("payoutSelectedSub");
const payoutChange = document.getElementById("payoutChange");
const payoutPicker = document.getElementById("payoutPicker");
const payoutCardFields = document.getElementById("payoutCardFields");
const payoutCryptoFields = document.getElementById("payoutCryptoFields");
const payoutBank = document.getElementById("payoutBank");
const payoutBankName = document.getElementById("payoutBankName");
const payoutCardNumber = document.getElementById("payoutCardNumber");
const payoutHolder = document.getElementById("payoutHolder");
const payoutAddress = document.getElementById("payoutAddress");
const payoutError = document.getElementById("payoutError");

let payoutChoice = PAYOUT_OPTIONS[0];
// Без картки перший спосіб — крипта, і стан має збігатись із ним одразу:
// інакше кошик лишався б у режимі картки з прихованими полями.
if (payoutChoice.kind === "crypto") {
  payoutMethod = "crypto";
  payoutNetwork = payoutChoice.id;
}

function payoutOptionTitle(opt) {
  return opt.kind === "card" ? CFG.payoutCardTitle || "CARD UAH" : opt.title;
}

function payoutTile(opt) {
  const active = opt.id === payoutChoice.id ? " active" : "";
  // У плитці назва й мережа стоять у два рядки. Для картки другим рядком
  // йде валюта: "КАРТКА UAH" одним рядком у вузькій плитці переносилось
  // навпіл і виглядало зламаним.
  const full = payoutOptionTitle(opt);
  const cut = opt.kind === "card" ? full.lastIndexOf(" ") : -1;
  const name = cut > 0 ? full.slice(0, cut) : full;
  const sub = opt.badge || (cut > 0 ? full.slice(cut + 1) : "");
  return `<button class="payout-tile${active}" type="button" data-id="${opt.id}">
      <span class="payout-coin ${opt.coinClass}">${opt.coin}</span>
      <span class="payout-tile-name">${escapeHtml(name)}${sub ? `<span class="payout-tile-badge">${escapeHtml(sub)}</span>` : ""}</span>
    </button>`;
}

function renderPayoutChoice() {
  payoutSelectedIcon.className = `payout-coin ${payoutChoice.coinClass}`;
  payoutSelectedIcon.textContent = payoutChoice.coin;
  payoutSelectedTitle.textContent = payoutOptionTitle(payoutChoice);
  payoutSelectedSub.textContent =
    payoutChoice.kind === "card" ? CFG.payoutCardNote || "" : `${payoutChoice.title} \u00b7 ${payoutChoice.badge}`;
  payoutChange.textContent = CFG.payoutChange || "";

  payoutCardFields.style.display = payoutChoice.kind === "card" ? "" : "none";
  payoutCryptoFields.style.display = payoutChoice.kind === "crypto" ? "" : "none";
  payoutError.textContent = "";
}

function openPayoutPicker(open) {
  payoutPicker.style.display = open ? "" : "none";
  payoutSelected.classList.toggle("open", open);
  if (open) payoutPicker.innerHTML = PAYOUT_OPTIONS.map(payoutTile).join("");
}

payoutSelected?.addEventListener("click", () => openPayoutPicker(payoutPicker.style.display === "none"));

payoutPicker?.addEventListener("click", (e) => {
  const btn = e.target.closest(".payout-tile");
  if (!btn) return;
  payoutChoice = PAYOUT_OPTIONS.find((o) => o.id === btn.dataset.id) || PAYOUT_OPTIONS[0];
  payoutMethod = payoutChoice.kind;
  payoutNetwork = payoutChoice.kind === "crypto" ? payoutChoice.id : null;
  openPayoutPicker(false);
  renderPayoutChoice();
  // Крипта рахується в доларах, картка — у гривні. Перемикаємо показ самі,
  // щоб людина бачила суму в тій валюті, в якій її й отримає. Без
  // перезавантаження: воно скинуло б щойно обрані предмети.
  window.setCurrency?.(payoutMethod === "crypto" ? "USD" : "UAH", { reload: false });
  // Акція залежить від способу виплати — ціни треба перечитати з сервера.
  if (campaignState) return loadInventory();
  renderInventoryList();
  renderCart();
});

function fillPayoutSelects() {
  if (!payoutBank) return;
  const banks = CFG.payoutBanks || {};
  payoutBank.innerHTML =
    '<option value="" disabled selected>\u2014</option>' +
    Object.entries(banks).map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join("");
  payoutBankName.placeholder = CFG.payoutBankNamePlaceholder || "";
  payoutHolder.placeholder = CFG.payoutHolderPlaceholder || "";
  payoutAddress.placeholder = CFG.payoutAddressPlaceholder || "";

  // Підписи над полями — звідси ж, щоб у кожної мовної версії були свої.
  document.getElementById("payoutBankLabelEl").textContent = CFG.payoutBankLabel || "";
  document.getElementById("payoutCardLabelEl").textContent = CFG.payoutCardLabel || "";
  document.getElementById("payoutHolderLabelEl").textContent = CFG.payoutHolderLabel || "";
  document.getElementById("payoutHolderHintEl").textContent = CFG.payoutHolderHint || "";
  document.getElementById("payoutAddressLabelEl").textContent = CFG.payoutAddressLabel || "";
  document.getElementById("payoutAddressHintEl").textContent = CFG.payoutAddressHint || "";
}

// "Інший банк" — єдиний випадок, коли назву треба вписати руками.
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

/**
 * Реквізити для запиту, або null — тоді в payoutError лежить причина.
 * Перевіряємо те саме, що й сервер (payoutDetails.js): він лишається
 * головним, але сказати про помилку до натискання "Продати" чесніше.
 */
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
    if (!/^[\p{L}'\u2019-]{2,}(\s+[\p{L}'\u2019-]{2,})+$/u.test(holder)) return fail(CFG.payoutErrHolder);

    return { bank, bankName, cardNumber: card, holder };
  }

  const address = payoutAddress.value.trim();
  if (!PAYOUT_ADDRESS_RE[payoutChoice.chain].test(address)) return fail(CFG.payoutErrAddress);
  return { network: payoutNetwork, address };
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
      const opt = PAYOUT_OPTIONS.find((o) => o.id === d.network);
      if (opt) {
        payoutChoice = opt;
        payoutMethod = "crypto";
        payoutNetwork = opt.id;
        renderPayoutChoice();
        window.setCurrency?.("USD", { reload: false });
        renderCart();
      }
      payoutAddress.value = d.address || "";
    }
  })
  .catch(() => {});

fillPayoutSelects();
renderPayoutChoice();
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

// Що з предмета потрібно кошику: ціна, ціна без акції (basePrice) і ціна
// зовсім без кодів (plainPrice) — з неї рядок "Бонус за промокод" унизу.
function cartEntry(item) {
  return {
    assetId: item.assetId,
    marketHashName: item.marketHashName,
    price: item.price,
    basePrice: item.basePrice ?? null,
    plainPrice: item.plainPrice ?? null,
  };
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
      cart.push(cartEntry(item));
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
      useReferralBalance: useReferralInput.checked,
    }),
  });
  const data = await res.json();

  sellAutoBtn.disabled = false;

  if (data.error === "PRICE_CHANGED") {
    await repriceCart();
    sellStatusEl.textContent = CFG.priceChanged;
    return;
  }
  if (data.error === "MIN_SALE") {
    if (data.min) MIN_SALE = Number(data.min);
    renderCart();
    sellStatusEl.textContent = (CFG.minSaleNote || "").replace("{min}", price(MIN_SALE)).replace("{left}", price(Math.max(0, MIN_SALE - (data.total || 0))));
    return;
  }
  if (!data.ok) {
    sellStatusEl.textContent = `${sellFailedPrefix}${data.error}`;
    return;
  }

  sellOfferModal.show(data);
  // Реферальні гроші пішли в цю виплату — галочка більше не потрібна.
  if (data.referralTopUp) {
    useReferralInput.checked = false;
    loadReferralBalance();
  }
  cart = [];
  renderInventoryList();
  renderCart();
  // WELCOME витрачено: рядок промокоду має показати вже новий стан.
  refreshPromoLine();
});

// Ціна викупу поїхала вниз: перечитуємо інвентар і ставимо в кошик нові
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

/**
 * Картки-привиди на час завантаження інвентарю.
 *
 * Рядок "Завантажую інвентар..." на порожньому екрані виглядає як
 * зависання — особливо коли Steam відповідає десять секунд. Сітка сірих
 * карток показує, що саме зараз з'явиться, і місце під неї вже зайняте:
 * коли приходять дані, сторінка не стрибає.
 */
function inventorySkeletons(count = 12) {
  if (!inventoryListEl) return;
  inventoryListEl.innerHTML = Array.from({ length: count })
    .map(
      () => `<div class="inventory-card skeleton-card">
          <div class="skeleton-box skeleton-img"></div>
          <div class="skeleton-box skeleton-line"></div>
          <div class="skeleton-box skeleton-line short"></div>
        </div>`
    )
    .join("");
}

async function loadInventory({ refresh = false } = {}) {
  if (inventoryRefreshBtn) inventoryRefreshBtn.disabled = true;
  // Привидів показуємо лише на першому завантаженні: при оновленні вже є що
  // показувати, і підміна готового списку сірими картками виглядала б як
  // втрата даних.
  if (!inventoryItems.length) inventorySkeletons();
  inventoryLoadingEl.style.display = "block";
  inventoryPrivateEl.style.display = "none";
  inventoryEmptyEl.style.display = "none";

  let data;
  try {
    // Спосіб виплати — бо від нього залежить акція (лише на картку).
    const params = new URLSearchParams({ payout: payoutMethod });
    if (refresh) params.set("refresh", "1");
    const res = await fetch(`/api/account/inventory?${params}`);
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
  campaignState = data.campaign ? { campaign: data.campaign, applied: !!data.campaignApplied, blocked: data.campaignBlocked } : null;
  // Привиди зникають разом із першим справжнім рендером нижче.

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
      return fresh && fresh.price != null ? cartEntry(fresh) : null;
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

      // Цей предмет не приймається на викуп — показуємо, але без кнопки продажу.
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
          <span class="inventory-card-price">${wasPrice(it)}${price(it.price)}</span>
          ${bonusExtra(it)}
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
          cart.push(cartEntry(it));
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

  cart.push(cartEntry(item));
  renderInventoryList();
  renderCart();
}

function removeItem(assetId) {
  cart = cart.filter((it) => it.assetId !== assetId);
  renderInventoryList();
  renderCart();
}

// ---- Плашка кошика внизу екрана (телефон) ----
// На телефоні кошик стоїть під усім інвентарем: вибрав скіни — і гортай до
// кінця списку, щоб натиснути "Продати". Плашка над нижнім меню показує,
// скільки вибрано, і веде до кошика. На комп'ютері її ховає CSS — там кошик
// і так поруч.
const CART_BAR_TEXT = {
  uk: { picked: "Вибрано: {n}", go: "До продажу →" },
  ru: { picked: "Выбрано: {n}", go: "К продаже →" },
  en: { picked: "Picked: {n}", go: "To checkout →" },
}[{ ru: "ru", en: "en" }[document.documentElement.lang] || "uk"];
const cartBar = document.createElement("button");
cartBar.type = "button";
cartBar.className = "mobile-cart-bar";
cartBar.innerHTML = '<span class="mobile-cart-bar-count"></span><b class="mobile-cart-bar-sum"></b><span class="mobile-cart-bar-go"></span>';
cartBar.querySelector(".mobile-cart-bar-go").textContent = CART_BAR_TEXT.go;
document.body.appendChild(cartBar);
cartBar.addEventListener("click", () => cartSection?.scrollIntoView({ behavior: "smooth", block: "start" }));

function renderCartBar(total) {
  cartBar.classList.toggle("is-visible", cart.length > 0);
  cartBar.querySelector(".mobile-cart-bar-count").textContent = CART_BAR_TEXT.picked.replace("{n}", cart.length);
  cartBar.querySelector(".mobile-cart-bar-sum").textContent = price(total);
}

function renderCart() {
  saveCart();
  const sellBtn = document.getElementById("sellAutoBtn");
  const total = cart.reduce((sum, it) => sum + it.price, 0);
  const baseTotal = cart.reduce((sum, it) => sum + (it.basePrice ?? it.price), 0);
  renderCartBar(total);
  renderCampaignLine(total, baseTotal);

  // Назв предметів тут немає: вони вже на картках. Натомість те, чого на
  // картках не видно — скільки вийде разом, куди і коли прийдуть гроші.
  // Блок виплати показуємо і на порожньому кошику: людина має бачити умови
  // до того, як щось обере, а не після.
  cartPickedLine.textContent = (CFG.cartPicked || "").replace("{n}", cart.length);
  cartTotal.textContent = price(total);
  // До виплати — разом із реферальними грошима, якщо людина їх додала.
  const topUp = useReferralInput?.checked && cart.length ? referralTopUp : 0;
  cartPayout.textContent = price(total + topUp);
  cartItemsCount.textContent = String(cart.length);
  renderBonusRow();
  cartEmptyLine.textContent = cart.length ? "" : CFG.cartEmpty || "";
  // Мінімальна сума продажу (config.sales.minTotalUsd на сервері) — кажемо
  // заздалегідь, скільки ще додати, а не після натискання "Продати".
  const belowMin = cart.length > 0 && total + 0.001 < MIN_SALE;
  if (belowMin) {
    cartEmptyLine.textContent = (CFG.minSaleNote || "").replace("{min}", price(MIN_SALE)).replace("{left}", price(MIN_SALE - total));
  }
  if (sellBtn) sellBtn.disabled = !cart.length || belowMin;

  // Дата виплати: гроші приходять після холду Steam — 7 днів від обміну.
  const unlock = new Date(Date.now() + 7 * 86400000);
  payoutDateLine.innerHTML = `${escapeHtml(
    (CFG.payoutDateLine || "").replace("{date}", unlock.toLocaleDateString(CFG.dateLocale || "uk-UA"))
  )}<span class="payout-hint">${escapeHtml(CFG.payoutHint || "")}</span>`;
  sellStatusEl.textContent = "";
}

// Скільки людина отримує зверху за промокод/бонус на всьому кошику — те саме
// "+$X", що на картках, тільки разом. Ціни округлені до центів, тож на
// дешевих скінах (3% від $0.06 — менше цента) бонусу справді немає, і рядок
// не показуємо, щоб не писати "+$0.00".
let bonusRow = null;
function renderBonusRow() {
  if (!bonusRow) {
    const feeRow = document.getElementById("feeRowLabel")?.closest(".cart-row");
    if (!feeRow) return;
    bonusRow = document.createElement("div");
    bonusRow.className = "cart-row";
    bonusRow.innerHTML = '<span></span><span class="cart-row-ok"></span>';
    feeRow.after(bonusRow);
  }
  const extra = cart.reduce((sum, it) => sum + (it.plainPrice != null ? it.price - it.plainPrice : 0), 0);
  bonusRow.style.display = extra >= 0.005 ? "" : "none";
  bonusRow.firstElementChild.textContent = REF_TEXT.cartBonus;
  bonusRow.lastElementChild.textContent = "+" + price(extra);
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

// Ціна без промокоду/бонусу, закреслена перед новою: "було → стало" на
// кожному скіні. plainPrice — зовсім без кодів; basePrice — лише без акції.
function wasPrice(it) {
  const was = it.plainPrice ?? it.basePrice;
  return was != null && was < it.price ? `<s class="price-was">${price(was)}</s> ` : "";
}

// Скільки людина отримує зверху за код на цьому скіні — окремим рядком під
// ціною, щоб не рахувати різницю в голові.
function bonusExtra(it) {
  if (it.plainPrice == null || it.price == null) return "";
  return `<span class="price-bonus">${escapeHtml(REF_TEXT.itemBonus.replace("{amount}", price(it.price - it.plainPrice)))}</span>`;
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
