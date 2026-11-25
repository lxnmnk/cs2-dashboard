// Сторінка предмета з вітрини (/buy/item?id=<stackId>): усі вільні лоти
// цього скіна — float, паттерн, наліпки, Instant/P2P, ціна.
//
// "Купити" платить балансом на сайті (trade + available): сервер ще раз
// перевіряє лот і ціну, списує баланс і оформлює покупку, а трейд приходить
// на trade-посилання клієнта. Немає входу, посилання або грошей —
// пояснюємо, що зробити: увійти, додати посилання, поповнити баланс.
const T = window.ITEM_CONFIG;

const params = new URLSearchParams(location.search);
const stackId = params.get("id") || "";
// ?own=<id> — наш власний скін (ownSkins.js): сторінка з нашими лотами.
const ownId = params.get("own") || "";
const view = {
  delivery: ["instant", "p2p"].includes(params.get("delivery")) ? params.get("delivery") : "",
  sort: "price",
  floatMin: "",
  floatMax: "",
};

let item = null;
let listings = [];
let me = null; // { customer, balance } з /api/account/me

const $ = (id) => document.getElementById(id);

function money(n) {
  return window.fmtPrice ? window.fmtPrice(n) : `$${(Number(n) || 0).toFixed(2)}`;
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function deliveryBadge(d) {
  return `<span class="delivery-tag ${d}" title="${esc(d === "instant" ? T.instantTip : T.p2pTip)}"><span class="delivery-dot ${d}"></span>${
    d === "instant" ? "Instant" : "P2P"
  }</span>`;
}

// Смужка float як у Steam: зелений FN -> червоний BS, мітка — де саме цей лот.
function floatBar(f) {
  if (f == null) return '<span class="na">—</span>';
  return `<div class="float-cell"><span class="float-value">${f.toFixed(6)}</span><span class="float-bar"><span class="float-mark" style="left:${Math.min(
    100,
    Math.max(0, f * 100)
  ).toFixed(1)}%"></span></span></div>`;
}

// Наш скін: шле сам власник (P2P). Під трейдлоком — віддамо після дати.
function ownBadges(l) {
  if (!l.own) return "";
  const lock = l.locked ? `<span class="lot-lock" title="${esc(T.lockedTip)}">🔒 ${esc(T.lockedUntil.replace("{date}", shortDate(l.unlockAt)))}</span>` : "";
  return `<span class="lot-own">${esc(T.ourSkin)}</span>${lock}`;
}

function shortDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(document.documentElement.lang || undefined, { day: "2-digit", month: "2-digit" });
  } catch {
    return "";
  }
}

// ---- Завантаження ----
async function load() {
  const url = ownId
    ? `/api/public/market/own?id=${encodeURIComponent(ownId)}`
    : /^[a-f0-9]{32}$/.test(stackId)
    ? `/api/public/market/stack?id=${encodeURIComponent(stackId)}`
    : null;
  if (!url) return showStatus(T.notFound);
  showStatus(T.loading);
  let data;
  try {
    data = await (await fetch(url)).json();
  } catch {
    data = { ok: false };
  }
  if (!data.ok) return showStatus(data.error === "BUSY" ? T.busy : T.loadError);
  item = data.item;
  listings = data.listings || [];
  if (!item) return showStatus(T.soldOut);
  renderHead();
  renderList();
}

function showStatus(text) {
  $("itemStatus").style.display = "block";
  $("itemStatus").textContent = text;
  $("itemBody").style.display = "none";
}

