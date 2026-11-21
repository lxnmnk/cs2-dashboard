// Вкладки профілю "Покупки" і "Поповнити".
//
// Покупки — скіни з вітрини /buy: статус трейду простими словами. Якщо трейд
// скасували (клієнт відхилив у Steam, продавець не віддав), гроші самі
// повертаються на баланс — це й пишемо, щоб людина не гадала, де її гроші.
//
// Поповнити — USDT на нашу депозитну адресу. Сайт видає рахунок з точною
// сумою (унікальні центи — по них ми впізнаємо переказ), людина надсилає
// рівно стільки, сервер бачить переказ у мережі й зараховує на trade-баланс.
// Підписи — window.WALLET_CONFIG (кожна мовна версія профілю задає свій).
const W = window.WALLET_CONFIG;

const $w = (id) => document.getElementById(id);

function wMoney(n) {
  return window.fmtPrice ? window.fmtPrice(n) : `$${(Number(n) || 0).toFixed(2)}`;
}

function wEsc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function wDate(iso) {
  try {
    return new Date(iso).toLocaleString(document.documentElement.lang || undefined, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// ---- Покупки ----
// status сервера -> [клас картки, текст плашки, пояснення]
function purchaseState(p) {
  const instant = p.delivery === "instant";
  // Наш скін: трейд шле власник сам — pending (готуємо), sent (надіслали).
  if (p.own && p.status === "pending") {
    return p.locked
      ? ["is-hold", W.stOwnLocked, W.hintOwnLocked.replace("{date}", wDate(p.unlockAt))]
      : ["is-ready", W.stOwnPending, W.hintOwnPending];
  }
  if (p.own && p.status === "sent") return ["is-ready", W.stOwnSent, W.hintOwnSent];
  switch (p.status) {
    case "completed":
      return ["is-done", W.stDone, W.hintDone];
    case "refunded":
      return ["is-cancel", W.stRefunded, W.hintRefunded.replace("{price}", wMoney(p.price))];
    case "failed":
      return ["is-cancel", W.stFailed, W.hintFailed];
    case "mixed":
      return ["is-hold", W.stChecking, W.hintChecking];
    case "unknown":
      return ["is-hold", W.stChecking, W.hintUnknown];
    default:
      return ["is-ready", W.stWaiting, instant ? W.hintWaitInstant : W.hintWaitP2p];
  }
}

let purchasesLoaded = false;
async function loadPurchases(force) {
  if (purchasesLoaded && !force) return;
  const list = $w("purchasesList");
  const empty = $w("purchasesEmpty");
  $w("purchasesLoading").style.display = "block";
  let data;
  try {
    data = await (await fetch("/api/account/market/purchases")).json();
  } catch {
    data = { ok: false };
  }
  $w("purchasesLoading").style.display = "none";
  purchasesLoaded = true;
  const items = data.purchases || [];
  empty.style.display = items.length ? "none" : "block";
  list.innerHTML = items
    .map((p) => {
      const [cls, pill, hint] = purchaseState(p);
      // Кнопка "Трейди Steam" — коли трейд уже є або от-от буде; наш скін у
      // стані "готуємо" ще без трейду.
      const waiting = cls === "is-ready" && !(p.own && p.status === "pending");
      return `
      <div class="deal-card ${cls}">
        <div class="deal-card-main">
          <div class="deal-items"><span class="deal-item">${wEsc(p.name)}</span></div>
          <div class="deal-meta">
            <span class="deal-pill ${cls}">${wEsc(pill)}</span>
            <span class="delivery-tag ${p.delivery}"><span class="delivery-dot ${p.delivery}"></span>${p.delivery === "instant" ? "Instant" : "P2P"}</span>
            ${p.float != null ? `<span class="card-hint">Float ${Number(p.float).toFixed(6)}</span>` : ""}
            <span class="card-hint">${wEsc(wDate(p.createdAt))}</span>
          </div>
          <p class="card-hint deal-hint">${wEsc(hint)}</p>
        </div>
        <div class="deal-card-side">
          <span class="deal-price${cls === "is-cancel" ? " is-struck" : ""}">${wMoney(p.price)}</span>
          ${waiting ? `<a class="btn-small" href="https://steamcommunity.com/my/tradeoffers" target="_blank">${wEsc(W.openTrades)}</a>` : ""}
        </div>
      </div>`;
    })
    .join("");
  // Поки є покупки в дорозі — оновлюємо самі: людина чекає саме на це.
  clearTimeout(loadPurchases.timer);
  if (items.some((p) => ["pending", "sent", "unknown", "mixed"].includes(p.status))) {
    loadPurchases.timer = setTimeout(() => loadPurchases(true), 30000);
  }
}

// ---- Поповнення ----
let topup = null; // відповідь /api/account/topup
let network = null;

async function loadTopup() {
  let data;
  try {
    data = await (await fetch("/api/account/topup")).json();
  } catch {
    data = { ok: false };
  }
  topup = data.ok ? data : null;
  renderTopup();
  autoInvoiceForNeed();
}

// Прийшли зі сторінки скіна, де не вистачило грошей: рахунок на нестачу
// створюємо одразу, без кнопки "Отримати адресу" — людина бачить адресу й
// суму з першого екрана. Один раз за візит; хочеш іншу суму чи мережу —
// "Інша сума" відкриває форму.
let autoInvoiceDone = false;
async function autoInvoiceForNeed() {
  if (autoInvoiceDone || NEED == null || !topup?.networks?.length) return;
  autoInvoiceDone = true;
  const now = Date.now();
  if (topup.invoices.some((i) => i.status === "waiting" && i.network === network && new Date(i.expiresAt) > now)) return;
  const fee = topup.networks.find((n) => n.id === network)?.feeUsd || 0;
  // Нестача більша за максимум одного рахунку — сам рахунок не створюємо
  // (вийшов би рахунок на максимум, який усе одно не покриває покупку):
  // показуємо форму з поясненням "поповни частинами".
  if (NEED + fee > topup.maxUsd) return;
  await createInvoice(parseFloat(suggestedAmount(fee)));
  // Сума вже використана — прибираємо її з адреси, щоб оновлення сторінки
  // не створило ще один рахунок.
  setUrlTab("topup");
}

// Адреса сторінки = відкрита вкладка, без службових хвостів (need=…):
// посилання можна скопіювати, а оновлення не повторює дію.
function setUrlTab(name) {
  try {
    const url = new URL(location.href);
    url.search = name && name !== "info" ? `?tab=${encodeURIComponent(name)}` : "";
    history.replaceState(null, "", url);
  } catch {
    // старий браузер — адреса просто не зміниться
  }
}

function netLabel(id) {
  return id === "trc20" ? "TRC-20 (Tron)" : "ERC-20 (Ethereum)";
}

function renderTopup() {
  const root = $w("topupRoot");
  if (!topup) {
    root.innerHTML = `<p class="card-hint">${wEsc(W.loadError)}</p>`;
    return;
  }
  if (!topup.networks.length) {
    root.innerHTML = `<p class="card-hint">${wEsc(W.unavailable)}</p>`;
    return;
  }
  if (!network || !topup.networks.some((n) => n.id === network)) network = topup.networks[0].id;
  const now = Date.now();
  const active = topup.invoices.find((i) => i.status === "waiting" && i.network === network && new Date(i.expiresAt) > now);

  root.innerHTML = `
    <p class="card-hint">${wEsc(W.intro)}</p>
    <div class="delivery-switch topup-networks" role="group">
      ${topup.networks
        .map((n) => `<button class="delivery-btn${n.id === network ? " active" : ""}" type="button" data-network="${n.id}">USDT ${n.id === "trc20" ? "TRC-20" : "ERC-20"}</button>`)
        .join("")}
    </div>
    ${active ? invoiceHtml(active) : formHtml()}
    <h4 class="topup-history-title">${wEsc(W.historyTitle)}</h4>
    <div class="deals-list">${historyHtml()}</div>`;

  root.querySelectorAll("[data-network]").forEach((b) =>
    b.addEventListener("click", () => {
      network = b.dataset.network;
      renderTopup();
    })
  );
  root.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = W.copied;
        setTimeout(() => (b.textContent = W.copy), 1500);
      } catch {
        // старий браузер — людина скопіює руками
      }
    })
  );
  $w("topupCreate")?.addEventListener("click", createInvoice);
  $w("topupNew")?.addEventListener("click", () => {
    // Новий рахунок замінює старий на сервері; тут просто показуємо форму.
    topup.invoices = topup.invoices.map((i) => (i.id === active?.id ? { ...i, status: "replaced" } : i));
    renderTopup();
  });
}

