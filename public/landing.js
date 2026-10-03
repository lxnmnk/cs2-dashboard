// Главная страница сайта. Живой кусок тут один: сколько скинов сейчас в
// наличии — число берём из того же списка, что и страница "Наші скіни",
// чтобы не вписывать его руками и не забывать обновлять.
const LANDING_T = window.LANDING_CONFIG || {};

function landingFill(template, vars) {
  return (template || "").replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
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

showStockCount();
