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

  // Якість з назви ("(Field-Tested)") — короткою плашкою FN/MW/FT/WW/BS, як
  // на Youpin і в каталозі; шкала зносу — смужка від FN до BS з міткою float.
  const WEAR_CODES = { "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS" };
  const wearOf = (name) => WEAR_CODES[(String(name).match(/\(([^()]+)\)(?: - [^-]+)?$/) || [])[1]] || "";
  const floatBarHtml = (f) =>
    f == null || !Number.isFinite(Number(f))
      ? ""
      : `<div class="float-bar"><span class="float-value">${Number(f).toFixed(4)}</span><span class="float-track"><i style="left:${Math.min(100, Number(f) * 100).toFixed(1)}%"></i></span></div>`;

  // Кожен предмет угоди окремим рядком, як на Youpin: картинка з плашкою
  // якості, назва, float і скільки ми платимо саме за нього. Однією сумою на
  // всю угоду було незрозуміло, що скільки коштувало. Однакові предмети —
  // одним рядком з "×N" і ціною за штуку. У старих записах немає ціни чи
  // float по предмету — тоді їх просто не показуємо.
  function itemsHtml(items) {
    const groups = new Map();
    for (const it of items) {
      const g = groups.get(it.name) || { qty: 0, sum: 0, priced: true, image: it.image, floats: [] };
      g.qty += 1;
      if (it.price != null) g.sum += Number(it.price);
      else g.priced = false;
      if (it.float != null) g.floats.push(it.float);
      groups.set(it.name, g);
    }
    return [...groups]
      .map(([name, g]) => {
        const wear = wearOf(name);
        const pic = g.image ? `<img src="${esc(g.image)}" alt="" loading="lazy" />` : "";
        const each = g.qty > 1 && g.priced ? `<span class="deal-item-each">${esc(format(RT.each, { price: money(g.sum / g.qty) }))}</span>` : "";
        return `<div class="deal-item">
          <div class="deal-item-pic">${pic}${wear ? `<span class="wear-badge wear-${wear}">${wear}</span>` : ""}</div>
          <div class="deal-item-info">
            <span class="deal-item-name">${esc(name)}${g.qty > 1 ? ` <span class="deal-qty">×${g.qty}</span>` : ""}</span>
            ${g.qty === 1 ? floatBarHtml(g.floats[0]) : ""}
          </div>
          ${g.priced ? `<div class="deal-item-price">${money(g.sum)}${each}</div>` : ""}
        </div>`;
      })
      .join("");
  }

  // ---- Відгук на угоду ----
  // Тексти тут, а не в ACCOUNT_CONFIG трьох сторінок: це один маленький
  // блок, і три копії підписів розійшлися б при першій правці.
  const RT = {
    uk: { invite: "🎁 Гроші розблоковано! Залиш будь-який відгук — отримаєш +{n}% до наступного продажу", bonusGot: "Бонус +{n}% чекає на тебе в наступному продажу", each: "по {price}", total: "Разом", leave: "★ Залишити відгук", edit: "Змінити", save: "Опублікувати", cancel: "Скасувати", placeholder: "Як пройшла угода? (необов'язково)", pick: "Обери оцінку", thanks: "Дякуємо за відгук!", hidden: "прихований модератором" },
    ru: { invite: "🎁 Деньги разблокированы! Оставь любой отзыв — получишь +{n}% к следующей продаже", bonusGot: "Бонус +{n}% ждёт тебя в следующей продаже", each: "по {price}", total: "Итого", leave: "★ Оставить отзыв", edit: "Изменить", save: "Опубликовать", cancel: "Отмена", placeholder: "Как прошла сделка? (необязательно)", pick: "Выбери оценку", thanks: "Спасибо за отзыв!", hidden: "скрыт модератором" },
    en: { invite: "🎁 Your money is unlocked! Leave any review and get +{n}% on your next sale", bonusGot: "A +{n}% bonus is waiting for your next sale", each: "{price} each", total: "Total", leave: "★ Leave a review", edit: "Edit", save: "Publish", cancel: "Cancel", placeholder: "How did the deal go? (optional)", pick: "Pick a rating", thanks: "Thanks for the review!", hidden: "hidden by a moderator" },
  }[{ ru: "ru", en: "en" }[document.documentElement.lang] || "uk"];

  const starsHtml = (n) => `<span class="deal-stars">${"★".repeat(n)}<span class="deal-stars-off">${"★".repeat(5 - n)}</span></span>`;

  // Відгук можна лишити, коли обмін прийнято: до того угоди ще не було.
  function reviewHtml(sale) {
    if (!(sale.status === "hold" || sale.status === "completed")) return "";
    if (sale.review) {
      return `<div class="deal-review" data-review-box>
        ${starsHtml(sale.review.rating)}
        ${sale.review.text ? `<span class="deal-review-text">${esc(sale.review.text)}</span>` : ""}
        ${sale.review.hidden ? `<span class="deal-review-hidden">${esc(RT.hidden)}</span>` : ""}
        <button type="button" class="deal-review-link" data-review-open data-rating="${sale.review.rating}" data-text="${esc(sale.review.text || "")}">${esc(RT.edit)}</button>
      </div>`;
    }
    // Гроші вже розморожені — запрошуємо з бонусом (сервер ставить
    // reviewBonusOffer лише на такі угоди без відгуку).
    const invite = sale.reviewBonusOffer
      ? `<div class="deal-review-invite">${esc(format(RT.invite, { n: sale.reviewBonusOffer }))}</div>`
      : "";
    return `${invite}<div class="deal-review" data-review-box data-bonus="${sale.reviewBonusOffer || ""}"><button type="button" class="deal-review-btn" data-review-open>${esc(RT.leave)}</button></div>`;
  }

  window.renderDealCard = function renderDealCard(sale, T) {
    const date = new Date(sale.createdAt).toLocaleDateString(T.dateLocale);

    // Статуси беремо як є від сервера: "hold" — обмін прийнято, гроші
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
      <div class="deal-card is-${state}" data-sale-id="${esc(String(sale.id))}">
        <div class="deal-card-main">
          <div class="deal-items">${itemsHtml(sale.items)}</div>
          <div class="deal-meta">
            <span class="deal-pill is-${state}">${esc(label)}</span>
            <span class="card-hint">${esc(format(T.dealLineTemplate, { id: sale.id, date }))}</span>
          </div>
          ${reviewHtml(sale)}
        </div>
        <div class="deal-card-side">
          <span class="deal-price"><small>${esc(RT.total)}</small>${money(sale.totalPrice)}</span>
          ${action}
        </div>
      </div>`;
  };

  /** Вішає відкриття Telegram на кнопки виводу всередині контейнера. */
  window.wireDealButtons = function wireDealButtons(root) {
    root.querySelectorAll("[data-telegram]").forEach((btn) => {
      btn.addEventListener("click", () => window.open(btn.getAttribute("data-telegram"), "_blank"));
    });
    root.querySelectorAll("[data-review-open]").forEach((btn) => btn.addEventListener("click", () => openReviewForm(btn)));
  };

  // Форма відгуку прямо в картці: п'ять зірок і поле для тексту.
  function openReviewForm(btn) {
    const box = btn.closest("[data-review-box]");
    const card = btn.closest("[data-sale-id]");
    const before = box.innerHTML;
    let rating = Number(btn.dataset.rating) || 0;
    box.innerHTML = `
      <div class="deal-review-form">
        <div class="deal-star-pick">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}">★</button>`).join("")}</div>
        <textarea maxlength="500" rows="2" placeholder="${esc(RT.placeholder)}">${esc(btn.dataset.text || "")}</textarea>
        <div class="deal-review-actions">
          <button type="button" class="btn-small" data-review-save>${esc(RT.save)}</button>
          <button type="button" class="deal-review-link" data-review-cancel>${esc(RT.cancel)}</button>
          <span class="deal-review-status"></span>
        </div>
      </div>`;
    const paint = () =>
      box.querySelectorAll("[data-star]").forEach((s) => s.classList.toggle("on", Number(s.dataset.star) <= rating));
    paint();
    box.querySelectorAll("[data-star]").forEach((s) =>
      s.addEventListener("click", () => {
        rating = Number(s.dataset.star);
        paint();
      })
    );
    box.querySelector("[data-review-cancel]").addEventListener("click", () => {
      box.innerHTML = before;
      box.querySelectorAll("[data-review-open]").forEach((b) => b.addEventListener("click", () => openReviewForm(b)));
    });
    box.querySelector("[data-review-save]").addEventListener("click", async () => {
      const status = box.querySelector(".deal-review-status");
      if (!rating) {
        status.textContent = RT.pick;
        return;
      }
      const text = box.querySelector("textarea").value.trim();
      try {
        const res = await fetch("/api/account/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ saleId: card.dataset.saleId, rating, text }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        const bonus = box.dataset.bonus;
        box.innerHTML = `${starsHtml(data.review.rating)}${
          data.review.text ? `<span class="deal-review-text">${esc(data.review.text)}</span>` : ""
        }<span class="deal-review-thanks">${esc(RT.thanks)}${bonus ? ` ${esc(format(RT.bonusGot, { n: bonus }))}` : ""}</span>`;
        // Запрошення з бонусом над формою більше не потрібне.
        box.previousElementSibling?.classList.contains("deal-review-invite") && box.previousElementSibling.remove();
        // Бонус разовий: після першого відгуку запрошення зникає з усіх угод.
        if (bonus) {
          document.querySelectorAll(".deal-review-invite").forEach((el) => el.remove());
          document.querySelectorAll("[data-review-box][data-bonus]").forEach((el) => (el.dataset.bonus = ""));
        }
      } catch (err) {
        status.textContent = err.message;
      }
    });
  }
})();