// Прийшли зі сторінки скіна, де не вистачило грошей (?need=3.20): одразу
// підставляємо суму, після зарахування якої вистачить — нестача плюс комісія
// мережі, вгору до долара, і не менше мінімуму.
const NEED = (() => {
  const n = parseFloat(new URLSearchParams(location.search).get("need"));
  return Number.isFinite(n) && n > 0 ? n : null;
})();

function suggestedAmount(fee) {
  if (NEED == null) return "";
  return String(Math.min(topup.maxUsd, Math.max(topup.minUsd, Math.ceil(NEED + fee))));
}

function formHtml() {
  const fee = topup.networks.find((n) => n.id === network)?.feeUsd || 0;
  const suggested = suggestedAmount(fee);
  return `
    ${
      NEED != null
        ? `<p class="topup-need">${wEsc(
            NEED + fee > topup.maxUsd
              ? W.needTooBig.replace("{need}", wMoney(NEED)).replace("{max}", wMoney(topup.maxUsd))
              : W.needNote.replace("{need}", wMoney(NEED))
          )}</p>`
        : ""
    }
    <div class="topup-form">
      <label class="topup-label">${wEsc(W.amountLabel)}
        <input id="topupAmount" class="item-float-input topup-amount" type="number" min="${topup.minUsd}" max="${topup.maxUsd}" step="1" placeholder="${topup.minUsd}" value="${suggested}" />
      </label>
      <button id="topupCreate" class="btn-gold" type="button">${wEsc(W.createBtn)}</button>
    </div>
    <p class="card-hint">${wEsc(W.minNote.replace("{min}", "$" + topup.minUsd).replace("{fee}", "$" + Number(fee).toFixed(2)))}</p>
    <p id="topupError" class="buy-err"></p>`;
}

