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

  // Гривня — тільки на українській версії. На російській та англійській
  // платити на українську картку нікому: там виплата в крипті, а ціни в
  // гривні лише збивали б з пантелику — людина порахувала б у ₴ те, що
  // отримає в доларах.
  const LANG = (document.documentElement.lang || "uk").toLowerCase();
  const UAH_ALLOWED = LANG === "uk";

  // На українській за замовчуванням гривня: більшість клієнтів з України і
  // виплату беруть на картку. Хто працює в доларах — перемикає сам, вибір
  // запам'ятовується.
  const stored = (() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null; // приватний режим
    }
  })();
  const state = {
    code: !UAH_ALLOWED ? "USD" : stored === "USD" ? "USD" : "UAH",
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

  const SYMBOL = { USD: "$", UAH: "₴" };

  /**
   * Перемикачі в шапці — валюта й мова — малюються однаково: кнопка з
   * поточним значенням і список під нею. Рядком із трьох посилань вони
   * займали півшапки, а на телефоні ще й переносились.
   */
  function dropdown(mount, { label, items, onPick }) {
    mount.classList.add("header-drop");
    mount.innerHTML = `
      <button class="header-drop-btn" type="button">${label}<span class="header-drop-arrow">▾</span></button>
      <div class="header-drop-menu">
        ${items.map((i) => `<a href="${i.href || "#"}" data-value="${i.value}"${i.active ? ' class="active"' : ""}>${i.label}</a>`).join("")}
      </div>`;

    const btn = mount.querySelector(".header-drop-btn");
    const menu = mount.querySelector(".header-drop-menu");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      document.querySelectorAll(".header-drop-menu.open").forEach((m) => m.classList.remove("open"));
      menu.classList.toggle("open", open);
    });
    if (onPick) {
      menu.querySelectorAll("[data-value]").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          menu.classList.remove("open");
          onPick(link.dataset.value);
        });
      });
    }
  }

  function render() {
    const mount = document.getElementById("currencySwitch");
    if (mount) {
      const choices = UAH_ALLOWED ? ["UAH", "USD"] : ["USD"];
      dropdown(mount, {
        label: SYMBOL[state.code],
        items: choices.map((c) => ({ value: c, label: `${SYMBOL[c]} ${c}`, active: c === state.code })),
        onPick: (code) => setCurrency(code),
      });
    }

    // Мова лежить у розмітці звичайними посиланнями — згортаємо їх у такий
    // самий список, не чіпаючи два десятки сторінок.
    const lang = document.querySelector(".lang-switch:not(.header-drop)");
    if (lang) {
      const links = [...lang.querySelectorAll("a")].map((a) => ({
        value: a.getAttribute("href"),
        href: a.getAttribute("href"),
        label: a.textContent.trim(),
        active: a.classList.contains("active"),
      }));
      if (links.length) {
        dropdown(lang, { label: (links.find((l) => l.active) || links[0]).label, items: links });
      }
    }
  }

  document.addEventListener("click", () => {
    document.querySelectorAll(".header-drop-menu.open").forEach((m) => m.classList.remove("open"));
  });

  /**
   * Змінити валюту показу.
   *
   * reload: true (перемикач у шапці) — найнадійніший спосіб, усі ціни на
   * сторінці перемальовуються звичайним кодом. reload: false потрібен там, де
   * валюта міняється сама посеред дії людини — наприклад, коли в кошику
   * обрали крипту: перезавантаження зараз скинуло б вибір предметів.
   */
  function setCurrency(code, { reload = true } = {}) {
    // Прохання показати гривню на неукраїнській версії ігноруємо — там її
    // немає й у виплатах. Запит приходить і з коду (кошик перемикає валюту
    // слідом за способом виплати), тому мовчазне ігнорування тут доречніше
    // за помилку.
    const next = code === "UAH" && UAH_ALLOWED ? "UAH" : "USD";
    if (next === state.code) return;
    state.code = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // приватний режим — просто не запам'ятаємо
    }
    if (reload) {
      location.reload();
      return;
    }
    render();
    document.dispatchEvent(new Event("currency-changed"));
  }

  window.Currency = state;
  window.fmtPrice = fmt;
  window.setCurrency = setCurrency;

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
