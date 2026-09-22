// Модалка "Мої угоди" — клієнт натискає на свій профіль у правому верхньому
// куті і бачить усі свої автоматичні продажі через Skinbux: статус обміну,
// коли розблокуються гроші (7 днів після прийняття обміну — термін Steam
// trade lock, та сама обіцянка "Оплата через 7 днів", що на sell-quote), і
// кнопку "Написати в Telegram", яка з'являється лише коли гроші вже вільні.
// Локалізація — через window.ACCOUNT_CONFIG (див. account-inventory.js).
const TELEGRAM_USERNAME = "lxnmnk";

const {
  dateLocale,
  statusLabels,
  holdUntilPrefix,
  holdLabel,
  paidLabel,
  unlockedStatus,
  telegramWithdrawBtn,
  telegramMessageTemplate,
  dealLineTemplate,
  openOfferBtn,
} = window.ACCOUNT_CONFIG;

const accountPillBtn = document.getElementById("accountPillBtn");
const dealsModal = document.getElementById("dealsModal");
const dealsModalClose = document.getElementById("dealsModalClose");
const dealsProfileLink = document.getElementById("dealsProfileLink");
const dealsLoading = document.getElementById("dealsLoading");
const dealsEmpty = document.getElementById("dealsEmpty");
const dealsList = document.getElementById("dealsList");

accountPillBtn?.addEventListener("click", () => {
  dealsProfileLink.href = window.ACCOUNT_CUSTOMER?.profileUrl || "#";
  dealsModal.style.display = "flex";
  loadDeals();
});

// Закривається лише хрестиком — клік повз вікно його не ховає, щоб список
// угод не зникав від випадкового промаху.
dealsModalClose?.addEventListener("click", closeDealsModal);

function closeDealsModal() {
  dealsModal.style.display = "none";
}

async function loadDeals() {
  dealsLoading.style.display = "block";
  dealsEmpty.style.display = "none";
  dealsList.innerHTML = "";

  let data;
  try {
    const res = await fetch("/api/account/sales");
    data = await res.json();
  } catch {
    data = { ok: false };
  }

  dealsLoading.style.display = "none";

  // Скасовані угоди клієнту не показуємо: обмін не відбувся, грошей за ним
  // немає, і в списку вони тільки заплутують.
  const sales = (data.sales || []).filter((s) => !["cancelled", "reverted"].includes(s.status));

  if (!data.ok || !sales.length) {
    dealsEmpty.style.display = "block";
    return;
  }

  dealsList.innerHTML = sales.map(renderDeal).join("");

  dealsList.querySelectorAll("[data-telegram]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.open(btn.getAttribute("data-telegram"), "_blank");
    });
  });
}

function renderDeal(sale) {
  const itemsLabel = sale.items.map((it) => escapeHtml(it.name)).join(", ");
  const date = new Date(sale.createdAt).toLocaleDateString(dateLocale);

  // Статуси беремо як є від Skinbux: "hold" — обмін прийнято, гроші
  // заморожені на 7 днів; "completed" — вже розморожені й доступні до виплати.
  // Сторона клієнта в обміні (kind "trade") живе за іншими правилами: гроші
  // не виводяться, а лежать trade-балансом і витрачаються на наші скіни. Холд
  // на них чекаємо ми, тому клієнту тут ні дат холду, ні кнопки виводу —
  // тільки "можна забирати скіни". "Виплачено" в обміні означає, що скіни
  // віддані.
  const T = window.ACCOUNT_CONFIG;
  let statusHtml;
  if (sale.kind === "trade" && (sale.status === "hold" || sale.status === "completed")) {
    statusHtml = sale.paidAt
      ? `<p class="deal-status">${escapeHtml(T.tradeDealDone)}</p>`
      : `<p class="deal-status deal-status-unlocked">${escapeHtml(T.tradeDealStatus)}</p>
         <a class="btn-small" href="${escapeHtml(T.tradeUrl || "/trade")}">${escapeHtml(T.tradeDealBtn)}</a>`;
  } else if (sale.paidAt) {
    // Гроші за угоду вже переказані — кнопку виводу не показуємо, інакше
    // клієнт попросить виплату вдруге за те саме.
    statusHtml = `<p class="deal-status">${escapeHtml(paidLabel)}</p>`;
  } else if (sale.status === "completed") {
    const message = format(telegramMessageTemplate, { id: sale.id, amount: sale.totalPrice.toFixed(2) });
    const link = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(message)}`;
    statusHtml = `
      <p class="deal-status deal-status-unlocked">${escapeHtml(unlockedStatus)}</p>
      <button class="btn-small" type="button" data-telegram="${escapeHtml(link)}">${escapeHtml(telegramWithdrawBtn)}</button>`;
  } else if (sale.status === "hold") {
    const untilDate = sale.unlockAt ? new Date(sale.unlockAt).toLocaleDateString(dateLocale) : null;
    statusHtml = `<p class="deal-status">${escapeHtml(untilDate ? holdUntilPrefix + untilDate : holdLabel)}</p>`;
  } else {
    // Угода ще чекає прийняття — показуємо пряме посилання на обмін, щоб
    // клієнт знайшов його й після того, як закрив вікно продажу.
    const offerLink = sale.offerId
      ? `<a class="deal-offer-link" href="https://steamcommunity.com/tradeoffer/${escapeHtml(
          String(sale.offerId)
        )}/" target="_blank">${escapeHtml(openOfferBtn)} →</a>`
      : "";
    statusHtml = `<p class="deal-status">${escapeHtml(statusLabels[sale.status] || sale.status)}</p>${offerLink}`;
  }

  return `
    <div class="deal-card">
      <div class="deal-card-head">
        <span class="deal-items">${itemsLabel}</span>
        <span class="deal-price">$${sale.totalPrice.toFixed(2)}</span>
      </div>
      <p class="card-hint">${escapeHtml(format(dealLineTemplate, { id: sale.id, date }))}</p>
      ${statusHtml}
    </div>`;
}

function format(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
