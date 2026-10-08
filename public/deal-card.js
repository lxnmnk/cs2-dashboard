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

  function esc(s) {
    return (s || "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  window.renderDealCard = function renderDealCard(sale, T) {
    const itemsLabel = sale.items.map((it) => esc(it.name)).join(", ");
    const date = new Date(sale.createdAt).toLocaleDateString(T.dateLocale);

    // Статуси беремо як є від Skinbux: "hold" — обмін прийнято, гроші
    // заморожені на 7 днів; "completed" — вже розморожені й доступні до
    // виплати. Сторона клієнта в обміні (kind "trade") живе за іншими
    // правилами: гроші не виводяться, а лежать trade-балансом і витрачаються
    // на наші скіни. Холд на них чекаємо ми, тому клієнту тут ні дат холду,
    // ні кнопки виводу — тільки "можна забирати скіни".
    let statusHtml;
    if (sale.kind === "trade" && (sale.status === "hold" || sale.status === "completed")) {
      statusHtml = sale.paidAt
        ? `<p class="deal-status">${esc(T.tradeDealDone)}</p>`
        : `<p class="deal-status deal-status-unlocked">${esc(T.tradeDealStatus)}</p>
           <a class="btn-small" href="${esc(T.tradeUrl || "/trade")}">${esc(T.tradeDealBtn)}</a>`;
    } else if (sale.paidAt) {
      // Гроші вже переказані — кнопки виводу немає, інакше клієнт попросить
      // виплату вдруге за те саме.
      statusHtml = `<p class="deal-status">${esc(T.paidLabel)}</p>`;
    } else if (sale.status === "completed") {
      const message = format(T.telegramMessageTemplate, { id: sale.id, amount: sale.totalPrice.toFixed(2) });
      const link = `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(message)}`;
      statusHtml = `
        <p class="deal-status deal-status-unlocked">${esc(T.unlockedStatus)}</p>
        <button class="btn-small" type="button" data-telegram="${esc(link)}">${esc(T.telegramWithdrawBtn)}</button>`;
    } else if (sale.status === "hold") {
      const untilDate = sale.unlockAt ? new Date(sale.unlockAt).toLocaleDateString(T.dateLocale) : null;
      statusHtml = `<p class="deal-status">${esc(untilDate ? T.holdUntilPrefix + untilDate : T.holdLabel)}</p>`;
    } else {
      // Угода ще чекає прийняття — показуємо пряме посилання на обмін, щоб
      // клієнт знайшов його й після того, як закрив вікно продажу.
      const offerLink = sale.offerId
        ? `<a class="deal-offer-link" href="https://steamcommunity.com/tradeoffer/${esc(
            String(sale.offerId)
          )}/" target="_blank">${esc(T.openOfferBtn)} →</a>`
        : "";
      statusHtml = `<p class="deal-status">${esc(T.statusLabels[sale.status] || sale.status)}</p>${offerLink}`;
    }

    return `
      <div class="deal-card">
        <div class="deal-card-head">
          <span class="deal-items">${itemsLabel}</span>
          <span class="deal-price">$${sale.totalPrice.toFixed(2)}</span>
        </div>
        <p class="card-hint">${esc(format(T.dealLineTemplate, { id: sale.id, date }))}</p>
        ${statusHtml}
      </div>`;
  };

  /** Вішає відкриття Telegram на кнопки виводу всередині контейнера. */
  window.wireDealButtons = function wireDealButtons(root) {
    root.querySelectorAll("[data-telegram]").forEach((btn) => {
      btn.addEventListener("click", () => window.open(btn.getAttribute("data-telegram"), "_blank"));
    });
  };
})();
