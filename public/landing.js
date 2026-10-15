// Лендинг: вітрина живого товару під героєм.
//
// Раніше тут був лічильник наших залишків, який вів у вітрину "Наші скіни".
// Вітрини більше немає — усе, що ми продаємо, тепер у каталозі на /buy.
//
// Тепер сторінка показує сам товар: шість карток із каталогу, з реальними
// картинками й цінами в обраній валюті. Перший екран без жодного скіна
// розповідав про скіни словами, хоча міг просто їх показати.
//
// Ціни беремо з того ж /api/public/catalog, що й каталог, тому розбіжності
// між головною й каталогом неможливі за побудовою.
(function () {
  const grid = document.getElementById("showcaseGrid");
  if (!grid) return;

  const CFG = window.LANDING_CONFIG || {};
  const COUNT = 6;

  // Вітрина показує тільки найліквідніше — список заданий на сервері
  // (isFeatured у server.js): ножі в Doppler, Tiger Tooth, Freehand, Marble
  // Fade та Black Laminate і три автомати в Printstream, Neo-Noir, Neon
  // Rider, Neon Revolution, без StatTrak. Це те, що йде в будь-який день, і
  // саме таке має бачити людина, яка відкрила сайт уперше.
  //
  // Два запити, а не один: каталог віддає сторінку, відсортовану за ціною,
  // тож з одного кінця прийшли б самі ножі по сорок тисяч. Беремо найдешевші
  // й найдорожчі й показуємо по три звідти й звідти.
  const QUERIES = [
    "featured=1&sort=price_asc",
    "featured=1&min=150&max=400&sort=price_asc",
    "featured=1&sort=price_desc",
  ];
  const PER_QUERY = 2;

  // Якості пишемо кодом: у рядок під назвою "Factory New" не влазить, а FN
  // упізнається з одного погляду — так само, як у каталозі.
  const WEAR_CODE = {
    "Factory New": "FN",
    "Minimal Wear": "MW",
    "Field-Tested": "FT",
    "Well-Worn": "WW",
    "Battle-Scarred": "BS",
  };

  function skeletons() {
    grid.innerHTML = Array.from({ length: COUNT })
      .map(
        () => `<div class="show-card skeleton">
            <div class="show-card-img"></div>
            <div class="show-card-body">
              <div class="show-card-name"></div>
              <div class="show-card-price"></div>
            </div>
          </div>`
      )
      .join("");
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function price(usd) {
    return window.fmtPrice ? window.fmtPrice(usd) : `$${Number(usd || 0).toFixed(2)}`;
  }

  function render(items) {
    grid.innerHTML = items
      .map((it) => {
        const wear = WEAR_CODE[String(it.wear || "").split(" \u00b7 ")[0]] || "";
        return `<a class="show-card" href="${esc(CFG.buyUrl || "/buy")}?q=${encodeURIComponent(it.name)}">
            <span class="show-card-img">${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" />` : ""}</span>
            <span class="show-card-body">
              <span class="show-card-name">${esc(it.name)}</span>
              <span class="show-card-foot">
                <span class="show-card-price">${esc(price(it.price))}</span>
                ${wear ? `<span class="show-card-wear">${wear}</span>` : ""}
              </span>
            </span>
          </a>`;
      })
      .join("");
  }

  /**
   * Шість предметів із різних кінців діапазону, а не шість найдорожчих
   * підряд: інакше в ряду стоять шість ножів по 27 тисяч, і людина з трьома
   * тисячами вирішує, що їй тут нічого.
   */
  function spread(items, count) {
    if (items.length <= count) return items;
    const step = items.length / count;
    return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
  }

  let loaded = [];

  function load() {
    skeletons();
    Promise.all(QUERIES.map((q) => fetch(`/api/public/catalog?${q}`).then((r) => r.json())))
      .then((pages) => {
        const items = [];
        const seen = new Set();
        for (const page of pages) {
          if (!page.ok || !page.items?.length) continue;
          for (const it of spread(page.items, PER_QUERY)) {
            // Найдешевший і найдорожчий списки перетинаються, коли предметів
            // у вітрині мало — один предмет двічі в ряду виглядає як помилка.
            if (seen.has(it.marketHashName)) continue;
            seen.add(it.marketHashName);
            items.push(it);
          }
        }
        // Ціни ще не піднялися після рестарту — вітрину просто не показуємо:
        // порожня сітка гірша за її відсутність.
        if (items.length < COUNT) {
          document.getElementById("heroShowcase")?.remove();
          return;
        }
        // Від дешевших до дорожчих: ряд читається зліва направо, і перше, що
        // бачить око, — що вхід сюди не починається з сорока тисяч.
        loaded = items.sort((a, b) => a.price - b.price).slice(0, COUNT);
        render(loaded);
      })
      .catch(() => document.getElementById("heroShowcase")?.remove());
  }

  // Валюту людина перемикає в шапці — ціни на вітрині мають піти за нею.
  document.addEventListener("currency-changed", () => loaded.length && render(loaded));
  document.addEventListener("currency-rate", () => loaded.length && render(loaded));

  load();
})();

// ---- Поява секцій при скролі ----
// Не заради краси: сторінка довга, і без жодного руху незрозуміло, що нижче
// ще щось є. Зсув на вісім пікселів і проявлення — рівно стільки, щоб око
// помітило нове й не відволіклось від тексту.
//
// Головне правило: вміст не має зникати ні за яких обставин. Те, що вже на
// екрані, показуємо одразу й не ховаємо взагалі; ховаємо тільки те, до чого
// ще треба долистати. Якщо спостерігач не спрацює (а в деяких оболонках
// він мовчить), усе одно показуємо все через дві секунди.
(function () {
  const blocks = [...document.querySelectorAll(".landing-block, .hero-showcase")];
  if (!blocks.length) return;

  // Системне "не анімувати" поважаємо: людина могла попросити це через
  // вестибулярні проблеми, а не з любові до статики.
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window)) return;

  const below = blocks.filter((b) => b.getBoundingClientRect().top > window.innerHeight * 0.9);
  if (!below.length) return;

  below.forEach((b) => b.classList.add("reveal"));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target); // показали один раз — далі не стежимо
      }
    },
    { rootMargin: "0px 0px -10% 0px" }
  );
  below.forEach((b) => io.observe(b));

  setTimeout(() => below.forEach((b) => b.classList.add("in")), 2000);
})();

// ---- Фон рухається повільніше за контент ----
// Дешевий спосіб дати першому екрану глибину там, де справжнього 3D немає:
// Steam віддає плоскі картинки, моделей ножів у нас нема. На дотикових
// екранах вимкнено — там це лише зайва робота для батареї.
(function () {
  const bg = document.querySelector(".bg-decor");
  if (!bg || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (window.matchMedia("(hover: none)").matches) return;

  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        bg.style.transform = "translate3d(0, " + Math.min(window.scrollY * 0.12, 120) + "px, 0)";
        ticking = false;
      });
    },
    { passive: true }
  );
})();
