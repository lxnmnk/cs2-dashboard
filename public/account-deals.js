// Модалка "Мої угоди" — клієнт натискає на свій профіль у правому верхньому
// куті і бачить усі свої автоматичні продажі через Skinbux: статус обміну,
// коли розблокуються гроші (7 днів після прийняття обміну — термін Steam
// trade lock, та сама обіцянка "Оплата через 7 днів", що на sell-quote), і
// кнопку "Написати в Telegram", яка з'являється лише коли гроші вже вільні.
// Локалізація — через window.ACCOUNT_CONFIG (див. account-inventory.js).
// Сама картка угоди малюється спільною функцією (deal-card.js) — її ж
// використовує сторінка профілю, щоб статуси в двох місцях не розійшлись.

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

  dealsList.innerHTML = sales.map((sale) => window.renderDealCard(sale, window.ACCOUNT_CONFIG)).join("");
  window.wireDealButtons(dealsList);
}