function renderHead() {
  $("itemStatus").style.display = "none";
  $("itemBody").style.display = "block";
  document.title = `${item.marketHashName} — gaben.market`;
  $("itemImg").src = item.icon || "";
  $("itemImg").style.display = item.icon ? "block" : "none";
  $("itemName").textContent = item.name.replace(/^★ /, "★ ");
  if (item.nameColor) $("itemName").style.color = item.nameColor;
  $("itemTags").innerHTML = [
    item.wear ? `<span class="wear-code wear-${esc(item.wear)}">${esc(item.wear)}</span>` : "",
    item.phase ? `<span class="item-phase">${esc(item.phase)}</span>` : "",
    item.stattrak ? '<span class="tag-stattrak">StatTrak™</span>' : "",
    item.souvenir ? '<span class="tag-souvenir">Souvenir</span>' : "",
  ]
    .filter(Boolean)
    .join(" ");

  const instant = listings.filter((l) => l.delivery === "instant");
  const p2p = listings.filter((l) => l.delivery === "p2p");
  const min = (arr) => (arr.length ? Math.min(...arr.map((l) => l.price)) : null);
  $("itemSummary").innerHTML = [
    [T.all, listings.length, min(listings)],
    ["Instant", instant.length, min(instant)],
    ["P2P", p2p.length, min(p2p)],
  ]
    .map(
      ([label, n, price]) =>
        `<div class="item-sum"><span class="item-sum-label">${esc(label)}</span><span>${esc(T.offers.replace("{n}", n))}</span>${
          price != null ? `<span class="item-sum-price">${esc(T.from)} ${money(price)}</span>` : ""
        }</div>`
    )
    .join("");
}

function visible() {
  const fMin = parseFloat(view.floatMin);
  const fMax = parseFloat(view.floatMax);
  const rows = listings.filter((l) => {
    if (view.delivery && l.delivery !== view.delivery) return false;
    if (Number.isFinite(fMin) && (l.float == null || l.float < fMin)) return false;
    if (Number.isFinite(fMax) && (l.float == null || l.float > fMax)) return false;
    return true;
  });
  const byFloat = (a, b) => (a.float ?? 2) - (b.float ?? 2);
  const sorters = {
    price: (a, b) => a.price - b.price,
    "-price": (a, b) => b.price - a.price,
    float: byFloat,
    "-float": (a, b) => -byFloat(a, b),
  };
  return rows.sort(sorters[view.sort] || sorters.price);
}

function renderList() {
  document.querySelectorAll("[data-delivery]").forEach((b) => b.classList.toggle("active", (b.dataset.delivery || "") === view.delivery));
  const rows = visible();
  $("itemCount").textContent = T.offers.replace("{n}", rows.length);
  if (!rows.length) {
    $("itemRows").innerHTML = `<div class="card-hint item-empty">${esc(listings.length ? T.nothingFiltered : T.soldOut)}</div>`;
    return;
  }
  $("itemRows").innerHTML = rows
    .map(
      (l) => `
      <div class="lot-row">
        <div class="lot-delivery">${deliveryBadge(l.delivery)}${ownBadges(l)}</div>
        <div class="lot-float">${floatBar(l.float)}</div>
        <div class="lot-pattern">${l.pattern != null ? `<span class="na">${esc(T.pattern)}</span> ${esc(l.pattern)}` : ""}</div>
        <div class="lot-stickers">${l.stickers
          .filter((s) => s.icon)
          .map((s) => `<img src="${esc(s.icon)}" alt="" title="${esc(s.name || "")}" loading="lazy" />`)
          .join("")}</div>
        <div class="lot-price">${money(l.price)}</div>
        <div class="lot-actions">
          ${l.inspectLink ? `<a class="lot-inspect" href="${esc(l.inspectLink)}" title="${esc(T.inspect)}">🔍</a>` : ""}
          <button class="btn-gold lot-buy" type="button" data-buy="${esc(l.id)}">${esc(T.buy)}</button>
        </div>
      </div>`
    )
    .join("");
  $("itemRows").querySelectorAll("[data-buy]").forEach((btn) => {
    btn.addEventListener("click", () => openBuy(listings.find((l) => l.id === btn.dataset.buy)));
  });
}