function invoiceHtml(inv) {
  const left = Math.max(0, Math.round((new Date(inv.expiresAt) - Date.now()) / 60000));
  return `
    <div class="topup-invoice">
      <div class="topup-qr" title="${wEsc(inv.address)}">${qrSvg(inv.address)}</div>
      <div class="topup-row">
        <span class="topup-row-label">${wEsc(W.sendExactly)}</span>
        <span class="topup-amount-big">${inv.amount.toFixed(2)} USDT</span>
        <button class="btn-small" type="button" data-copy="${inv.amount.toFixed(2)}">${wEsc(W.copy)}</button>
      </div>
      <div class="topup-row">
        <span class="topup-row-label">${wEsc(W.toAddress.replace("{net}", netLabel(inv.network)))}</span>
        <code class="topup-address">${wEsc(inv.address)}</code>
        <button class="btn-small" type="button" data-copy="${wEsc(inv.address)}">${wEsc(W.copy)}</button>
      </div>
      <ul class="buy-notes">
        <li><b>${wEsc(W.warnExact.replace("{amount}", inv.amount.toFixed(2)))}</b></li>
        <li>${wEsc(W.warnNetwork.replace("{net}", netLabel(inv.network)))}</li>
        <li>${wEsc(W.warnFee)}</li>
        <li>${wEsc(W.warnTime.replace("{min}", left))}</li>
      </ul>
      <p class="card-hint topup-waiting">⏳ ${wEsc(W.waiting)}</p>
      <button id="topupNew" class="btn-clear" type="button">${wEsc(W.newInvoice)}</button>
    </div>`;
}

// QR з самою адресою: його розуміють і гаманці, і біржі. Суму в QR не
// кладемо — формати з сумою (EIP-681, tron:) кожен гаманець читає по-своєму,
// а помилка в сумі тут коштує зарахування. Бібліотека — /qrcode.js.
function qrSvg(text) {
  if (typeof window.qrcode !== "function") return "";
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    return "";
  }
}

