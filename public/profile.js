// Сторінка профілю: хто ти, куди слати обмін, твої угоди і баланс.
//
// Раніше все це жило кружком у шапці: клік відкривав вікно з угодами, а
// посилання на обмін редагувалось на сторінці продажу, серед скінів. Тепер
// одна сторінка з вкладками, а на продажу лишились тільки скіни.
//
// Підписи беруться з window.ACCOUNT_CONFIG — той самий конфіг, що в кабінеті
// (кожна мовна версія сторінки задає свій перед підключенням цього файлу).
const T = window.ACCOUNT_CONFIG;

const loggedOutEl = document.getElementById("profileLoggedOut");
const profileCard = document.getElementById("profileCard");
const tradeUrlInput = document.getElementById("profileTradeUrl");
const tradeUrlStatus = document.getElementById("profileTradeUrlStatus");

function money(n) {
  return window.fmtPrice ? window.fmtPrice(n) : `$${(Number(n) || 0).toFixed(2)}`;
}

function esc(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Кнопки "Поповнити" / "Вивести" в шапці картки — це ті самі вкладки.
document.querySelectorAll("[data-goto]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = document.querySelector(`.profile-tab[data-tab="${btn.dataset.goto}"]`);
    if (!tab) return;
    tab.click();
    // Кнопка "Посилання на обмін" у бічній колонці веде одразу в поле.
    const field = btn.dataset.focus && document.getElementById(btn.dataset.focus);
    if (field) {
      field.scrollIntoView({ behavior: "smooth", block: "center" });
      field.focus({ preventScroll: true });
    } else {
      tab.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

// ---- Вкладки ----
document.querySelectorAll(".profile-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".profile-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".profile-pane").forEach((pane) => {
      pane.style.display = pane.dataset.pane === tab.dataset.tab ? "" : "none";
    });
    // Угоди тягнемо лише коли вкладку відкрили: більшість заходить подивитись
    // баланс, і зайвий запит на кожен вхід ні до чого.
    if (tab.dataset.tab === "deals") loadDeals();
  });
});

// ---- Хто ти і скільки в тебе ----
async function loadProfile() {
  let data;
  try {
    data = await (await fetch("/api/account/me")).json();
  } catch {
    data = { customer: null };
  }

  if (!data.customer) {
    loggedOutEl.style.display = "block";
    return;
  }

  const c = data.customer;
  // Пусто, а не "block": розкладку (дві колонки, grid) задає profile.css.
  profileCard.style.display = "";
  document.getElementById("profileAvatar").src = c.avatar || "";
  document.getElementById("profileName").textContent = c.displayName || "";
  document.getElementById("profileSteamId").textContent = c.steamId || "";
  document.getElementById("profileSteamLink").href = c.profileUrl || "#";
  tradeUrlInput.value = c.tradeUrl || "";

  // Валюту обирає сама людина перемикачем у шапці — показуємо в ній одній,
  // друге число поруч тільки заважало б читати.
  const b = data.balance || {};
  document.getElementById("balAvailable").textContent = money(b.available);
  document.getElementById("balHold").textContent = money(b.hold);
  document.getElementById("balTrade").textContent = money(b.trade);
  const rate = document.getElementById("balRate");
  if (rate && b.uahRate) rate.textContent = `1 $ = ${b.uahRate} ₴`;
  // Баланс у шапці картки профілю: головне число + холд і trade дрібно.
  const statHold = document.getElementById("statHold");
  if (statHold) statHold.textContent = money(b.hold);
  const headAvail = document.getElementById("headAvailable");
  if (headAvail) headAvail.textContent = money(b.available);
  const extra = document.getElementById("headExtra");
  if (extra) {
    const parts = [];
    if (b.hold) parts.push(`+${money(b.hold)} ${extra.dataset.hold || ""}`);
    if (b.trade) parts.push(`${money(b.trade)} ${extra.dataset.trade || ""}`);
    extra.textContent = parts.join(" · ");
  }

  loadStats();
}

// Статистика рахується з тих самих угод, що й список: окремого лічильника на
// сервері немає, та й не треба — угод у людини десятки, не тисячі.
async function loadStats() {
  let sales = [];
  try {
    const data = await (await fetch("/api/account/sales")).json();
    sales = (data.sales || []).filter((s) => !["cancelled", "reverted"].includes(s.status));
  } catch {
    return;
  }

  const skins = sales.reduce((sum, s) => sum + (s.items?.length || 0), 0);
  const earned = sales.reduce((sum, s) => sum + (Number(s.totalPrice) || 0), 0);
  document.getElementById("statDeals").textContent = String(sales.length);
  document.getElementById("statSkins").textContent = String(skins);
  document.getElementById("statEarned").textContent = money(earned);

  // Три останні угоди одразу на першій вкладці — як транзакції в кабінеті
  // маркетплейсу: зайшов і бачиш, що з твоїми продажами, без зайвого кліку.
  const recent = document.getElementById("profileRecent");
  const recentList = document.getElementById("profileRecentList");
  if (recent && recentList && sales.length && window.renderDealCard) {
    recentList.innerHTML = sales.slice(0, 3).map((sale) => window.renderDealCard(sale, T)).join("");
    window.wireDealButtons?.(recentList);
    recent.style.display = "";
  }
}

// ---- Угоди ----
let dealsLoaded = false;

async function loadDeals() {
  if (dealsLoaded) return;
  const loading = document.getElementById("profileDealsLoading");
  const empty = document.getElementById("profileDealsEmpty");
  const list = document.getElementById("profileDealsList");

  let sales = [];
  try {
    const data = await (await fetch("/api/account/sales")).json();
    // Скасовані угоди не показуємо: обмін не відбувся, грошей за ним немає.
    sales = (data.sales || []).filter((s) => !["cancelled", "reverted"].includes(s.status));
  } catch {
    sales = [];
  }

  loading.style.display = "none";
  dealsLoaded = true;
  if (!sales.length) {
    empty.style.display = "block";
    return;
  }

  list.innerHTML = sales.map((sale) => window.renderDealCard(sale, T)).join("");
  window.wireDealButtons(list);
}

// ---- Посилання на обмін ----
document.getElementById("profileTradeUrlSave")?.addEventListener("click", async () => {
  const tradeUrl = tradeUrlInput.value.trim();
  tradeUrlStatus.textContent = "";
  try {
    const res = await fetch("/api/account/trade-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeUrl }),
    });
    const data = await res.json();
    tradeUrlStatus.textContent = data.ok ? T.savedLabel : `${T.saveErrorPrefix}${data.error || ""}`;
  } catch (err) {
    tradeUrlStatus.textContent = `${T.saveErrorPrefix}${err.message}`;
  }
});

loadProfile();