// ---- Купівля ----
async function loadMe() {
  try {
    me = await (await fetch("/api/account/me")).json();
  } catch {
    me = null;
  }
  return me;
}

function spendable() {
  const b = me?.balance;
  if (!b) return 0;
  return Math.max(0, b.available || 0) + Math.max(0, b.trade || 0);
}

// Не вистачає грошей: поповнити (сума підставиться сама) або продати свої
// скіни. Купівлю "через Telegram" прибрали — усе робиться на сайті.
function notEnoughActions(lot, have) {
  return `
      <div class="buy-actions">
        <a class="btn-gold" href="${esc(T.profileUrl)}?tab=topup&need=${Math.max(0, lot.price - have).toFixed(2)}">${esc(T.topUp)}</a>
        <a class="btn-outline" href="${esc(T.sellUrl)}">${esc(T.sellSkins)}</a>
      </div>`;
}

function modal(html) {
  $("buyModalBody").innerHTML = html;
  $("buyModal").style.display = "flex";
}

function closeModal() {
  $("buyModal").style.display = "none";
}

function lotSummary(lot) {
  return `
    <div class="buy-lot">
      ${item.icon ? `<img src="${esc(item.icon)}" alt="" />` : ""}
      <div>
        <div class="buy-lot-name">${esc(item.marketHashName)}</div>
        <div class="buy-lot-meta">${deliveryBadge(lot.delivery)}${ownBadges(lot)}${lot.float != null ? ` · Float ${lot.float.toFixed(6)}` : ""}${
    lot.pattern != null ? ` · ${esc(T.pattern)} ${esc(lot.pattern)}` : ""
  }</div>
      </div>
      <div class="buy-lot-price">${money(lot.price)}</div>
    </div>`;
}

async function openBuy(lot) {
  if (!lot) return;
  modal(`${lotSummary(lot)}<p class="card-hint">${esc(T.checking)}</p>`);
  await loadMe();

  if (!me?.customer) {
    return modal(`${lotSummary(lot)}
      <p>${esc(T.needLogin)}</p>
      <div class="buy-actions">
        <a class="btn-gold" href="${esc(T.loginUrl)}">${esc(T.login)}</a>
      </div>`);
  }
  // Своєї ссылки немає — купити можна лише в подарунок (поле відкрите).
  const ownLink = !!me.customer.tradeUrl;
  const have = spendable();
  if (have + 0.001 < lot.price) {
    return modal(`${lotSummary(lot)}
      <p>${esc(T.notEnough.replace("{balance}", money(have)).replace("{price}", money(lot.price)))}</p>
      ${notEnoughActions(lot, have)}`);
  }

  modal(`${lotSummary(lot)}
    <div class="buy-balance"><span>${esc(T.yourBalance)}</span><span>${money(have)}</span></div>
    <div class="buy-balance"><span>${esc(T.afterBuy)}</span><span>${money(have - lot.price)}</span></div>
    <ul class="buy-notes">
      <li>${esc(
        lot.own
          ? lot.locked
            ? T.noteOwnLocked.replace("{date}", shortDate(lot.unlockAt))
            : T.noteOwn
          : lot.delivery === "instant"
          ? T.noteInstant
          : T.noteP2p
      )}</li>
      <li>${esc(T.noteFinal)}</li>
      <li>${esc(T.noteRefund)}</li>
    </ul>
    <div class="buy-gift">
      ${
        ownLink
          ? `<label class="buy-gift-toggle"><input type="checkbox" id="giftToggle" /> ${esc(T.giftToggle)}</label>`
          : `<p class="buy-gift-title">${esc(T.giftNoOwnLink)} <a href="${esc(T.profileUrl)}">${esc(T.setTradeUrl)}</a></p>`
      }
      <div id="giftBox" class="buy-gift-box"${ownLink ? " hidden" : ""}>
        <input id="giftUrl" class="buy-gift-input" type="url" inputmode="url" autocomplete="off" spellcheck="false"
          placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..." />
        <div id="giftWho" class="buy-gift-who"></div>
        <p class="buy-gift-warn">${esc(T.giftWarn)}</p>
      </div>
    </div>
    <div class="buy-actions">
      <button id="buyConfirm" class="btn-gold" type="button">${esc(T.confirm.replace("{price}", money(lot.price)))}</button>
      <button class="btn-outline" type="button" data-close="1">${esc(T.cancel)}</button>
    </div>`);
  gift.on = !ownLink;
  gift.recipient = null;
  gift.url = "";
  syncGift();
  $("giftToggle")?.addEventListener("change", (e) => {
    gift.on = e.target.checked;
    $("giftBox").hidden = !gift.on;
    if (gift.on) $("giftUrl").focus();
    syncGift();
  });
  $("giftUrl").addEventListener("input", () => {
    // Поки нову ссылку не перевірили — купити не можна.
    gift.recipient = null;
    gift.seq++;
    syncGift();
    clearTimeout(gift.timer);
    gift.timer = setTimeout(checkRecipient, 350);
  });
  $("buyConfirm").addEventListener("click", () => confirmBuy(lot));
}

