// Графік історії цін предмета (priceHistory.js на сервері) — вікно поверх
// сторінки, відкривається з My Trades і Arbitrage: window.openPriceChart(name).
//
// Лінії: buff ask/bid, youpin ask/bid, skinbux bid, cs.money bid. Bid — тією ж
// барвою, що ask, але пунктиром. Біля кожної — остання ціна і зміна за
// вибраний період; клік по плашці ховає/показує лінію (запам'ятовується).
// Наведення — вертикальна лінія і ціни всіх майданчиків на цю годину.
(function () {
  const SERIES = [
    { key: "buff_ask", label: "Buff ask", color: "#3ecf8e" },
    { key: "buff_bid", label: "Buff bid", color: "#3ecf8e", dash: true },
    { key: "youpin_ask", label: "YouPin ask", color: "#ff6f91" },
    { key: "youpin_bid", label: "YouPin bid", color: "#ff6f91", dash: true },
    { key: "skinbux_bid", label: "Skinbux bid", color: "#f0b232" },
    { key: "csmoney_bid", label: "CS.money bid", color: "#ff7b39" },
  ];
  const RANGES = [
    ["24h", "24ч"],
    ["7d", "7 дней"],
    ["30d", "30 дней"],
    ["90d", "90 дней"],
    ["all", "всё"],
  ];
  const HIDDEN_KEY = "price_chart_hidden_v1";
  const RANGE_KEY = "price_chart_range_v1";
  const H = 380;
  const PAD = { top: 16, right: 96, bottom: 28, left: 64 };

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        // приватне вікно — просто не запам'ятовуємо
      }
    },
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

  const state = { name: "", range: store.get(RANGE_KEY, "30d"), hidden: new Set(store.get(HIDDEN_KEY, [])), points: [], seq: 0 };
  let root = null;

  function build() {
    root = document.createElement("div");
    root.className = "pc-overlay";
    root.innerHTML = `
      <div class="pc-card" role="dialog" aria-modal="true">
        <div class="pc-head">
          <div>
            <h2 class="pc-title"></h2>
            <div class="pc-sub">история цен · каждый час в :50, старше 90 дней — среднее за сутки</div>
          </div>
          <button class="pc-close" type="button" aria-label="Закрыть">×</button>
        </div>
        <div class="pc-ranges">${RANGES.map(([k, l]) => `<button type="button" data-range="${k}">${l}</button>`).join("")}</div>
        <div class="pc-chips"></div>
        <div class="pc-plot"><div class="pc-tip" hidden></div></div>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener("click", (e) => {
      if (e.target === root || e.target.closest(".pc-close")) return close();
      const r = e.target.closest("[data-range]");
      if (r) {
        state.range = r.dataset.range;
        store.set(RANGE_KEY, state.range);
        return load();
      }
      const chip = e.target.closest("[data-key]");
      if (chip) {
        const k = chip.dataset.key;
        state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
        store.set(HIDDEN_KEY, [...state.hidden]);
        render();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root && !root.hidden) close();
    });
    window.addEventListener("resize", () => root && !root.hidden && render());
  }

  function close() {
    root.hidden = true;
    document.body.classList.remove("pc-open");
  }

  async function load() {
    const seq = ++state.seq;
    root.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("is-active", b.dataset.range === state.range));
    plotMessage("Загружаю...");
    let data;
    try {
      const res = await fetch(`/api/price-history?name=${encodeURIComponent(state.name)}&range=${state.range}`);
      data = await res.json();
    } catch {
      data = { ok: false };
    }
    if (seq !== state.seq) return;
    if (!data.ok) return plotMessage("Не удалось загрузить историю. Попробуй ещё раз.");
    state.points = data.points || [];
    render();
  }

  function plotMessage(text) {
    root.querySelector(".pc-chips").innerHTML = "";
    const plot = root.querySelector(".pc-plot");
    plot.querySelector("svg")?.remove();
    plot.querySelector(".pc-empty")?.remove();
    plot.insertAdjacentHTML("afterbegin", `<div class="pc-empty">${esc(text)}</div>`);
  }

  // Перша і остання ціна лінії за період — для плашки "$X −3.2%".
  function firstLast(key) {
    let first = null;
    let last = null;
    for (const p of state.points) {
      if (p[key] == null) continue;
      if (first == null) first = p[key];
      last = p[key];
    }
    return { first, last };
  }

  function renderChips() {
    root.querySelector(".pc-chips").innerHTML = SERIES.map((s) => {
      const { first, last } = firstLast(s.key);
      if (last == null) return "";
      const pct = first ? ((last - first) / first) * 100 : 0;
      const cls = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "";
      return `<button type="button" class="pc-chip${state.hidden.has(s.key) ? " is-off" : ""}" data-key="${s.key}" style="--c:${s.color}">
        <i class="${s.dash ? "is-dash" : ""}"></i>${esc(s.label)} <b>${money(last)}</b> <span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span>
      </button>`;
    }).join("");
  }

  function niceTicks(min, max, count) {
    const span = max - min || max || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  function fmtTime(t, span) {
    const d = new Date(t * 1000);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    if (span <= 2 * 86400) return `${String(d.getHours()).padStart(2, "0")}:00`;
    return `${dd}.${mm}`;
  }

  function render() {
    const pts = state.points;
    const plot = root.querySelector(".pc-plot");
    plot.querySelector(".pc-empty")?.remove();
    plot.querySelector("svg")?.remove();
    const visible = SERIES.filter((s) => !state.hidden.has(s.key) && pts.some((p) => p[s.key] != null));
    renderChips();
    if (!pts.length) return plotMessage("Истории пока нет: цены записываются раз в час, первые точки появятся в :50.");

    const W = Math.max(320, plot.clientWidth);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const vals = visible.flatMap((s) => pts.map((p) => p[s.key]).filter((v) => v != null));
    let lo = vals.length ? Math.min(...vals) : 0;
    let hi = vals.length ? Math.max(...vals) : 1;
    const padY = (hi - lo) * 0.08 || hi * 0.05 || 1;
    lo = Math.max(0, lo - padY);
    hi += padY;
    const x = (t) => PAD.left + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

    // Розрив лінії: ціни немає довше за 3 години (у стиснутій частині, старше
    // 90 днів, — за 3 доби), наприклад сервер лежав або майданчик не віддавав
    // ціну. Година-дві без ціни — лінію не рвемо, інакше вона йде пунктиром.
    const gapLimit = (a, b) => (b - a > (a < Date.now() / 1000 - 90 * 86400 ? 3 * 86400 : 3 * 3600));
    const paths = visible.map((s) => {
      let d = "";
      let prev = null;
      for (const p of pts) {
        const v = p[s.key];
        if (v == null) continue;
        d += `${prev && !gapLimit(prev.t, p.t) ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        prev = p;
      }
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round" />`;
    });

    const yTicks = niceTicks(lo, hi, 5);
    const span = t1 - t0;
    const xCount = Math.max(2, Math.min(8, Math.floor((W - PAD.left - PAD.right) / 110)));
    const xTicks = Array.from({ length: xCount }, (_, i) => t0 + (span * i) / (xCount - 1));

    // Підписи справа — біля останньої точки лінії, розсунуті, щоб не налазили.
    const ends = visible
      .map((s) => {
        const last = [...pts].reverse().find((p) => p[s.key] != null);
        return last ? { s, y: y(last[s.key]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;

    plot.insertAdjacentHTML(
      "afterbegin",
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        ${yTicks.map((v) => `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}" class="pc-grid" /><text x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end" class="pc-axis">$${v >= 1000 ? Math.round(v) : v.toFixed(v < 10 ? 2 : 0)}</text>`).join("")}
        ${xTicks.map((t) => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="pc-axis">${fmtTime(t, span)}</text>`).join("")}
        ${paths.join("")}
        ${ends.map((e) => `<text x="${W - PAD.right + 6}" y="${e.y + 4}" class="pc-end" fill="${e.s.color}">${esc(e.s.label)}</text>`).join("")}
        <line class="pc-cross" y1="${PAD.top}" y2="${H - PAD.bottom}" x1="-10" x2="-10" />
        <rect class="pc-hit" x="${PAD.left}" y="${PAD.top}" width="${W - PAD.left - PAD.right}" height="${H - PAD.top - PAD.bottom}" />
      </svg>`
    );

    const svg = plot.querySelector("svg");
    const cross = svg.querySelector(".pc-cross");
    const tip = plot.querySelector(".pc-tip");
    svg.querySelector(".pc-hit").addEventListener("mousemove", (e) => {
      const box = svg.getBoundingClientRect();
      const mx = e.clientX - box.left;
      const t = t0 + ((mx - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const px = x(best.t);
      cross.setAttribute("x1", px);
      cross.setAttribute("x2", px);
      const d = new Date(best.t * 1000);
      tip.innerHTML =
        `<div class="pc-tip-time">${d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>` +
        visible
          .filter((s) => best[s.key] != null)
          .map((s) => `<div><i style="background:${s.color}"></i>${esc(s.label)} <b>${money(best[s.key])}</b></div>`)
          .join("");
      tip.hidden = false;
      const left = px + 14 + 190 > W ? px - 14 - 190 : px + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${PAD.top + 4}px`;
    });
    svg.querySelector(".pc-hit").addEventListener("mouseleave", () => {
      tip.hidden = true;
      cross.setAttribute("x1", -10);
      cross.setAttribute("x2", -10);
    });
  }

  // Кнопка 📈 у таблицях: data-price-chart = назва в прайсі (з фазою).
  // Захоплення, щоб клік не долітав до рядка таблиці (виділення/розгортання).
  document.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest("[data-price-chart]");
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      window.openPriceChart(b.dataset.priceChart, b.dataset.chartTitle);
    },
    true
  );

  window.openPriceChart = function (name, title) {
    if (!name) return;
    if (!root) build();
    state.name = name;
    state.points = [];
    root.querySelector(".pc-title").textContent = title || name;
    root.hidden = false;
    document.body.classList.add("pc-open");
    load();
  };
})();
