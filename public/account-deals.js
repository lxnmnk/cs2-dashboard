// Модалка "Мої угоди" — клієнт натискає на свій профіль у правому верхньому
// куті і бачить усі свої автоматичні продажі через Skinbux: статус обміну,
// коли розблокуються гроші (7 днів після прийняття обміну — термін Steam
// trade lock, та сама обіцянка "Оплата через 7 днів", що на sell-quote), і
// кнопку "Написати в Telegram", яка з'являється лише коли гроші вже вільні.
const TELEGRAM_USERNAME = "lxnmnk";

const accountPillBtn = document.getElementById("accountPillBtn");
const dealsModal = document.getElementById("dealsModal");
const dealsModalClose = document.getElementById("dealsModalClose");
const dealsProfileLink = document.getElementById("dealsProfileLink");
const dealsLoading = document.getElementById("dealsLoading");
const dealsEmpty = document.getElementById("dealsEmpty");
const dealsList = document.getElementById("dealsList");

const STATUS_LABELS = {
  created: "Очікує прийняття обміну в Steam",
  pending: "Очікує прийняття обміну в Steam",
  hold: "На перевірці у Skinbux",
  completed: "Обмін завершено",
  cancelled: "Скасовано",
  reverted: "Скасовано (повернення)",
};

accountPillBtn?.addEventListener("click", () => {
  dealsProfileLink.href = window.ACCOUNT_CUSTOMER?.profileUrl || "#";
  dealsModal.style.display = "flex";
  loadDeals();
});

dealsModalClose?.addEventListener("click", closeDealsModal);
dealsModal?.addEventListener("click", (e) => {
  if (e.target === dealsModal) closeDealsModal();
});

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

  if (!data.ok || !data.sales.length) {
    dealsEmpty.style.display = "block";
    return;
  }

  dealsList.innerHTML = data.sales.map(renderDeal).join("");

  dealsList.querySelectorAll("[data-telegram]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.open(btn.getAttribute("data-telegram"), "_blank");
    });
  });
}

function renderDeal(sale) {
  const itemsLabel = sale.items.map((it) => escapeHtml(it.name)).join(", ");
  const date = new Date(sale.createdAt).toLocaleDateString("uk-UA");

  let statusHtml;
  if (sale.status === "completed" && sale.unlockAt) {
    if (sale.unlocked) {
      const message = `Привіт! Хочу вивести кошти за угоду #${sale.id} на суму $${sale.totalPrice.toFixed(2)}.`;
      const link = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(message)}`;
      statusHtml = `
        <p class="deal-status deal-status-unlocked">✓ Кошти розблоковано, можна вивести</p>
        <button class="btn-small" type="button" data-telegram="${escapeHtml(link)}">Написати в Telegram для виводу</button>`;
    } else {
      const unlockDate = new Date(sale.unlockAt).toLocaleDateString("uk-UA");
      statusHtml = `<p class="deal-status">Кошти в холді до ${unlockDate}</p>`;
    }
  } else {
    statusHtml = `<p class="deal-status">${escapeHtml(STATUS_LABELS[sale.status] || sale.status)}</p>`;
  }

  return `
    <div class="deal-card">
      <div class="deal-card-head">
        <span class="deal-items">${itemsLabel}</span>
        <span class="deal-price">$${sale.totalPrice.toFixed(2)}</span>
      </div>
      <p class="card-hint">Угода #${sale.id} від ${date}</p>
      ${statusHtml}
    </div>`;
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
