// Вкладка "Реферали" в профілі: посилання й код, рівень, статистика, дохід,
// вивід і правила програми (сервер — referrals.js).
//
// Тексти тут, а не в ACCOUNT_CONFIG кожної мовної сторінки: вкладка одна й
// та сама, і три копії підписів у трьох HTML розійшлися б при першій правці.
// Мову беремо з <html lang>.
(function () {
  const LANG = { ru: "ru", en: "en" }[document.documentElement.lang] || "uk";

  const TEXT = {
    uk: {
      lockedTitle: "Твоє посилання з'явиться після першого продажу",
      lockedText: "Продай будь-який скін — і тут з'явиться твій код. Друзі за ним отримають +{bonus}% до ціни, а ти — відсоток від кожного їхнього продажу. Назавжди.",
      lockedCta: "Продати скін",
      inviteTitle: "Запросити друзів",
      yourLink: "Твоє посилання",
      yourCode: "Твій код — друг отримає +{bonus}% до ціни продажу",
      copy: "Копіювати",
      copied: "Скопійовано",
      edit: "Змінити",
      save: "Зберегти",
      cancel: "Скасувати",
      oldCodeNote: "Старі посилання теж працюють.",
      readyText: "Готовий текст",
      copyText: "Скопіювати текст",
      shareText: "Продаю скіни CS2 на gaben.market — швидко й без посередників. За моїм кодом {code} отримаєш +{bonus}% до ціни: {link}",
      discordHint: "Текст скопійовано — встав його в Discord",
      qrDownload: "Завантажити QR",
      levelTitle: "Твій рівень",
      yourPercent: "Твій відсоток",
      toNext: "До рівня «{level}» лишилось {amount} продажів друзів",
      maxLevel: "Це найвищий рівень",
      levelCol: "Рівень",
      fromCol: "Продажі друзів",
      percentCol: "Відсоток",
      levels: { start: "Старт", silver: "Срібло", gold: "Золото" },
      from: "від {amount}",
      partnerNote: "Канал чи стрім? Напиши в Telegram — домовимось про окремі умови.",
      stats: ["Перейшли за посиланням", "Закріпились", "Продали скіни", "Сума їхніх продажів"],
      incomeTitle: "Мій дохід",
      pending: "Чекає",
      pendingHint: "7 днів захисту трейду",
      available: "Доступно",
      availableHint: "можна вивести",
      paid: "Виплачено",
      paidHint: "за весь час",
      requested: "Заявка на {amount} — чекає переказу",
      withdrawTitle: "Вивести",
      network: "Мережа",
      address: "Адреса гаманця",
      withdraw: "Вивести {amount}",
      withdrawMin: "Вивід від {min}. Або додай гроші до виплати за свій продаж — отримаєш +{bonus}% (галочка в кошику).",
      withdrawDone: "Заявку прийнято — переказ прийде після перевірки.",
      tabs: { friends: "Друзі", accruals: "Нарахування", payouts: "Виплати" },
      friendCols: ["Друг", "З нами з", "Угод", "Сума", "Твій дохід"],
      accrualCols: ["Дата", "Друг", "Продаж", "%", "Нараховано", "Статус"],
      payoutCols: ["Дата", "Сума", "Куди", "Статус"],
      states: { pending: "чекає 7 днів", available: "нараховано", cancelled: "скасовано (відкат)" },
      payoutStates: { requested: "чекає переказу", paid: "виплачено", rejected: "відхилено" },
      toSale: "до продажу (+{bonus}%)",
      empty: "Поки порожньо",
      rulesTitle: "Правила",
      rules: [
        "Ти отримуєш відсоток від суми кожного продажу людей, яких запросив. З тих, кого запросили вони, — ні.",
        "Людина закріплюється за тобою назавжди — за першим посиланням чи кодом, яким скористалась. Тільки нові клієнти: хто вже продавав нам, не закріплюється.",
        "Нарахування стає доступним через 7 днів після обміну, коли мине захист трейду Steam. Якщо обмін відкатили — нарахування скасовується.",
        "Рівень залежить від суми продажів усіх твоїх друзів. Новий відсоток діє на наступні продажі.",
        "Вивід — у USDT або USDC від {min}. Або додай гроші до виплати за свій продаж і отримай +{bonus}%.",
        "Заборонено запрошувати себе з інших акаунтів і розсилати посилання спамом — у Steam, особистих повідомленнях, коментарях. За порушення нарахування анулюються.",
      ],
      errors: {
        CODE_FORMAT: "Код — 3–20 латинських літер, цифр, дефіс або підкреслення",
        CODE_TAKEN: "Цей код уже зайнятий — спробуй інший",
        NOT_ELIGIBLE: "Код з'явиться після першого продажу",
        BELOW_MIN: "Замало для виводу",
      },
      loading: "Завантажую...",
      failed: "Не вдалося завантажити — онови сторінку",
    },
    ru: {
      lockedTitle: "Твоя ссылка появится после первой продажи",
      lockedText: "Продай любой скин — и здесь появится твой код. Друзья по нему получат +{bonus}% к цене, а ты — процент с каждой их продажи. Навсегда.",
      lockedCta: "Продать скин",
      inviteTitle: "Пригласить друзей",
      yourLink: "Твоя ссылка",
      yourCode: "Твой код — друг получит +{bonus}% к цене продажи",
      copy: "Копировать",
      copied: "Скопировано",
      edit: "Изменить",
      save: "Сохранить",
      cancel: "Отмена",
      oldCodeNote: "Старые ссылки тоже работают.",
      readyText: "Готовый текст",
      copyText: "Скопировать текст",
      shareText: "Продаю скины CS2 на gaben.market — быстро и без посредников. По моему коду {code} получишь +{bonus}% к цене: {link}",
      discordHint: "Текст скопирован — вставь его в Discord",
      qrDownload: "Скачать QR",
      levelTitle: "Твой уровень",
      yourPercent: "Твой процент",
      toNext: "До уровня «{level}» осталось {amount} продаж друзей",
      maxLevel: "Это высший уровень",
      levelCol: "Уровень",
      fromCol: "Продажи друзей",
      percentCol: "Процент",
      levels: { start: "Старт", silver: "Серебро", gold: "Золото" },
      from: "от {amount}",
      partnerNote: "Канал или стрим? Напиши в Telegram — договоримся об отдельных условиях.",
      stats: ["Перешли по ссылке", "Закрепились", "Продали скины", "Сумма их продаж"],
      incomeTitle: "Мой доход",
      pending: "Ожидает",
      pendingHint: "7 дней защиты трейда",
      available: "Доступно",
      availableHint: "можно вывести",
      paid: "Выплачено",
      paidHint: "за всё время",
      requested: "Заявка на {amount} — ждёт перевода",
      withdrawTitle: "Вывести",
      network: "Сеть",
      address: "Адрес кошелька",
      withdraw: "Вывести {amount}",
      withdrawMin: "Вывод от {min}. Или добавь деньги к выплате за свою продажу — получишь +{bonus}% (галочка в корзине).",
      withdrawDone: "Заявка принята — перевод придёт после проверки.",
      tabs: { friends: "Друзья", accruals: "Начисления", payouts: "Выплаты" },
      friendCols: ["Друг", "С нами с", "Сделок", "Сумма", "Твой доход"],
      accrualCols: ["Дата", "Друг", "Продажа", "%", "Начислено", "Статус"],
      payoutCols: ["Дата", "Сумма", "Куда", "Статус"],
      states: { pending: "ждёт 7 дней", available: "начислено", cancelled: "отменено (откат)" },
      payoutStates: { requested: "ждёт перевода", paid: "выплачено", rejected: "отклонено" },
      toSale: "к продаже (+{bonus}%)",
      empty: "Пока пусто",
      rulesTitle: "Правила",
      rules: [
        "Ты получаешь процент с суммы каждой продажи людей, которых пригласил. С тех, кого пригласили они, — нет.",
        "Человек закрепляется за тобой навсегда — по первой ссылке или коду, которым воспользовался. Только новые клиенты: кто уже продавал нам, не закрепляется.",
        "Начисление становится доступным через 7 дней после обмена, когда пройдёт защита трейда Steam. Если обмен откатили — начисление отменяется.",
        "Уровень зависит от суммы продаж всех твоих друзей. Новый процент действует на следующие продажи.",
        "Вывод — в USDT или USDC от {min}. Или добавь деньги к выплате за свою продажу и получи +{bonus}%.",
        "Запрещено приглашать себя с других аккаунтов и рассылать ссылки спамом — в Steam, личных сообщениях, комментариях. За нарушения начисления аннулируются.",
      ],
      errors: {
        CODE_FORMAT: "Код — 3–20 латинских букв, цифр, дефис или подчёркивание",
        CODE_TAKEN: "Этот код уже занят — попробуй другой",
        NOT_ELIGIBLE: "Код появится после первой продажи",
        BELOW_MIN: "Слишком мало для вывода",
      },
      loading: "Загружаю...",
      failed: "Не удалось загрузить — обнови страницу",
    },
    en: {
      lockedTitle: "Your link appears after your first sale",
      lockedText: "Sell any skin and your code shows up here. Friends get +{bonus}% on their price with it, and you get a cut of every sale they make. For good.",
      lockedCta: "Sell a skin",
      inviteTitle: "Invite friends",
      yourLink: "Your link",
      yourCode: "Your code — a friend gets +{bonus}% on their sale price",
      copy: "Copy",
      copied: "Copied",
      edit: "Change",
      save: "Save",
      cancel: "Cancel",
      oldCodeNote: "Old links keep working.",
      readyText: "Ready-made message",
      copyText: "Copy message",
      shareText: "I sell my CS2 skins on gaben.market — fast, no middlemen. Use my code {code} for +{bonus}% on your price: {link}",
      discordHint: "Message copied — paste it into Discord",
      qrDownload: "Download QR",
      levelTitle: "Your level",
      yourPercent: "Your rate",
      toNext: "{amount} more in friends' sales to reach {level}",
      maxLevel: "This is the top level",
      levelCol: "Level",
      fromCol: "Friends' sales",
      percentCol: "Rate",
      levels: { start: "Start", silver: "Silver", gold: "Gold" },
      from: "from {amount}",
      partnerNote: "Running a channel or a stream? Message us on Telegram for separate terms.",
      stats: ["Opened your link", "Signed up", "Sold skins", "Their sales"],
      incomeTitle: "My earnings",
      pending: "Pending",
      pendingHint: "7-day trade protection",
      available: "Available",
      availableHint: "ready to withdraw",
      paid: "Paid out",
      paidHint: "all time",
      requested: "Request for {amount} — waiting for transfer",
      withdrawTitle: "Withdraw",
      network: "Network",
      address: "Wallet address",
      withdraw: "Withdraw {amount}",
      withdrawMin: "Withdrawals from {min}. Or add the money to the payout for your own sale and get +{bonus}% (tick it in the cart).",
      withdrawDone: "Request received — the transfer follows after a check.",
      tabs: { friends: "Friends", accruals: "Earnings", payouts: "Payouts" },
      friendCols: ["Friend", "With us since", "Deals", "Volume", "Your earnings"],
      accrualCols: ["Date", "Friend", "Sale", "%", "Earned", "Status"],
      payoutCols: ["Date", "Amount", "Where", "Status"],
      states: { pending: "waiting 7 days", available: "earned", cancelled: "cancelled (trade reverted)" },
      payoutStates: { requested: "waiting for transfer", paid: "paid", rejected: "rejected" },
      toSale: "added to a sale (+{bonus}%)",
      empty: "Nothing yet",
      rulesTitle: "Rules",
      rules: [
        "You get a percentage of every sale made by people you invited. Nothing from the people they invite.",
        "A person is tied to you for good — by the first link or code they used. New clients only: someone who already sold to us can't be tied to anyone.",
        "Earnings become available 7 days after the trade, once Steam trade protection is over. If the trade is reverted, the earning is cancelled.",
        "Your level depends on the total sales of all your friends. A new rate applies to the next sales.",
        "Withdrawals in USDT or USDC from {min}. Or add the money to the payout for your own sale and get +{bonus}%.",
        "Inviting yourself from other accounts and spamming links — in Steam, DMs, comments — is not allowed. Earnings from it are cancelled.",
      ],
      errors: {
        CODE_FORMAT: "A code is 3–20 Latin letters, digits, dash or underscore",
        CODE_TAKEN: "That code is taken — try another one",
        NOT_ELIGIBLE: "Your code appears after your first sale",
        BELOW_MIN: "Not enough to withdraw yet",
      },
      loading: "Loading...",
      failed: "Couldn't load — refresh the page",
    },
  }[LANG];

  const NETWORKS = [
    ["usdt-trc20", "USDT TRC-20"],
    ["usdt-bep20", "USDT BEP-20"],
    ["usdt-erc20", "USDT ERC-20"],
    ["usdt-sol", "USDT Solana"],
    ["usdc-trc20", "USDC TRC-20"],
    ["usdc-bep20", "USDC BEP-20"],
    ["usdc-erc20", "USDC ERC-20"],
  ];
  const ACCOUNT_URL = { uk: "/account", ru: "/ru/account", en: "/en/account" }[LANG];

  const root = document.getElementById("referralRoot");
  if (!root) return;

  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  // Пороги рівнів — круглі суми, копійки там тільки заважають читати.
  const usdWhole = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  const pct = (n) => `${String(n).replace(".", LANG === "en" ? "." : ",")}%`;
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(LANG === "en" ? "en-GB" : "uk-UA") : "—");

  let data = null;
  let loaded = false;
  let tab = "friends";
  let editingCode = false;

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    if (btn) {
      const was = btn.textContent;
      btn.textContent = T.copied;
      setTimeout(() => (btn.textContent = was), 1500);
    }
  }

  const T = TEXT;
  const linkFor = (code) => `${location.origin}/${code}`;

  function lockedHtml() {
    return `
      <div class="ref-locked">
        <h3>${esc(T.lockedTitle)}</h3>
        <p class="card-hint">${esc(fill(T.lockedText, { bonus: data.rules.friendBonusPercent }))}</p>
        <a class="btn-small" href="${ACCOUNT_URL}">${esc(T.lockedCta)}</a>
      </div>
      ${levelsTableHtml(null)}
      ${rulesHtml()}`;
  }

  function levelsTableHtml(current) {
    return `
      <table class="ref-table ref-levels">
        <thead><tr><th>${esc(T.levelCol)}</th><th>${esc(T.fromCol)}</th><th>${esc(T.percentCol)}</th></tr></thead>
        <tbody>${data.levels
          .map(
            (l) => `<tr class="${current === l.key ? "is-current" : ""}"><td>${esc(T.levels[l.key])}</td><td>${esc(
              fill(T.from, { amount: usdWhole(l.minVolume) })
            )}</td><td>${pct(l.percent)}</td></tr>`
          )
          .join("")}</tbody>
      </table>`;
  }

  function rulesHtml() {
    return `
      <div class="ref-card ref-rules">
        <h3>${esc(T.rulesTitle)}</h3>
        <ol>${T.rules
          .map((r) => `<li>${esc(fill(r, { min: usd(data.rules.minWithdraw), bonus: data.rules.saleTopUpBonusPercent }))}</li>`)
          .join("")}</ol>
      </div>`;
  }

  function inviteHtml() {
    const link = linkFor(data.code);
    const text = fill(T.shareText, { code: data.code.toUpperCase(), bonus: data.rules.friendBonusPercent, link });
    const codeRow = editingCode
      ? `<input id="refCodeInput" type="text" maxlength="20" value="${esc(data.code)}" />
         <button class="btn-small" type="button" data-ref="save-code">${esc(T.save)}</button>
         <button class="btn-small ref-alt" type="button" data-ref="cancel-code">${esc(T.cancel)}</button>`
      : `<input type="text" readonly value="${esc(data.code.toUpperCase())}" />
         <button class="btn-small" type="button" data-ref="copy" data-value="${esc(data.code.toUpperCase())}">${esc(T.copy)}</button>
         <button class="btn-small ref-alt" type="button" data-ref="edit-code">${esc(T.edit)}</button>`;
    return `
      <div class="ref-card ref-invite">
        <div class="ref-invite-main">
          <h3>${esc(T.inviteTitle)}</h3>
          <label class="ref-label">${esc(T.yourLink)}</label>
          <div class="ref-row">
            <input type="text" readonly value="${esc(link)}" />
            <button class="btn-small" type="button" data-ref="copy" data-value="${esc(link)}">${esc(T.copy)}</button>
          </div>
          <label class="ref-label">${esc(fill(T.yourCode, { bonus: data.rules.friendBonusPercent }))}</label>
          <div class="ref-row">${codeRow}</div>
          <p id="refCodeStatus" class="card-hint"></p>
          <div class="ref-share">
            <a class="btn-small ref-alt" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodeURIComponent(
              link
            )}&text=${encodeURIComponent(text.replace(link, "").trim())}">Telegram</a>
            <a class="btn-small ref-alt" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
            <button class="btn-small ref-alt" type="button" data-ref="discord" data-value="${esc(text)}">Discord</button>
          </div>
          <label class="ref-label">${esc(T.readyText)}</label>
          <div class="ref-text">${esc(text)}</div>
          <button class="btn-small ref-alt" type="button" data-ref="copy" data-value="${esc(text)}">${esc(T.copyText)}</button>
          <p id="refShareStatus" class="card-hint"></p>
        </div>
        <div class="ref-qr">
          <div id="refQr" class="ref-qr-box"></div>
          <button class="btn-small ref-alt" type="button" data-ref="qr-download">${esc(T.qrDownload)}</button>
        </div>
      </div>`;
  }

  function levelHtml() {
    const lv = data.level;
    const next = lv.next;
    const progress = next ? Math.min(100, (data.volume / next.minVolume) * 100) : 100;
    return `
      <div class="ref-card ref-level">
        <div class="ref-level-head">
          <div><div class="card-hint">${esc(T.levelTitle)}</div><div class="ref-level-name">${esc(T.levels[lv.key])}</div></div>
          <div class="ref-level-right"><div class="card-hint">${esc(T.yourPercent)}</div><div class="ref-level-pct">${pct(lv.percent)}</div></div>
        </div>
        <div class="ref-progress"><span style="width:${progress.toFixed(1)}%"></span></div>
        <p class="card-hint">${esc(
          next ? fill(T.toNext, { level: T.levels[next.key], amount: usd(next.minVolume - data.volume) }) : T.maxLevel
        )}</p>
        ${levelsTableHtml(lv.key)}
        <p class="card-hint">${esc(T.partnerNote)}</p>
      </div>`;
  }

  function statsHtml() {
    const values = [data.clicks, data.registered, data.sold, usd(data.volume)];
    return `<div class="ref-stats">${T.stats
      .map((label, i) => `<div class="profile-stat"><span class="profile-stat-value">${esc(values[i])}</span><span class="profile-stat-label">${esc(label)}</span></div>`)
      .join("")}</div>`;
  }

  function incomeHtml() {
    const b = data.balance;
    const canWithdraw = b.available >= data.rules.minWithdraw;
    return `
      <div class="ref-card ref-income">
        <h3>${esc(T.incomeTitle)}</h3>
        <div class="ref-money">
          <div><div class="card-hint">${esc(T.pending)}</div><div class="ref-money-value is-pending">${usd(b.pending)}</div><div class="card-hint">${esc(T.pendingHint)}</div></div>
          <div><div class="card-hint">${esc(T.available)}</div><div class="ref-money-value is-available">${usd(b.available)}</div><div class="card-hint">${esc(T.availableHint)}</div></div>
          <div><div class="card-hint">${esc(T.paid)}</div><div class="ref-money-value">${usd(b.paid)}</div><div class="card-hint">${esc(T.paidHint)}</div></div>
        </div>
        ${b.requested > 0 ? `<p class="ref-note">${esc(fill(T.requested, { amount: usd(b.requested) }))}</p>` : ""}
        <div class="ref-withdraw">
          <select id="refNetwork" aria-label="${esc(T.network)}">${NETWORKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          <input id="refAddress" type="text" placeholder="${esc(T.address)}" />
          <button class="btn-small" type="button" data-ref="withdraw" ${canWithdraw ? "" : "disabled"}>${esc(
            fill(T.withdraw, { amount: usd(b.available) })
          )}</button>
        </div>
        <p id="refWithdrawStatus" class="card-hint">${esc(
          fill(T.withdrawMin, { min: usd(data.rules.minWithdraw), bonus: data.rules.saleTopUpBonusPercent })
        )}</p>
      </div>`;
  }

  function tableHtml(cols, rows) {
    if (!rows.length) return `<p class="card-hint">${esc(T.empty)}</p>`;
    return `<table class="ref-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  }

  function historyHtml() {
    let body;
    if (tab === "friends") {
      body = tableHtml(
        T.friendCols,
        data.friends.map((f) => [esc(f.name), date(f.since), f.deals, usd(f.volume), usd(f.income)])
      );
    } else if (tab === "accruals") {
      body = tableHtml(
        T.accrualCols,
        data.accruals.map((a) => [date(a.at), esc(a.friend), usd(a.saleAmount), pct(a.percent), usd(a.amount), `<span class="ref-state is-${a.state}">${esc(T.states[a.state])}</span>`])
      );
    } else {
      body = tableHtml(
        T.payoutCols,
        data.payouts.map((p) => [
          date(p.createdAt),
          usd(p.amount + (p.bonus || 0)),
          esc(p.method === "sale" ? fill(T.toSale, { bonus: data.rules.saleTopUpBonusPercent }) : (p.network || "").toUpperCase()),
          esc(p.method === "sale" ? T.payoutStates.paid : T.payoutStates[p.status] || p.status),
        ])
      );
    }
    return `
      <div class="ref-card ref-history">
        <div class="ref-tabs">${Object.entries(T.tabs)
          .map(([k, label]) => `<button type="button" class="ref-tab ${tab === k ? "active" : ""}" data-ref-tab="${k}">${esc(label)}</button>`)
          .join("")}</div>
        ${body}
      </div>`;
  }

  function render() {
    if (!data.eligible) {
      root.innerHTML = lockedHtml();
      return;
    }
    root.innerHTML = `
      <div class="ref-grid">${inviteHtml()}${levelHtml()}</div>
      ${statsHtml()}
      <div class="ref-grid">${incomeHtml()}${historyHtml()}</div>
      ${rulesHtml()}`;
    drawQr();
  }

  // QR — бібліотекою з cdnjs, і лише коли вкладку відкрили: більшості людей
  // у профілі він не потрібен.
  let qrLib = null;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    if (!qrLib) {
      qrLib = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    return qrLib;
  }

  async function drawQr() {
    const box = document.getElementById("refQr");
    if (!box) return;
    try {
      await loadQrLib();
    } catch {
      box.closest(".ref-qr")?.remove();
      return;
    }
    box.innerHTML = "";
    new window.QRCode(box, { text: linkFor(data.code), width: 160, height: 160, colorDark: "#0a0c10", colorLight: "#ffffff" });
  }

  function downloadQr() {
    const box = document.getElementById("refQr");
    const canvas = box?.querySelector("canvas");
    const img = box?.querySelector("img");
    const href = canvas ? canvas.toDataURL("image/png") : img?.src;
    if (!href) return;
    const a = document.createElement("a");
    a.href = href;
    a.download = `gaben-market-${data.code}.png`;
    a.click();
  }

  async function load() {
    root.innerHTML = `<p class="card-hint">${esc(T.loading)}</p>`;
    try {
      const res = await fetch("/api/account/referral");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      data = json;
      loaded = true;
      render();
    } catch {
      root.innerHTML = `<p class="card-hint">${esc(T.failed)}</p>`;
    }
  }

  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }

  root.addEventListener("click", async (e) => {
    const tabBtn = e.target.closest("[data-ref-tab]");
    if (tabBtn) {
      tab = tabBtn.dataset.refTab;
      render();
      return;
    }
    const btn = e.target.closest("[data-ref]");
    if (!btn) return;
    const action = btn.dataset.ref;

    if (action === "copy") return copy(btn.dataset.value, btn);
    if (action === "discord") {
      await copy(btn.dataset.value);
      document.getElementById("refShareStatus").textContent = T.discordHint;
      return;
    }
    if (action === "qr-download") return downloadQr();
    if (action === "edit-code" || action === "cancel-code") {
      editingCode = action === "edit-code";
      render();
      return;
    }
    if (action === "save-code") {
      const result = await post("/api/account/referral/code", { code: document.getElementById("refCodeInput").value });
      if (!result.ok) {
        document.getElementById("refCodeStatus").textContent = T.errors[result.error] || result.error;
        return;
      }
      editingCode = false;
      await load();
      document.getElementById("refCodeStatus").textContent = T.oldCodeNote;
      return;
    }
    if (action === "withdraw") {
      btn.disabled = true;
      const result = await post("/api/account/referral/withdraw", {
        network: document.getElementById("refNetwork").value,
        address: document.getElementById("refAddress").value.trim(),
      });
      if (!result.ok) {
        btn.disabled = false;
        const status = document.getElementById("refWithdrawStatus");
        status.textContent = T.errors[result.error] || result.error;
        status.classList.add("field-error");
        return;
      }
      await load();
      document.getElementById("refWithdrawStatus").textContent = T.withdrawDone;
    }
  });

  // Вкладку відкрили — вантажимо (один раз). Посилання /profile#referral
  // відкриває її одразу.
  const tabButton = document.querySelector('.profile-tab[data-tab="referral"]');
  tabButton?.addEventListener("click", () => {
    if (!loaded) load();
  });
  // Картка профілю ширшає тільки на цій вкладці — решта задумана вузькою.
  document.querySelectorAll(".profile-tab").forEach((t) =>
    t.addEventListener("click", () =>
      document.getElementById("profileCard")?.classList.toggle("is-wide", t.dataset.tab === "referral")
    )
  );
  if (location.hash === "#referral") {
    const open = () => tabButton?.click();
    // Профіль показується після /api/account/me — чекаємо, поки картка з'явиться.
    const card = document.getElementById("profileCard");
    if (card && card.style.display === "none") {
      new MutationObserver((_, obs) => {
        if (card.style.display !== "none") {
          obs.disconnect();
          open();
        }
      }).observe(card, { attributes: true, attributeFilter: ["style"] });
    } else open();
  }
})();