function historyHtml() {
  const rows = topup.invoices.filter((i) => i.status !== "replaced");
  if (!rows.length) return `<p class="card-hint">${wEsc(W.historyEmpty)}</p>`;
  return rows
    .map((i) => {
      const st =
        i.status === "credited"
          ? ["is-done", W.tCredited.replace("{sum}", wMoney(i.credited))]
          : i.status === "waiting"
          ? ["is-ready", W.tWaiting]
          : ["is-cancel", W.tExpired];
      return `
      <div class="deal-card ${st[0]}">
        <div class="deal-card-main">
          <div class="deal-items"><span class="deal-item">${i.amount.toFixed(2)} USDT · ${wEsc(netLabel(i.network))}</span></div>
          <div class="deal-meta">
            <span class="deal-pill ${st[0]}">${wEsc(st[1])}</span>
            <span class="card-hint">${wEsc(wDate(i.creditedAt || i.createdAt))}</span>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

async function createInvoice(amountOverride) {
  const amount = Number.isFinite(amountOverride) ? amountOverride : parseFloat($w("topupAmount")?.value);
  const err = $w("topupError") || { textContent: "" };
  err.textContent = "";
  if (!(amount >= topup.minUsd && amount <= topup.maxUsd)) {
    err.textContent = W.errAmount.replace("{min}", "$" + topup.minUsd).replace("{max}", "$" + topup.maxUsd);
    return;
  }
  const btn = $w("topupCreate") || {};
  btn.disabled = true;
  let data;
  try {
    data = await (
      await fetch("/api/account/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network, amount }),
      })
    ).json();
  } catch {
    data = { ok: false };
  }
  btn.disabled = false;
  if (!data.ok) {
    err.textContent = data.error === "BAD_AMOUNT" ? W.errAmount.replace("{min}", "$" + topup.minUsd).replace("{max}", "$" + topup.maxUsd) : W.errGeneric;
    return;
  }
  await loadTopup();
}

// Поки є відкритий рахунок — раз на 20 с перевіряємо, чи не зарахувалось.
setInterval(() => {
  const pane = document.querySelector('.profile-pane[data-pane="topup"]');
  if (!topup || !pane || pane.style.display === "none") return;
  if (topup.invoices.some((i) => i.status === "waiting")) {
    const before = topup.invoices.filter((i) => i.status === "credited").length;
    loadTopup().then(() => {
      if (topup && topup.invoices.filter((i) => i.status === "credited").length > before && window.refreshNavBalance) window.refreshNavBalance();
    });
  }
}, 20000);

// ---- Вивід у крипті (вкладка "Баланс") ----
// Гроші йдуть одразу на гаманець клієнта; сума списується з "доступно до
// виплати". Комісію мережі платить клієнт — показуємо, скільки дійде.
let wd = null;
let wdNetwork = null;

async function loadWithdraw() {
  const root = $w("withdrawRoot");
  if (!root) return;
  try {
    wd = await (await fetch("/api/account/withdraw")).json();
  } catch {
    wd = null;
  }
  renderWithdraw();
}

function wdStatus(st) {
  if (st === "paid") return ["is-done", W.wdPaid];
  if (st === "failed" || st === "rejected") return ["is-cancel", W.wdFailed];
  return ["is-ready", W.wdPending];
}

function renderWithdraw() {
  const root = $w("withdrawRoot");
  if (!wd?.ok || !wd.enabled) {
    // Вивід кнопкою вимкнено (Skinbux не дозволяє виводити клієнтам напряму):
    // платимо вручну, але людина з грошима на балансі має знати, як їх отримати.
    root.innerHTML =
      wd?.ok && wd.available > 0 && W.wdManual
        ? `<h3 class="panel-title">${wEsc(W.wdTitle)}</h3><p class="card-hint">${wEsc(W.wdManual)}</p>`
        : "";
    return;
  }
  if (!wdNetwork) wdNetwork = wd.last?.network && wd.networks.some((n) => n.id === wd.last.network) ? wd.last.network : wd.networks[0].id;
  const net = wd.networks.find((n) => n.id === wdNetwork);
  const prevAddress = $w("wdAddress")?.value;
  const prevAmount = $w("wdAmount")?.value;
  const address = prevAddress ?? (wd.last && wd.last.network === wdNetwork ? wd.last.address : "");
  root.innerHTML = `
    <h3 class="panel-title">${wEsc(W.wdTitle)}</h3>
    <p class="card-hint">${wEsc(W.wdIntro.replace("{available}", wMoney(wd.available)))}</p>
    <p class="wd-min-note">${wEsc(W.wdMinNote.replace("{min}", wMoney(wd.minUsd)))}</p>
    <div class="delivery-switch topup-networks" role="group">
      ${wd.networks.map((n) => `<button class="delivery-btn${n.id === wdNetwork ? " active" : ""}" type="button" data-wdnet="${n.id}">${wEsc(n.label)}</button>`).join("")}
    </div>
    <div class="topup-form wd-form">
      <label class="topup-label wd-address">${wEsc(W.wdAddress)}
        <input id="wdAddress" class="item-float-input" type="text" autocomplete="off" spellcheck="false" value="${wEsc(address)}" placeholder="${wdNetwork.endsWith("trc20") ? "T…" : "0x…"}" />
      </label>
      <label class="topup-label">${wEsc(W.wdAmount)}
        <span class="wd-amount-row">
          <input id="wdAmount" class="item-float-input topup-amount" type="number" min="0" step="0.01" value="${wEsc(prevAmount ?? "")}" />
          <button id="wdAll" class="btn-outline" type="button">${wEsc(W.wdAll)}</button>
        </span>
      </label>
      <button id="wdSubmit" class="btn-gold" type="button">${wEsc(W.wdSubmit)}</button>
    </div>
    <p id="wdReceive" class="card-hint"></p>
    <p id="wdError" class="buy-err"></p>
    ${
      wd.withdrawals.length
        ? `<div class="deals-list">${wd.withdrawals
            .map((w) => {
              const [cls, label] = wdStatus(w.status);
              return `<div class="deal-card ${cls}"><div class="deal-card-main">
                <div class="deal-items"><span class="deal-item">${wMoney(w.send)} · ${wEsc(wd.networks.find((n) => n.id === w.network)?.label || w.network)}</span></div>
                <div class="deal-meta"><span class="deal-pill ${cls}">${wEsc(label)}</span><span class="card-hint">${wEsc(w.address.slice(0, 8))}…${wEsc(w.address.slice(-6))}</span><span class="card-hint">${wEsc(wDate(w.createdAt))}</span></div>
              </div></div>`;
            })
            .join("")}</div>`
        : ""
    }`;

  const showReceive = () => {
    const a = parseFloat($w("wdAmount").value);
    $w("wdReceive").textContent = Number.isFinite(a) && a > 0 ? W.wdReceive.replace("{sum}", wMoney(Math.max(0, a - net.fee))).replace("{fee}", wMoney(net.fee)) : W.wdFeeNote.replace("{fee}", wMoney(net.fee));
  };
  showReceive();
  $w("wdAmount").addEventListener("input", showReceive);
  $w("wdAll").addEventListener("click", () => {
    $w("wdAmount").value = Math.floor(wd.available * 100) / 100;
    showReceive();
  });
  root.querySelectorAll("[data-wdnet]").forEach((b) =>
    b.addEventListener("click", () => {
      wdNetwork = b.dataset.wdnet;
      // Адреса іншої мережі не підходить — очищаємо, якщо формат інший.
      const keep = $w("wdAddress").value;
      renderWithdraw();
      const ok = wdNetwork.endsWith("trc20") ? /^T/.test(keep) : /^0x/i.test(keep);
      $w("wdAddress").value = ok ? keep : wd.last && wd.last.network === wdNetwork ? wd.last.address : "";
    })
  );
  $w("wdSubmit").addEventListener("click", submitWithdraw);
}

// Підтвердження виводу — власне вікно в стилі сайту, а не системний
// confirm() браузера: там адреса губилась у рядку тексту, а кнопки
// "OK / Скасувати" виглядали як помилка. Адресу показуємо повністю й
// окремим блоком — саме її людина має звірити.
function confirmWithdraw({ send, fee, label, address }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay wd-confirm";
    overlay.style.display = "flex";
    overlay.innerHTML = `
      <div class="modal-panel" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3>${wEsc(W.wdConfirmTitle)}</h3>
          <button class="modal-close" type="button" data-wd="no">&#10005;</button>
        </div>
        <div class="wd-confirm-sum">${wMoney(send)}</div>
        <div class="wd-confirm-row"><span>${wEsc(W.wdConfirmNet)}</span><span>${wEsc(label)}</span></div>
        <div class="wd-confirm-row"><span>${wEsc(W.wdConfirmFee)}</span><span>${wMoney(fee)}</span></div>
        <div class="wd-confirm-label">${wEsc(W.wdConfirmAddr)}</div>
        <code class="topup-address wd-confirm-address">${wEsc(address)}</code>
        <p class="wd-confirm-warn">⚠️ ${wEsc(W.wdConfirmWarn)}</p>
        <div class="buy-actions">
          <button class="btn-gold" type="button" data-wd="yes">${wEsc(W.wdConfirmOk.replace("{sum}", wMoney(send)))}</button>
          <button class="btn-outline" type="button" data-wd="no">${wEsc(W.wdCancel)}</button>
        </div>
      </div>`;
    const close = (answer) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };
    overlay.addEventListener("click", (e) => {
      const b = e.target.closest("[data-wd]");
      if (b) close(b.dataset.wd === "yes");
      else if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-wd="yes"]').focus();
  });
}

async function submitWithdraw() {
  const amount = parseFloat($w("wdAmount").value);
  const address = $w("wdAddress").value.trim();
  const err = $w("wdError");
  err.textContent = "";
  const net = wd.networks.find((n) => n.id === wdNetwork);
  if (!address) return (err.textContent = W.wdNeedAddress);
  if (!(amount >= wd.minUsd)) return (err.textContent = W.wdMin.replace("{min}", wMoney(wd.minUsd)));
  if (amount > wd.available + 0.001) return (err.textContent = W.wdNoMoney.replace("{available}", wMoney(wd.available)));
  if (!(await confirmWithdraw({ send: amount - net.fee, fee: net.fee, label: net.label, address }))) return;
  const btn = $w("wdSubmit");
  btn.disabled = true;
  btn.textContent = W.wdSending;
  let data;
  try {
    data = await (
      await fetch("/api/account/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: wdNetwork, address, amount }),
      })
    ).json();
  } catch {
    data = { ok: false };
  }
  if (window.refreshNavBalance) window.refreshNavBalance();
  if (!data.ok) {
    btn.disabled = false;
    btn.textContent = W.wdSubmit;
    err.textContent =
      {
        BAD_ADDRESS: data.message || W.wdBadAddress,
        BAD_AMOUNT: W.wdMin.replace("{min}", wMoney(data.min || 0)),
        INSUFFICIENT_BALANCE: W.wdNoMoney.replace("{available}", wMoney(data.available ?? wd.available)),
        SHOP_UNAVAILABLE: W.wdUnavailable,
        DISABLED: W.wdUnavailable,
      }[data.error] || W.wdError;
    return;
  }
  $w("wdAmount").value = "";
  await loadWithdraw();
  $w("wdError").className = "buy-ok";
  $w("wdError").textContent = `✅ ${W.wdDone}`;
}

// ---- Вкладки ----
function openWalletTab(name) {
  if (name === "purchases") loadPurchases();
  if (name === "topup") loadTopup();
  if (name === "balance") loadWithdraw();
}
let urlTabReady = false; // перший клік — із openFromUrl: адресу ще не чіпаємо
document.querySelectorAll(".profile-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    openWalletTab(tab.dataset.tab);
    if (urlTabReady) setUrlTab(tab.dataset.tab);
  });
});
// /profile?tab=topup — з вікна покупки ("не вистачає грошей") і після покупки.
(function openFromUrl() {
  const want = new URLSearchParams(location.search).get("tab");
  if (!want) return;
  const tab = document.querySelector(`.profile-tab[data-tab="${want}"]`);
  if (tab) tab.click();
})();
urlTabReady = true;
