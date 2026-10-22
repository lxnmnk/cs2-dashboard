// Картка однієї угоди клієнта — спільна для вікна "Мої угоди" в кабінеті і
// для сторінки профілю. Була тільки в account-deals.js, і профіль довелося б
// малювати другим таким же кодом: два місця, де статуси угод розходяться —
// це питання часу.
//
// Чистa функція: приймає угоду і набір підписів (window.ACCOUNT_CONFIG),
// повертає HTML. Нічого не знає ні про модалку, ні про сторінку.
(function () {
  const TELEGRAM_USERNAME = "gabenmarket_support";

  function format(str, vars) {
    return String(str || "").replace(/\{(\w+)\}/g, (_, key) => vars[key]);
  }

  function money(usd) {
    return window.fmtPrice ? window.fmtPrice(usd) : "$" + (Number(usd) || 0).toFixed(2);
  }

  function esc(s) {
    return (s || "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // Однакові предмети в одній угоді — одним рядком з "×2": два довгі
  // однакові імена через кому читались як помилка.
  function itemsHtml(items) {
    const counts = new Map();
    for (const it of items) counts.set(it.name, (counts.get(it.name) || 0) + 1);
    return [...counts]
      .map(([name, n]) => `<span class="deal-item">${esc(name)}${n > 1 ? ` <span class="deal-qty">×${n}</span>` : ""}</span>`)
      .join("");
  }

  window.renderDealCard = function renderDealCard(sale, T) {
    const date = new Date(sale.createdAt).toLocaleDateString(T.dateLocale);

    // Статуси беремо як є від Skinbux: "hold" — обмін прийнято, гроші
    // заморожені на 7 днів; "completed" — вже розморожені й доступні до
    // виплати. Сторона клієнта в обміні (kind "trade") живе за іншими
    // правилами: гроші не виводяться, а лежать trade-балансом і витрачаються
    // на наші скіни. Холд на них чекаємо ми, тому клієнту тут ні дат холду,
    // ні кнопки виводу — тільки "можна забирати скіни".
    //
    // state — колір плашки статусу: done (зелена), ready (золота, щось
    // треба зробити), hold (золотиста, чекаємо), pending (сіра).
    let state;
    let label;
    let action = "";
    if (sale.kind === "trade" && (sale.status === "hold" || sale.status === "completed")) {
      if (sale.paidAt) {
        state = "done";
        label = T.tradeDealDone;
      } else {
        state = "ready";
        label = T.tradeDealStatus;
        action = `<a class="btn-small" href="${esc(T.tradeUrl || "/trade")}">${esc(T.tradeDealBtn)}</a>`;
      }
    } else if (sale.paidAt) {
      // Гроші вже переказані — кнопки виводу немає, інакше клієнт попросить
      // виплату вдруге за те саме.
      state = "done";
      label = T.paidLabel;
    } else if (sale.status === "completed") {
      const message = format(T.telegramMessageTemplate, { id: sale.id, amount: sale.totalPrice.toFixed(2) });
      const link = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(message)}`;
      state = "ready";
      label = T.unlockedStatus;
      action = `<button class="btn-small" type="button" data-telegram="${esc(link)}">${esc(T.telegramWithdrawBtn)}</button>`;
    } else if (sale.status === "hold") {
      const untilDate = sale.unlockAt ? new Date(sale.unlockAt).toLocaleDateString(T.dateLocale) : null;
      state = "hold";
      label = untilDate ? T.holdUntilPrefix + untilDate : T.holdLabel;
    } else {
      // Угода ще чекає прийняття — показуємо пряме посилання на обмін, щоб
      // клієнт знайшов його й після того, як закрив вікно продажу.
      state = "pending";
      label = T.statusLabels[sale.status] || sale.status;
      if (sale.offerId) {
        action = `<a class="deal-offer-link" href="https://steamcommunity.com/tradeoffer/${esc(
          String(sale.offerId)
        )}/" target="_blank">${esc(T.openOfferBtn)} →</a>`;
      }
    }

    return `
      <div class="deal-card is-${state}">
        <div class="deal-card-main">
          <div class="deal-items">${itemsHtml(sale.items)}</div>
          <div class="deal-meta">
            <span class="deal-pill is-${state}">${esc(label)}</span>
            <span class="card-hint">${esc(format(T.dealLineTemplate, { id: sale.id, date }))}</span>
          </div>
        </div>
        <div class="deal-card-side">
          <span class="deal-price">${money(sale.totalPrice)}</span>
          ${action}
        </div>
      </div>`;
  };

  /** Вішає відкриття Telegram на кнопки виводу всередині контейнера. */
  window.wireDealButtons = function wireDealButtons(root) {
    root.querySelectorAll("[data-telegram]").forEach((btn) => {
      btn.addEventListener("click", () => window.open(btn.getAttribute("data-telegram"), "_blank"));
    });
  };
})();
