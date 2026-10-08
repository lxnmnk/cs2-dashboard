// Права частина шапки: баланс клієнта і сам профіль.
//
// Баланс показуємо на всіх сторінках (елемент #navBalance), а профіль — лише
// там, де є #navProfile: у кабінеті замість нього стоїть accountPill зі своєю
// поведінкою (клік відкриває "Мої угоди", поруч вихід), тому дублювати його
// тут не треба. Тексти й мовні адреси задаються через window.NAV_CONFIG.
const NAV_T = window.NAV_CONFIG || {};
const navProfileEl = document.getElementById("navProfile");
const navBalanceEl = document.getElementById("navBalance");

// Підписи, які зʼявились після того, як NAV_CONFIG уже стояв на десятку
// сторінок у трьох мовах: сторінка може їх не задавати, тоді беремо переклад
// за мовою самої сторінки, а не лишаємо порожній підпис.
const NAV_FALLBACKS = {
  tradeTitle: {
    uk: "Trade-баланс: можна витратити на наші скіни просто зараз",
    ru: "Trade-баланс: можно потратить на наши скины прямо сейчас",
    en: "Trade balance: spend it on our skins right now",
  },
};

function navText(key) {
  if (NAV_T[key]) return NAV_T[key];
  const lang = (document.documentElement.lang || "uk").slice(0, 2);
  const byLang = NAV_FALLBACKS[key] || {};
  return byLang[lang] || byLang.uk || "";
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Викликається й ззовні (account-inventory.js), коли після продажу гроші
// лягли в холд — щоб шапка не показувала старий баланс до перезавантаження.
function refreshNavBalance() {
  return fetch("/api/account/me")
    .then((r) => r.json())
    .then((data) => {
      if (navProfileEl) {
        navProfileEl.innerHTML = data.customer
          // Аватар веде у профіль: там і угоди, і баланс, і посилання на
          // обмін. Адреса — з accountUrl тієї ж мовної версії.
          ? `<a class="nav-profile-user" href="${escapeHtml((NAV_T.accountUrl || "/account").replace("/account", "/profile"))}">
               <img src="${escapeHtml(data.customer.avatar || "")}" alt="" />
               <span>${escapeHtml(data.customer.displayName)}</span>
             </a>`
          : `<a class="btn-small" href="${escapeHtml(NAV_T.loginUrl)}">${escapeHtml(NAV_T.signInLabel)}</a>`;
      }

      // Баланс — це гроші за вже завершені продажі, які ми ще не виплатили.
      // Гривні рахує сервер за курсом з config.json, щоб не тримати його копію
      // в кожній мовній версії сторінки.
      if (navBalanceEl && data.customer && data.balance) {
        const { available, availableUah, hold, holdUah, trade, tradeUah } = data.balance;
        // Гроші в холді показуємо окремим рядком: без цього клієнт після
        // успішного продажу бачив у шапці $0.00 і не розумів, чи все дійшло.
        const holdLine = hold
          ? `<span class="nav-balance-hold" title="${escapeHtml(NAV_T.holdTitle || "")}">+$${hold.toFixed(
              2
            )} · ${holdUah} ₴</span>`
          : "";
        // Trade-баланс — гроші за сторону клієнта в обміні. Витрачаються лише
        // на наші скіни, тому ведуть не в кабінет, а в сам обмін.
        const tradeLine = trade
          ? `<span class="nav-balance-trade" title="${escapeHtml(navText("tradeTitle"))}">🔄 $${trade.toFixed(
              2
            )} · ${tradeUah} ₴</span>`
          : "";
        navBalanceEl.innerHTML = `
          <a class="nav-balance" href="${escapeHtml(
            trade && !available && !hold ? NAV_T.tradeUrl || "/trade" : NAV_T.accountUrl
          )}" title="${escapeHtml(NAV_T.balanceTitle || "")}">
            <span class="nav-balance-usd">$${available.toFixed(2)}</span>
            <span class="nav-balance-uah">${availableUah} ₴</span>
            ${holdLine}
            ${tradeLine}
          </a>`;
      }
    })
    // Шапка не має ламатись через неможливість дізнатись профіль чи баланс —
    // у найгіршому випадку її права частина просто лишиться порожньою.
    .catch(() => {});
}
window.refreshNavBalance = refreshNavBalance;
refreshNavBalance();

// Если вход через Steam не удался (Steam не ответил или вход отменили), сервер
// возвращает с ?login=failed. Раньше человек просто снова видел кнопку "Войти"
// и думал, что сайт завис, — теперь говорим прямо.
(function showLoginFailed() {
  const params = new URLSearchParams(location.search);
  if (params.get("login") !== "failed") return;

  const texts = {
    uk: "Не вдалося увійти через Steam — Steam не відповів або вхід скасовано. Спробуй ще раз.",
    ru: "Не удалось войти через Steam — Steam не ответил или вход отменён. Попробуй ещё раз.",
    en: "Couldn't sign in with Steam — Steam didn't respond or the sign-in was cancelled. Please try again.",
  };
  const lang = (document.documentElement.lang || "uk").slice(0, 2);

  const bar = document.createElement("div");
  bar.className = "login-failed-bar";
  bar.textContent = texts[lang] || texts.uk;
  bar.addEventListener("click", () => bar.remove());
  document.body.prepend(bar);
  setTimeout(() => bar.remove(), 12000);

  // Убираем пометку из адреса, чтобы при обновлении страницы сообщение не
  // появлялось снова.
  params.delete("login");
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
})();
