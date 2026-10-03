// Главная страница сайта. Два живых куска, остальное — статика в разметке:
//
//  1. Баннер акции. Показываем только если она ещё идёт по датам И процент
//     на покупку в панели реально нулевой (/api/public/pricing). Иначе на
//     витрине висело бы "0%", пока на деле считается наценка — это обман
//     клиента и спор на ровном месте.
//  2. Сколько скінів зараз у наявності — число из того же списка, что на
//     странице "Наші скіни", чтобы не писать цифру руками.
const LANDING_T = window.LANDING_CONFIG || {};

function landingFill(template, vars) {
  return (template || "").replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}

async function showPromo() {
  const box = document.getElementById("promoBanner");
  if (!box || !LANDING_T.promoFrom || !LANDING_T.promoTo) return;

  // Акция действует включительно по конечную дату: берём конец того дня.
  const now = Date.now();
  const from = Date.parse(LANDING_T.promoFrom);
  const to = Date.parse(LANDING_T.promoTo) + 86400000 - 1;
  if (!(now >= from && now <= to)) return;

  let pricing;
  try {
    pricing = await fetch("/api/public/pricing").then((r) => r.json());
  } catch {
    return; // не знаем процент — молчим, обещать нечего
  }
  if (Number(pricing.buyMarkupPercent) !== 0) return;

  box.innerHTML = `<span class="promo-tag">${LANDING_T.promoTag}</span> ${LANDING_T.promoText}`;
  box.style.display = "";
}

async function showStockCount() {
  const el = document.getElementById("stockCount");
  if (!el) return;
  try {
    const skins = await fetch("/api/public/my-skins").then((r) => r.json());
    if (!Array.isArray(skins) || !skins.length) return;
    const total = skins.reduce((sum, s) => sum + (Number(s.price) || 0), 0);
    el.textContent = landingFill(LANDING_T.stockLine, {
      count: skins.length,
      total: "$" + Math.round(total).toLocaleString("en-US"),
    });
    el.style.display = "";
  } catch {
    // витрина недоступна — строку просто не показываем
  }
}

showPromo();
showStockCount();
