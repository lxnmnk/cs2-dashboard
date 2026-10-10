// Валюта, в якій людина бачить ціни: долар або гривня.
//
// Усі числа на сайті рахуються в доларах — так приходять ціни з площадок, і
// так ми розраховуємось. Гривня це лише спосіб показу: курс один, береться з
// сервера (config.uahRate), щоб на всіх сторінках він був однаковий і правився
// в одному місці.
//
// Вибір запам'ятовується в браузері. Перемикання перезавантажує сторінку —
// кожна сторінка тоді малює ціни заново своїм звичайним кодом, і не треба
// тримати в голові десяток місць, які довелося б перемальовувати вручну.
(function () {
  const KEY = "currency";
  const DEFAULT_RATE = 45.5;

  const state = {
    code: localStorage.getItem(KEY) === "UAH" ? "UAH" : "USD",
    rate: DEFAULT_RATE,
  };

  /** Долари -> рядок у вибраній валюті. */
  function fmt(usd) {
    const n = Number(usd) || 0;
    if (state.code === "UAH") {
      return Math.round(n * state.rate).toLocaleString("uk-UA") + " ₴";
    }
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function render() {
    const mount = document.getElementById("currencySwitch");
    if (!mount) return;
    mount.className = "lang-switch currency-switch";
    mount.innerHTML = ["USD", "UAH"]
      .map((c) => `<a href="#" data-currency="${c}"${c === state.code ? ' class="active"' : ""}>${c === "UAH" ? "₴" : "$"}</a>`)
      .join("");

    mount.querySelectorAll("[data-currency]").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const code = link.dataset.currency;
        if (code === state.code) return;
        localStorage.setItem(KEY, code);
        // Перезавантаження — найнадійніший спосіб: усі ціни на сторінці
        // перемалюються тим самим кодом, що й зазвичай.
        location.reload();
      });
    });
  }

  window.Currency = state;
  window.fmtPrice = fmt;

  // Курс питаємо один раз; поки не прийшов, рахуємо за запасним — щоб ціни не
  // блимали й не чекали мережі.
  fetch("/api/public/rate")
    .then((r) => r.json())
    .then((d) => {
      if (d?.uahRate) state.rate = d.uahRate;
      if (state.code === "UAH") document.dispatchEvent(new Event("currency-rate"));
    })
    .catch(() => {});

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
  else render();
})();
