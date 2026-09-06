// Профіль у правій частині шапки: якщо клієнт уже увійшов через Steam —
// аватар з ніком і посиланням у кабінет, якщо ні — кнопка входу. Тексти й
// мовні адреси задаються через window.NAV_CONFIG перед підключенням файлу
// (той самий підхід, що в quote-common.js).
const { signInLabel, accountUrl, loginUrl } = window.NAV_CONFIG;
const navProfileEl = document.getElementById("navProfile");

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

fetch("/api/account/me")
  .then((r) => r.json())
  .then((data) => {
    if (data.customer) {
      navProfileEl.innerHTML = `
        <a class="nav-profile-user" href="${escapeHtml(accountUrl)}">
          <img src="${escapeHtml(data.customer.avatar || "")}" alt="" />
          <span>${escapeHtml(data.customer.displayName)}</span>
        </a>`;
    } else {
      navProfileEl.innerHTML = `<a class="btn-small" href="${escapeHtml(loginUrl)}">${escapeHtml(signInLabel)}</a>`;
    }
  })
  // Профіль — не критична частина сторінки: якщо запит не пройшов, шапка
  // просто лишається без нього, а не ламає решту.
  .catch(() => {});