// ---- Подарунок: трейд на чужу trade-ссылку ----
// Купівля лише тоді, коли сервер показав, чий це профіль: людина бачить
// нік і аватар і помічає опечатку до оплати. На сервер іде лише partner.
const TRADE_URL_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=[\w-]+$/;
const gift = { on: false, url: "", recipient: null, timer: 0, seq: 0 };

function syncGift() {
  const btn = $("buyConfirm");
  if (btn) btn.disabled = gift.on && !gift.recipient;
}

async function checkRecipient() {
  const who = $("giftWho");
  if (!who) return;
  const url = $("giftUrl").value.trim();
  const seq = ++gift.seq;
  gift.recipient = null;
  gift.url = "";
  syncGift();
  if (!url) return (who.innerHTML = "");
  const m = TRADE_URL_RE.exec(url);
  if (!m) return (who.innerHTML = `<span class="buy-err">${esc(T.giftBadUrl)}</span>`);
  who.innerHTML = `<span class="buy-gift-note">${esc(T.giftChecking)}</span>`;
  let data;
  try {
    data = await (await fetch(`/api/account/market/recipient?partner=${encodeURIComponent(m[1])}`)).json();
  } catch {
    data = { ok: false };
  }
  if (seq !== gift.seq) return;
  if (!data.ok) return (who.innerHTML = `<span class="buy-err">${esc(data.error === "BAD_TRADE_URL" ? T.giftBadUrl : T.giftCheckFailed)}</span>`);
  const r = data.recipient;
  gift.recipient = { ...r, self: !!data.self };
  gift.url = url;
  who.innerHTML = `
    <a class="buy-gift-profile" href="${esc(r.profileUrl)}" target="_blank" rel="noopener">
      ${r.avatar ? `<img src="${esc(r.avatar)}" alt="" />` : ""}
      <span><b>${esc(r.name)}</b><small>Steam ID ${esc(r.steamId)} ↗</small></span>
    </a>
    <span class="buy-gift-note">${esc(data.self ? T.giftSelf : T.giftCheckProfile)}</span>`;
  syncGift();
}

