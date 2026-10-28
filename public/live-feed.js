// Жива стрічка угод на головній: що люди продали, за скільки, коли — і
// їхні відгуки поруч (сервер — reviews.js, /api/public/feed).
//
// Ніки замасковані на сервері, тут лише малюємо. Раз на хвилину перечитуємо
// перші угоди, і нові з'являються зверху з підсвіткою. Якщо угод ще немає,
// секція не показується зовсім — порожня "жива стрічка" гірша, ніж ніякої.
(function () {
  const root = document.getElementById("liveFeed");
  if (!root) return;

  const LANG = { ru: "ru", en: "en" }[document.documentElement.lang] || "uk";
  const T = {
    uk: {
      live: "Наживо",
      title: "Останні угоди",
      sub: "Хто що продав на gaben.market — і що про це пише.",
      deals: "{n} угод",
      reviews: "{n} відгуків",
      tabAll: "Усі угоди",
      tabReviews: "Відгуки",
      sold: "продав",
      traded: "обміняв",
      more: "Показати ще",
      noReviews: "Відгуків ще немає — їх залишають у профілі після продажу.",
      more2: "і ще {n}",
    },
    ru: {
      live: "Вживую",
      title: "Последние сделки",
      sub: "Кто что продал на gaben.market — и что об этом пишет.",
      deals: "{n} сделок",
      reviews: "{n} отзывов",
      tabAll: "Все сделки",
      tabReviews: "Отзывы",
      sold: "продал",
      traded: "обменял",
      more: "Показать ещё",
      noReviews: "Отзывов пока нет — их оставляют в профиле после продажи.",
      more2: "и ещё {n}",
    },
    en: {
      live: "Live",
      title: "Latest deals",
      sub: "Who sold what on gaben.market — and what they say about it.",
      deals: "{n} deals",
      reviews: "{n} reviews",
      tabAll: "All deals",
      tabReviews: "Reviews",
      sold: "sold",
      traded: "traded",
      more: "Show more",
      noReviews: "No reviews yet — they're left in the profile after a sale.",
      more2: "and {n} more",
    },
  }[LANG];

  const PAGE = 8;
  const REFRESH_MS = 60000;
  let mode = "all"; // all | reviews
  let items = [];
  let stats = null;
  let hasMore = false;
  let seen = new Set();

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ""));
  const money = (usd) => (window.fmtPrice ? window.fmtPrice(usd) : `$${(Number(usd) || 0).toFixed(2)}`);
  const keyOf = (it) => `${it.at}|${it.who}|${it.total}`;

  const rtf = new Intl.RelativeTimeFormat(LANG === "uk" ? "uk" : LANG, { numeric: "auto" });
  function ago(iso) {
    const sec = (new Date(iso).getTime() - Date.now()) / 1000;
    const steps = [
      [60, "second"],
      [3600, "minute", 60],
      [86400, "hour", 3600],
      [86400 * 30, "day", 86400],
      [Infinity, "month", 86400 * 30],
    ];
    for (const [limit, unit, div = 1] of steps) {
      if (Math.abs(sec) < limit) return rtf.format(Math.round(sec / div), unit);
    }
    return "";
  }

  // Назва без зброї й без якості — "Doppler", а зброя дрібно над нею, як на
  // картках каталогу. Фазу доплера показуємо, вона тут важлива.
  function splitName(name) {
    const phase = (name.match(/ - ([^-]+)$/) || [])[1] || "";
    const base = name.replace(/ - [^-]+$/, "").replace(/\s*\([^()]+\)\s*$/, "");
    const [weapon, skin] = base.split(" | ");
    return { weapon: skin ? weapon : "", skin: (skin || weapon) + (phase ? ` · ${phase}` : "") };
  }


  // Якість з назви ("(Field-Tested)") — короткою плашкою FN/MW/FT/WW/BS, як
  // на Youpin і в каталозі; шкала зносу — смужка від FN до BS з міткою float.
  const WEAR_CODES = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
  const wearOf = (name) => WEAR_CODES[(String(name).match(/\(([^()]+)\)(?: - [^-]+)?$/) || [])[1]] || "";
  const floatBarHtml = (f) =>
    f == null || !Number.isFinite(Number(f))
      ? ""
      : `<div class="float-bar"><span class="float-value">${Number(f).toFixed(4)}</span><span class="float-track"><i style="left:${Math.min(100, Number(f) * 100).toFixed(1)}%"></i></span></div>`;

  const stars = (n) =>
    `<span class="feed-stars" aria-label="${n}/5">${"★".repeat(n)}<span class="feed-stars-off">${"★".repeat(5 - n)}</span></span>`;

  function cardHtml(it, fresh) {
    const first = it.items[0] || { name: "", qty: 1 };
    const { weapon, skin } = splitName(first.name);
    const extraCount = it.items.slice(1).reduce((s, g) => s + g.qty, 0) + (first.qty - 1);
    const wear = wearOf(first.name);
    const pics = it.items
      .slice(0, 3)
      .map((g) => (g.image ? `<img src="${esc(g.image)}" alt="" loading="lazy" />` : `<span class="feed-pic-empty"></span>`))
      .join("");
    const badge = wear ? `<span class="wear-badge wear-${wear}">${wear}</span>` : "";
    return `
      <article class="feed-card ${fresh ? "is-fresh" : ""} ${it.review ? "has-review" : ""}">
        <div class="feed-pics count-${Math.min(3, it.items.length)}">${pics}${badge}</div>
        <div class="feed-body">
          <div class="feed-item">
            ${weapon ? `<span class="feed-weapon">${esc(weapon)}</span>` : ""}
            <span class="feed-skin">${esc(skin)}${extraCount > 0 ? ` <span class="feed-more">${esc(fill(T.more2, { n: extraCount }))}</span>` : ""}</span>
          </div>
          ${it.items.length === 1 && first.qty === 1 ? floatBarHtml(first.float) : ""}
          <div class="feed-meta">
            <b>${esc(it.who)}</b> ${esc(it.kind === "trade" ? T.traded : T.sold)} · ${esc(ago(it.at))}
          </div>
          ${
            it.review
              ? `<div class="feed-review">${stars(it.review.rating)}${it.review.text ? `<p>${esc(it.review.text)}</p>` : ""}</div>`
              : ""
          }
        </div>
        <div class="feed-price">${esc(money(it.total))}</div>
      </article>`;
  }

  function render(freshKeys = new Set()) {
    if (!stats || !stats.deals) {
      root.style.display = "none";
      return;
    }
    root.style.display = "";
    const statLine = [
      stats.rating != null ? `<span class="feed-stat">${stars(Math.round(stats.rating))} <b>${stats.rating.toFixed(1)}</b> · ${esc(fill(T.reviews, { n: stats.reviews }))}</span>` : "",
      `<span class="feed-stat">${esc(fill(T.deals, { n: stats.deals }))}</span>`,
    ].join("");
    root.innerHTML = `
      <div class="feed-head">
        <span class="feed-live"><i></i>${esc(T.live)}</span>
        <h2>${esc(T.title)}</h2>
        <p class="card-hint">${esc(T.sub)}</p>
        <div class="feed-stats">${statLine}</div>
        <div class="feed-tabs">
          <button type="button" data-mode="all" class="${mode === "all" ? "active" : ""}">${esc(T.tabAll)}</button>
          <button type="button" data-mode="reviews" class="${mode === "reviews" ? "active" : ""}">${esc(T.tabReviews)}</button>
        </div>
      </div>
      ${
        items.length
          ? `<div class="feed-list">${items.map((it) => cardHtml(it, freshKeys.has(keyOf(it)))).join("")}</div>`
          : `<p class="card-hint feed-empty">${esc(T.noReviews)}</p>`
      }
      ${hasMore ? `<button type="button" class="btn-small feed-more-btn">${esc(T.more)}</button>` : ""}`;
  }

  async function fetchPage(offset) {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset), reviews: mode === "reviews" ? "1" : "0" });
    const res = await fetch(`/api/public/feed?${q}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data;
  }

  async function load({ append = false } = {}) {
    try {
      const data = await fetchPage(append ? items.length : 0);
      stats = data.stats;
      hasMore = data.hasMore;
      // Нові угоди (яких ще не бачили на сторінці) — з підсвіткою, крім
      // першого завантаження: там "нове" все.
      const fresh = new Set(seen.size ? data.items.map(keyOf).filter((k) => !seen.has(k)) : []);
      data.items.forEach((it) => seen.add(keyOf(it)));
      items = append ? items.concat(data.items) : data.items;
      render(fresh);
    } catch {
      // стрічка — прикраса сторінки; не вдалося — просто не показуємо
      if (!items.length) root.style.display = "none";
    }
  }

  root.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-mode]");
    if (tab && tab.dataset.mode !== mode) {
      mode = tab.dataset.mode;
      items = [];
      load();
      return;
    }
    if (e.target.closest(".feed-more-btn")) load({ append: true });
  });

  root.style.display = "none";
  load();
  // Оновлюємо тільки першу сторінку і тільки поки людина не відкрила "ще":
  // інакше список під пальцем стрибав би.
  setInterval(() => {
    if (document.hidden || items.length > PAGE) return;
    load();
  }, REFRESH_MS);
})();
