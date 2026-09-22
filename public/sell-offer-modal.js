// Вікно "обмін надіслано" — спільне для кабінету ("Продати скіни") і розділу
// Trade: обидва продають предмети клієнта через Skinbux, і клієнт в обох
// випадках має бачити одне й те саме — пряме посилання саме на свій обмін,
// хто його надсилає і попередження не приймати обмін від когось іншого.
// Тримаємо в одному файлі, щоб це попередження не розʼїхалось між сторінками.
//
// Поки вікно відкрите, самі опитуємо статус угоди: щойно клієнт прийме обмін,
// вікно змінюється на "предмет отримано". Без цього воно висіло з "бот
// надішле обмін", хоча все вже сталося (скарга клієнта). Кожен запит смикає
// Skinbux, тож не частіше ніж раз на 8 с і не довше пів години — далі обмін
// однаково протухає, а угода лишається в "Моїх угодах".
(function () {
  const WATCH_INTERVAL_MS = 8000;
  const WATCH_MAX_MS = 30 * 60 * 1000;

  function esc(s) {
    return (s || "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /**
   * texts: acceptOnlyVia, openOfferBtn, offerLinkPending, waitingForAccept,
   *        scamWarning, senderTitle, steamIdLabel, levelLabel, registeredLabel,
   *        openProfile, dateLocale, receivedTitle, receivedLead, cancelledTitle,
   *        cancelledText.
   * receivedText(sale, holdDays) — готовий HTML абзацу "гроші надійдуть...":
   *        у кабінеті це холд на 7 днів, в обміні — trade-баланс одразу.
   * receivedButton — необовʼязкова кнопка під ним: { label, onClick }.
   * onFinished(sale) — угоду прийняли або скасували: сторінці час оновити
   *        інвентар і баланс (sale === null, якщо скасовано).
   */
  window.createSellOfferModal = function createSellOfferModal({
    modal,
    body,
    title,
    closeBtn,
    texts,
    receivedText,
    receivedButton,
    onFinished,
  }) {
    const T = texts || {};
    const defaultTitle = title?.textContent;
    let watchTimer = null;
    let watchGen = 0;

    function stopWatch() {
      clearTimeout(watchTimer);
      watchGen++;
    }

    function close() {
      modal.style.display = "none";
      stopWatch();
    }

    closeBtn?.addEventListener("click", close);

    function renderOffer(data) {
      const bot = data.profileDetails || {};
      const offerUrl = data.offerId ? `https://steamcommunity.com/tradeoffer/${data.offerId}/` : null;
      const profileUrl = data.steamId ? `https://steamcommunity.com/profiles/${data.steamId}` : null;
      const registered = bot.registrationDate
        ? new Date(bot.registrationDate).toLocaleDateString(T.dateLocale)
        : null;

      body.innerHTML = `
        <p class="sell-result-lead">${esc(T.acceptOnlyVia)}</p>
        ${
          offerUrl
            ? `<a class="btn-gold sell-result-open" href="${esc(offerUrl)}" target="_blank">${esc(T.openOfferBtn)}</a>
               <p class="sell-result-url">${esc(offerUrl)}</p>`
            : `<p class="card-hint">${esc(T.offerLinkPending)}</p>`
        }
        <p class="sell-result-waiting">${esc(T.waitingForAccept)}</p>
        <div class="unstable sell-result-warning">${esc(T.scamWarning)}</div>

        <h4 class="sell-result-subtitle">${esc(T.senderTitle)}</h4>
        <div class="sender-card">
          ${bot.profileImageUrl ? `<img class="sender-avatar" src="${esc(bot.profileImageUrl)}" alt="" />` : ""}
          <div class="sender-info">
            <div class="sender-name">${esc(bot.displayName || "—")}</div>
            <div class="sender-line">${esc(T.steamIdLabel)}: ${esc(data.steamId || "—")}</div>
            ${bot.level != null ? `<div class="sender-line">${esc(T.levelLabel)}: ${bot.level}</div>` : ""}
            ${registered ? `<div class="sender-line">${esc(T.registeredLabel)}: ${esc(registered)}</div>` : ""}
            ${
              profileUrl
                ? `<a class="sender-line" href="${esc(profileUrl)}" target="_blank">${esc(T.openProfile)} →</a>`
                : ""
            }
          </div>
        </div>`;
    }

    function showReceived(sale, holdDays) {
      stopWatch();
      if (title) title.textContent = T.receivedTitle || defaultTitle;
      body.innerHTML = `
        <div class="sell-received">
          <div class="sell-received-icon">✓</div>
          <p class="sell-received-lead">${esc(T.receivedLead)}</p>
          <p class="sell-received-text">${receivedText ? receivedText(sale, holdDays) : ""}</p>
          ${receivedButton ? `<button id="sellOfferDoneBtn" class="btn-gold" type="button">${esc(receivedButton.label)}</button>` : ""}
        </div>`;
      if (receivedButton) {
        document.getElementById("sellOfferDoneBtn").addEventListener("click", () => {
          close();
          receivedButton.onClick?.();
        });
      }
      onFinished?.(sale);
    }

    function showCancelled() {
      stopWatch();
      if (title) title.textContent = T.cancelledTitle || defaultTitle;
      body.innerHTML = `
        <div class="sell-received sell-received-cancelled">
          <div class="sell-received-icon">✕</div>
          <p class="sell-received-text">${esc(T.cancelledText)}</p>
        </div>`;
      onFinished?.(null);
    }

    function watch(data) {
      stopWatch();
      const gen = watchGen;
      const startedAt = Date.now();

      const tick = async () => {
        let sale = null;
        let holdDays = null;
        try {
          const res = await fetch("/api/account/sales");
          const payload = await res.json();
          sale = (payload.sales || []).find((s) => String(s.id) === String(data.id)) || null;
          holdDays = payload.holdDays;
        } catch {
          // мережа моргнула — спробуємо на наступному колі
        }
        // Вікно закрили або почався інший продаж — цей стеж більше не потрібен.
        if (gen !== watchGen) return;

        if (sale && (sale.status === "hold" || sale.status === "completed")) return showReceived(sale, holdDays);
        if (sale && (sale.status === "cancelled" || sale.status === "reverted")) return showCancelled();
        if (sale?.offerId && !data.offerId) {
          data.offerId = sale.offerId;
          renderOffer(data);
        }
        if (Date.now() - startedAt < WATCH_MAX_MS) watchTimer = setTimeout(tick, WATCH_INTERVAL_MS);
      };

      watchTimer = setTimeout(tick, WATCH_INTERVAL_MS);
    }

    return {
      show(data) {
        if (title) title.textContent = defaultTitle;
        renderOffer(data);
        modal.style.display = "flex";
        watch(data);
      },
      close,
    };
  };
})();
