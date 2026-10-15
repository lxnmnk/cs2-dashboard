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

  // Три діапазони, по два предмети з кожного. Одним запитом виходив ряд із
  // шести ножів по сорок тисяч: каталог віддає сторінку відсортовану за
  // ціною, і "розкидати" всередині однієї сторінки нічого не дає — вона вся
  // з одного кінця діапазону. А людина має побачити, що тут є і за дві
  // тисячі, і за двадцять.
  const BANDS = ["min=40&max=120", "min=120&max=350", "min=350&max=900"];
  const PER_BAND = 2;

  // Наліпки, кейси, капсули й музичні набори в каталозі є, але у вітрині
  // "подивись, що тут продають" вони виглядають дрібним сміттям поряд із
  // ножем. Показуємо зброю, ножі й рукавиці.
  const NOT_A_SKIN = /^(Sticker|Sealed Graffiti|Patch|Music Kit|StatTrak™ Music Kit|Souvenir Package)|Capsule|Case Key|Case$|Pin$/;

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
    Promise.all(BANDS.map((band) => fetch(`/api/public/catalog?${band}&sort=price_desc`).then((r) => r.json())))
      .then((pages) => {
        const items = [];
        for (const page of pages) {
          if (!page.ok || !page.items?.length) continue;
          items.push(...spread(page.items.filter((it) => !NOT_A_SKIN.test(it.name)), PER_BAND));
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
