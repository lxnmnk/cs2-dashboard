// Панель фільтрів для сторінок із сіткою предметів: вітрина "Наші скіни" і
// інвентар клієнта в кабінеті. Обидві сторінки віддають предмети з полями
// marketHashName / wear / price (а вітрина ще й isLocked), тож панель одна
// на двох, а підписи приходять із конфіга мовної версії сторінки.
//
// Float і paint seed не фільтруємо свідомо: Steam їх у публічному інвентарі
// не віддає, для цього потрібен окремий inspect-парсер.
const WEAR_BY_CODE = {
  FN: "Factory New",
  MW: "Minimal Wear",
  FT: "Field-Tested",
  WW: "Well-Worn",
  BS: "Battle-Scarred",
};

const PRICE_PRESETS = [
  { label: "< $10", min: null, max: 10 },
  { label: "$10 – $50", min: 10, max: 50 },
  { label: "$50 – $250", min: 50, max: 250 },
  { label: "> $250", min: 250, max: null },
];

function createItemFilters({ mount, labels, showStatus = false, onChange }) {
  const state = {
    query: "",
    min: null,
    max: null,
    wears: new Set(),
    special: new Set(),
    status: new Set(),
  };

  mount.innerHTML = `
    <div class="filters-head">
      <h3>${escapeHtml(labels.filtersTitle)}</h3>
      <button class="filters-reset" type="button">${escapeHtml(labels.resetLabel)}</button>
    </div>

    <input class="filters-search" type="search" placeholder="${escapeHtml(labels.searchPlaceholder)}" />

    <div class="filters-group">
      <h4>${escapeHtml(labels.priceTitle)}</h4>
      <div class="filters-range">
        <label>${escapeHtml(labels.fromLabel)}<input class="filters-min" type="number" min="0" placeholder="0" /></label>
        <label>${escapeHtml(labels.toLabel)}<input class="filters-max" type="number" min="0" placeholder="∞" /></label>
      </div>
      <div class="filters-chips">
        ${PRICE_PRESETS.map(
          (p, i) => `<button class="filters-chip" type="button" data-price="${i}">${escapeHtml(p.label)}</button>`
        ).join("")}
      </div>
    </div>

    <div class="filters-group">
      <h4>${escapeHtml(labels.wearTitle)}</h4>
      <div class="filters-chips">
        ${Object.keys(WEAR_BY_CODE)
          .map((code) => `<button class="filters-chip" type="button" data-wear="${code}">${code}</button>`)
          .join("")}
      </div>
    </div>

    <div class="filters-group">
      <h4>${escapeHtml(labels.specialTitle)}</h4>
      <label class="filters-check"><input type="checkbox" data-special="stattrak" /> <span class="tag-stattrak">StatTrak™</span></label>
      <label class="filters-check"><input type="checkbox" data-special="souvenir" /> <span class="tag-souvenir">Souvenir</span></label>
      <label class="filters-check"><input type="checkbox" data-special="normal" /> ${escapeHtml(labels.normalLabel)}</label>
    </div>

    ${
      showStatus
        ? `<div class="filters-group">
             <h4>${escapeHtml(labels.statusTitle)}</h4>
             <label class="filters-check"><input type="checkbox" data-status="ready" /> ${escapeHtml(labels.readyLabel)}</label>
             <label class="filters-check"><input type="checkbox" data-status="locked" /> ${escapeHtml(labels.lockedLabel)}</label>
           </div>`
        : ""
    }`;

  const searchEl = mount.querySelector(".filters-search");
  const minEl = mount.querySelector(".filters-min");
  const maxEl = mount.querySelector(".filters-max");

  // Поле пошуку друкується посимвольно, тому перемальовуємо не на кожну
  // літеру, а трохи згодом — інакше на великому інвентарі ввід підлагує.
  let searchTimer;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = searchEl.value.trim().toLowerCase();
      onChange();
    }, 200);
  });

  for (const [el, key] of [[minEl, "min"], [maxEl, "max"]]) {
    el.addEventListener("input", () => {
      const value = parseFloat(el.value);
      state[key] = Number.isFinite(value) ? value : null;
      mount.querySelectorAll("[data-price]").forEach((b) => b.classList.remove("active"));
      onChange();
    });
  }

  mount.querySelectorAll("[data-price]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRICE_PRESETS[Number(btn.getAttribute("data-price"))];
      const wasActive = btn.classList.contains("active");
      mount.querySelectorAll("[data-price]").forEach((b) => b.classList.remove("active"));

      if (wasActive) {
        state.min = state.max = null;
        minEl.value = maxEl.value = "";
      } else {
        btn.classList.add("active");
        state.min = preset.min;
        state.max = preset.max;
        minEl.value = preset.min ?? "";
        maxEl.value = preset.max ?? "";
      }
      onChange();
    });
  });

  mount.querySelectorAll("[data-wear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-wear");
      btn.classList.toggle("active");
      if (state.wears.has(code)) state.wears.delete(code);
      else state.wears.add(code);
      onChange();
    });
  });

  for (const [attr, bucket] of [["data-special", state.special], ["data-status", state.status]]) {
    mount.querySelectorAll(`[${attr}]`).forEach((box) => {
      box.addEventListener("change", () => {
        const key = box.getAttribute(attr);
        if (box.checked) bucket.add(key);
        else bucket.delete(key);
        onChange();
      });
    });
  }

  mount.querySelector(".filters-reset").addEventListener("click", () => {
    state.query = "";
    state.min = state.max = null;
    state.wears.clear();
    state.special.clear();
    state.status.clear();
    searchEl.value = minEl.value = maxEl.value = "";
    mount.querySelectorAll(".filters-chip").forEach((b) => b.classList.remove("active"));
    mount.querySelectorAll('input[type="checkbox"]').forEach((b) => (b.checked = false));
    onChange();
  });

  function matches(item) {
    const name = item.marketHashName || "";

    if (state.query && !name.toLowerCase().includes(state.query)) return false;

    // Предмет без ціни ховаємо лише тоді, коли фільтр по ціні реально заданий.
    if (state.min != null || state.max != null) {
      if (item.price == null) return false;
      if (state.min != null && item.price < state.min) return false;
      if (state.max != null && item.price > state.max) return false;
    }

    if (state.wears.size) {
      const wear = item.wear || "";
      const ok = [...state.wears].some((code) => wear.startsWith(WEAR_BY_CODE[code]));
      if (!ok) return false;
    }

    if (state.special.size) {
      const isStatTrak = name.includes("StatTrak™");
      const isSouvenir = name.startsWith("Souvenir ");
      const ok =
        (state.special.has("stattrak") && isStatTrak) ||
        (state.special.has("souvenir") && isSouvenir) ||
        (state.special.has("normal") && !isStatTrak && !isSouvenir);
      if (!ok) return false;
    }

    if (state.status.size) {
      const ok = (state.status.has("locked") && item.isLocked) || (state.status.has("ready") && !item.isLocked);
      if (!ok) return false;
    }

    return true;
  }

  function escapeHtml(s) {
    return (s || "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  return { apply: (items) => items.filter(matches) };
}