async function confirmBuy(lot) {
  const btn = $("buyConfirm");
  if (gift.on && !gift.recipient) return;
  // Що саме оплатили — фіксуємо до запиту: поле можуть змінити, поки чекаємо.
  const sentTo = gift.on && gift.recipient && !gift.recipient.self ? gift.recipient : null;
  const giftTradeUrl = gift.on ? gift.url : "";
  btn.disabled = true;
  btn.textContent = T.buying;
  let res;
  let data;
  try {
    res = await fetch("/api/account/market/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stackId, listingId: lot.id, price: lot.price, ...(giftTradeUrl ? { giftTradeUrl } : {}) }),
    });
    data = await res.json();
  } catch {
    data = { ok: false, error: "NETWORK" };
  }
  if (typeof window.refreshNavBalance === "function") window.refreshNavBalance();

  if (data.ok) {
    listings = listings.filter((l) => l.id !== lot.id);
    renderHead();
    renderList();
    if (sentTo) {
      return modal(`${lotSummary(lot)}
      <p class="buy-ok">🎁 ${esc(T.doneGift.replace("{name}", sentTo.name))}</p>
      ${lot.own && lot.locked ? `<p class="card-hint">${esc(T.noteOwnLocked.replace("{date}", shortDate(lot.unlockAt)))}</p>` : ""}
      <div class="buy-actions">
        <a class="btn-gold" href="${esc(T.profileUrl)}?tab=purchases">${esc(T.myPurchases)}</a>
      </div>
      <p class="card-hint">${esc(T.refundNote)}</p>`);
    }
    return modal(`${lotSummary(lot)}
      <p class="buy-ok">✅ ${esc(
        lot.own
          ? lot.locked
            ? T.doneOwnLocked.replace("{date}", shortDate(lot.unlockAt))
            : T.doneOwn
          : lot.delivery === "instant"
          ? T.doneInstant
          : T.doneP2p
      )}</p>
      <div class="buy-actions">
        <a class="btn-gold" href="https://steamcommunity.com/my/tradeoffers" target="_blank">${esc(T.openTrades)}</a>
        <a class="btn-outline" href="${esc(T.profileUrl)}?tab=purchases">${esc(T.myPurchases)}</a>
      </div>
      <p class="card-hint">${esc(T.refundNote)}</p>`);
  }

  const msg =
    {
      PRICE_CHANGED: data.price ? T.errPriceChanged.replace("{price}", money(data.price)) : T.errPriceChangedNoPrice,
      ITEM_GONE: T.errGone,
      INSUFFICIENT_BALANCE: T.notEnough.replace("{balance}", money(data.balance ?? spendable())).replace("{price}", money(data.price ?? lot.price)),
      NO_TRADE_URL: T.needTradeUrl,
      BAD_TRADE_URL: T.giftBadUrl,
      NOT_LOGGED_IN: T.needLogin,
      PENDING_CHECK: T.errPending,
      SHOP_UNAVAILABLE: T.errShop,
    }[data.error] || T.errGeneric;
  modal(`${lotSummary(lot)}
    <p class="buy-err">${esc(msg)}</p>
    ${
      data.error === "INSUFFICIENT_BALANCE"
        ? notEnoughActions(lot, data.balance ?? spendable())
        : `<div class="buy-actions"><button class="btn-gold" type="button" data-close="1">${esc(T.close)}</button></div>`
    }`);
  // Ціна змінилась або лот зник — показуємо актуальний список.
  if (["PRICE_CHANGED", "ITEM_GONE"].includes(data.error)) load();
}

// ---- Події ----
$("buyModal").addEventListener("click", (e) => {
  if (e.target.id === "buyModal" || e.target.closest("[data-close]") || e.target.closest(".modal-close")) closeModal();
});

document.querySelectorAll("[data-delivery]").forEach((btn) => {
  btn.addEventListener("click", () => {
    view.delivery = btn.dataset.delivery || "";
    renderList();
  });
});
$("itemSort").addEventListener("change", (e) => {
  view.sort = e.target.value;
  renderList();
});
for (const [id, key] of [
  ["floatMin", "floatMin"],
  ["floatMax", "floatMax"],
]) {
  $(id).addEventListener("input", (e) => {
    view[key] = e.target.value;
    renderList();
  });
}

// Перемикач мови веде на цей самий предмет, а не на порожню сторінку.
document.querySelectorAll(".lang-switch a").forEach((a) => {
  a.href = a.getAttribute("href").split("?")[0] + location.search;
});

load();
