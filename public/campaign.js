// Банер акції (зараз — Black Friday) на головній і в кабінеті.
//
// Що й коли показувати, вирішує сервер (/api/public/campaign, promoCodes.js
// CAMPAIGNS): поза датами акції він віддає null, і банер просто не з'являється
// — прибирати його руками після 8 листопада не треба.
//
// Акція лише для виплати на українську картку в гривні, тож банер — тільки на
// українській версії: на російській та англійській картки немає, і обіцянка
// була б порожньою.
(function () {
  const mount = document.getElementById("campaignBanner");
  if (!mount || (document.documentElement.lang || "uk") !== "uk") return;

  // Приклад у банері: скін, за який звичайно платимо 1 000 ₴. Бонус +5% до
  // ціни — 1 050 ₴. Насправді клієнт отримує навіть трохи більше (ми віддаємо
  // всю ціну викупу, тобто 1 000 / 0.95), але обіцяємо круглу цифру.
  const EXAMPLE_UAH = 1000;

  const fmtUah = (n) => Math.round(n).toLocaleString("uk-UA") + " ₴";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function timeLeft(endsAt) {
    const ms = Date.parse(endsAt) - Date.now();
    if (!(ms > 0)) return null;
    const s = Math.floor(ms / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 };
  }

  const UNITS = [
    ["d", "дн"],
    ["h", "год"],
    ["m", "хв"],
    ["s", "сек"],
  ];

  function render(c) {
    const code = c.code.toUpperCase();
    const now = EXAMPLE_UAH * (1 + c.bonusPercent / 100);
    // У кабінеті — застосувати код одразу в кошику; на головній — посилання,
    // яке кладе код у сесію і веде в кабінет.
    const inAccount = !!document.getElementById("promoApplyBtn");
    const cta = inAccount
      ? `<button class="btn-gold bf-apply" type="button">Застосувати ${esc(code)}</button>`
      : `<a class="btn-gold" href="/${esc(c.code)}?go=account">Продати скіни з +${c.bonusPercent}%</a>`;

    mount.innerHTML = `
      <section class="bf-banner">
        <div class="bf-head">
          <span class="bf-tag">BLACK FRIDAY</span>
          <span class="bf-dates">6–8 листопада</span>
        </div>
        <div class="bf-main">
          <div class="bf-offer">
            <div class="bf-plus">+${c.bonusPercent}%</div>
            <div class="bf-offer-text">до виплати за твої скіни<span>на картку в гривні</span></div>
          </div>
          <div class="bf-countdown" role="timer" aria-label="До кінця акції">
            <div class="bf-cd-label">До кінця акції</div>
            <div class="bf-cd-units">
              ${UNITS.map(
                ([k, label], i) =>
                  `${i ? '<i class="bf-cd-sep">:</i>' : ""}<div class="bf-cd-unit"><b data-u="${k}">00</b><span>${label}</span></div>`
              ).join("")}
            </div>
          </div>
          <div class="bf-compare" aria-label="Приклад">
            <div class="bf-was"><span>Звичайно</span><s>${fmtUah(EXAMPLE_UAH)}</s></div>
            <div class="bf-arrow">→</div>
            <div class="bf-now"><span>Зараз</span><b>${fmtUah(now)}</b></div>
          </div>
        </div>
        <p class="bf-zero">Ці три дні ми нічого не заробляємо на викупі: віддаємо тобі всю суму, яку самі отримуємо за скін. Нам зараз важливі нові клієнти, а не маржа.</p>
        <div class="bf-foot">
          <div class="bf-code">Промокод <b>${esc(code)}</b><button class="bf-copy" type="button">Копіювати</button></div>
          ${cta}
        </div>
        <p class="bf-terms">Один продаж на акаунт — скільки завгодно скінів у ньому · виплата на картку в гривні · до 8 листопада, 23:59 за Києвом · точна ціна кожного скіна — у кошику</p>
      </section>`;

    const cells = {};
    for (const [k] of UNITS) cells[k] = mount.querySelector(`[data-u="${k}"]`);
    let timerId = 0;
    const tick = () => {
      const left = timeLeft(c.endsAt);
      if (!left) {
        clearInterval(timerId);
        mount.innerHTML = ""; // акція скінчилась, поки сторінка була відкрита
        return;
      }
      for (const [k] of UNITS) {
        const v = String(left[k]).padStart(2, "0");
        if (cells[k].textContent !== v) cells[k].textContent = v;
      }
    };
    tick();
    timerId = setInterval(tick, 1000);

    mount.querySelector(".bf-copy").addEventListener("click", (e) => {
      navigator.clipboard?.writeText(code).then(
        () => {
          e.target.textContent = "Скопійовано";
          setTimeout(() => (e.target.textContent = "Копіювати"), 2000);
        },
        () => {}
      );
    });

    mount.querySelector(".bf-apply")?.addEventListener("click", () => {
      const input = document.getElementById("promoInput");
      const apply = document.getElementById("promoApplyBtn");
      // Ще не увійшов — кошика немає: ведемо на вхід, код уже в сесії після
      // переходу за посиланням.
      if (!input || !apply || !apply.offsetParent) {
        location.href = `/${c.code}?go=account`;
        return;
      }
      input.value = code;
      apply.click();
      (document.getElementById("promoStatus") || input).scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  fetch("/api/public/campaign")
    .then((r) => r.json())
    .then((d) => {
      if (d?.campaign) render(d.campaign);
    })
    .catch(() => {});
})();
