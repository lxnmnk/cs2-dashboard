// Права частина шапки: баланс клієнта і сам профіль.
//
// Баланс показуємо на всіх сторінках (елемент #navBalance), а профіль — лише
// там, де є #navProfile: у кабінеті замість нього стоїть accountPill зі своєю
// поведінкою (клік відкриває "Мої угоди", поруч вихід), тому дублювати його
// тут не треба. Тексти й мовні адреси задаються через window.NAV_CONFIG.
const NAV_T = window.NAV_CONFIG || {};
const navProfileEl = document.getElementById("navProfile");
const navBalanceEl = document.getElementById("navBalance");

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

fetch("/api/account/me")
  .then((r) => r.json())
  .then((data) => {
    if (navProfileEl) {
      navProfileEl.innerHTML = data.customer
        ? `<a class="nav-profile-user" href="${escapeHtml(NAV_T.accountUrl)}">
             <img src="${escapeHtml(data.customer.avatar || "")}" alt="" />
             <span>${escapeHtml(data.customer.displayName)}</span>
           </a>`
        : `<a class="btn-small" href="${escapeHtml(NAV_T.loginUrl)}">${escapeHtml(NAV_T.signInLabel)}</a>`;
    }

    // Баланс — це гроші за вже завершені продажі, які ми ще не виплатили.
    // Гривні рахує сервер за курсом з config.json, щоб не тримати його копію
    // в кожній мовній версії сторінки.
    if (navBalanceEl && data.customer && data.balance) {
      const { available, availableUah } = data.balance;
      navBalanceEl.innerHTML = `
        <a class="nav-balance" href="${escapeHtml(NAV_T.accountUrl)}" title="${escapeHtml(NAV_T.balanceTitle || "")}">
          <span class="nav-balance-usd">$${available.toFixed(2)}</span>
          <span class="nav-balance-uah">${availableUah} ₴</span>
        </a>`;
    }
  })
  // Шапка не має ламатись через неможливість дізнатись профіль чи баланс —
  // у найгіршому випадку її права частина просто лишиться порожньою.
  .catch(() => {});
