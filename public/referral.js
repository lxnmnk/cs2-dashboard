// Вкладка "Реферали" в профілі: посилання, ставка, цифри, дохід і вивід,
// умови для стрімерів і правила (сервер — referrals.js).
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
      programEyebrow: "Реферальна програма",
      programTitle: "Запрошуй друзів — заробляй з їхніх продажів",
      programText: "Поділись посиланням: друг отримає +{bonus}% до ціни своїх скінів, а ти — до {max} з кожного його продажу. Назавжди.",
      copy: "Копіювати",
      copied: "Скопійовано",
      codeLabel: "Або код у кошику:",
      edit: "змінити",
      save: "Зберегти",
      cancel: "Скасувати",
      oldCodeNote: "Код змінено. Старі посилання теж працюють.",
      rateEyebrow: "Твоя ставка",
      rateText: "з кожного продажу твоїх друзів",
      levels: { start: "Старт", silver: "Срібло", gold: "Золото" },
      toNext: "Ще {amount} продажів друзів — і рівень «{level}», {percent}",
      maxLevel: "Найвищий рівень",
      levelFrom: "від {amount}",
      stats: ["Зароблено", "Друзів", "Продали скіни", "Сума їхніх продажів"],
      incomeTitle: "Мій дохід",
      pending: "Чекає",
      pendingHint: "7 днів захисту трейду",
      available: "Доступно",
      availableHint: "можна забрати",
      paid: "Виплачено",
      paidHint: "за весь час",
      requested: "Заявка на {amount} — чекає переказу",
      howTitle: "Як забрати гроші",
      optWalletTitle: "На гаманець",
      optWalletSub: "USDT або USDC · від {min}",
      optWalletLocked: "Ще {left} — і можна виводити. Зараз доступно {amount}.",
      optSaleTitle: "До свого продажу",
      optSaleText: "Продаєш свій скін — ми додаємо реферальні гроші до виплати за нього. Без мінімальної суми.",
      optSaleNow: "Зараз додамо {amount}",
      optSaleEmpty: "Спрацює, коли на балансі з'являться гроші",
      optSaleBtn: "Продати скін",
      optSaleHint: "У кошику постав галочку «Додати реферальні».",
      network: "Мережа",
      address: "Адреса гаманця",
      withdraw: "Вивести {amount}",
      withdrawDone: "Заявку прийнято — переказ прийде після перевірки.",
      tabs: { friends: "Друзі", accruals: "Нарахування", payouts: "Виплати" },
      friendCols: ["Друг", "З нами з", "Угод", "Сума", "Твій дохід"],
      accrualCols: ["Дата", "Друг", "Продаж", "%", "Нараховано", "Статус"],
      payoutCols: ["Дата", "Сума", "Куди", "Статус"],
      states: { pending: "чекає 7 днів", available: "нараховано", cancelled: "скасовано (відкат)" },
      payoutStates: { requested: "чекає переказу", paid: "виплачено", rejected: "відхилено" },
      toSale: "до продажу",
      empty: "Поки порожньо",
      creatorEyebrow: "Для стрімерів і каналів",
      creatorTitle: "Подай заявку на підвищену ставку",
      creatorText: "Ведеш стрім, Telegram-канал чи YouTube? Домовимось про окремі умови для твоєї аудиторії.",
      creatorPerks: ["Вища ставка з продажів твоїх глядачів", "Власний промокод з бонусом для аудиторії", "Посилання на кшталт gaben.market/твій-нік"],
      creatorBtn: "Подати заявку",
      ruleTitle: "Одне правило: запрошуй інших, а не себе",
      ruleText: "Твій другий акаунт — не реферал. Закріпити за собою свій же акаунт, акаунт друга, з яким у вас спільний Steam чи пристрій, або розсилати посилання спамом — у Steam, особистих, коментарях — це накрутка.",
      ruleWarn: "Зароблене так анулюється, разом із вже нарахованим на баланс.",
      footnote: "Відсоток рахується від суми продажів друга, тільки першого рівня. Людина закріплюється назавжди за першим посиланням чи кодом і тільки якщо ще нічого нам не продавала. Нарахування стає доступним через 7 днів після обміну, коли мине захист трейду Steam; відкат трейду його скасовує. Вивід — від {min}.",
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
      programEyebrow: "Реферальная программа",
      programTitle: "Приглашай друзей — зарабатывай с их продаж",
      programText: "Поделись ссылкой: друг получит +{bonus}% к цене своих скинов, а ты — до {max} с каждой его продажи. Навсегда.",
      copy: "Копировать",
      copied: "Скопировано",
      codeLabel: "Или код в корзине:",
      edit: "изменить",
      save: "Сохранить",
      cancel: "Отмена",
      oldCodeNote: "Код изменён. Старые ссылки тоже работают.",
      rateEyebrow: "Твоя ставка",
      rateText: "с каждой продажи твоих друзей",
      levels: { start: "Старт", silver: "Серебро", gold: "Золото" },
      toNext: "Ещё {amount} продаж друзей — и уровень «{level}», {percent}",
      maxLevel: "Высший уровень",
      levelFrom: "от {amount}",
      stats: ["Заработано", "Друзей", "Продали скины", "Сумма их продаж"],
      incomeTitle: "Мой доход",
      pending: "Ожидает",
      pendingHint: "7 дней защиты трейда",
      available: "Доступно",
      availableHint: "можно забрать",
      paid: "Выплачено",
      paidHint: "за всё время",
      requested: "Заявка на {amount} — ждёт перевода",
      howTitle: "Как забрать деньги",
      optWalletTitle: "На кошелёк",
      optWalletSub: "USDT или USDC · от {min}",
      optWalletLocked: "Ещё {left} — и можно выводить. Сейчас доступно {amount}.",
      optSaleTitle: "К своей продаже",
      optSaleText: "Продаёшь свой скин — мы добавляем реферальные деньги к выплате за него. Без минимальной суммы.",
      optSaleNow: "Сейчас добавим {amount}",
      optSaleEmpty: "Сработает, когда на балансе появятся деньги",
      optSaleBtn: "Продать скин",
      optSaleHint: "В корзине поставь галочку «Добавить реферальные».",
      network: "Сеть",
      address: "Адрес кошелька",
      withdraw: "Вывести {amount}",
      withdrawDone: "Заявка принята — перевод придёт после проверки.",
      tabs: { friends: "Друзья", accruals: "Начисления", payouts: "Выплаты" },
      friendCols: ["Друг", "С нами с", "Сделок", "Сумма", "Твой доход"],
      accrualCols: ["Дата", "Друг", "Продажа", "%", "Начислено", "Статус"],
      payoutCols: ["Дата", "Сумма", "Куда", "Статус"],
      states: { pending: "ждёт 7 дней", available: "начислено", cancelled: "отменено (откат)" },
      payoutStates: { requested: "ждёт перевода", paid: "выплачено", rejected: "отклонено" },
      toSale: "к продаже",
      empty: "Пока пусто",
      creatorEyebrow: "Для стримеров и каналов",
      creatorTitle: "Подай заявку на повышенную ставку",
      creatorText: "Ведёшь стрим, Telegram-канал или YouTube? Договоримся об отдельных условиях для твоей аудитории.",
      creatorPerks: ["Ставка выше с продаж твоих зрителей", "Личный промокод с бонусом для аудитории", "Ссылка вида gaben.market/твой-ник"],
      creatorBtn: "Подать заявку",
      ruleTitle: "Одно правило: приглашай других, а не себя",
      ruleText: "Твой второй аккаунт — не реферал. Закрепить за собой свой же аккаунт, аккаунт друга, с которым у вас общий Steam или устройство, или рассылать ссылки спамом — в Steam, личке, комментариях — это накрутка.",
      ruleWarn: "Заработанное так аннулируется, вместе с уже начисленным на баланс.",
      footnote: "Процент считается от суммы продаж друга, только первого уровня. Человек закрепляется навсегда за первой ссылкой или кодом и только если ещё ничего нам не продавал. Начисление становится доступным через 7 дней после обмена, когда пройдёт защита трейда Steam; откат трейда его отменяет. Вывод — от {min}.",
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
      programEyebrow: "Referral program",
      programTitle: "Invite friends — earn from their sales",
      programText: "Share your link: a friend gets +{bonus}% on the price of their skins, and you get up to {max} of every sale they make. For good.",
      copy: "Copy",
      copied: "Copied",
      codeLabel: "Or the code in the cart:",
      edit: "change",
      save: "Save",
      cancel: "Cancel",
      oldCodeNote: "Code changed. Old links keep working.",
      rateEyebrow: "Your rate",
      rateText: "of every sale your friends make",
      levels: { start: "Start", silver: "Silver", gold: "Gold" },
      toNext: "{amount} more in friends' sales for {level}, {percent}",
      maxLevel: "Top level",
      levelFrom: "from {amount}",
      stats: ["Earned", "Friends", "Sold skins", "Their sales"],
      incomeTitle: "My earnings",
      pending: "Pending",
      pendingHint: "7-day trade protection",
      available: "Available",
      availableHint: "ready to take",
      paid: "Paid out",
      paidHint: "all time",
      requested: "Request for {amount} — waiting for transfer",
      howTitle: "How to get your money",
      optWalletTitle: "To a wallet",
      optWalletSub: "USDT or USDC · from {min}",
      optWalletLocked: "{left} more and you can withdraw. Available now: {amount}.",
      optSaleTitle: "Onto your own sale",
      optSaleText: "Sell one of your skins and we add your referral money to its payout. No minimum.",
      optSaleNow: "We'd add {amount} now",
      optSaleEmpty: "Works once there's money on the balance",
      optSaleBtn: "Sell a skin",
      optSaleHint: "Tick “Add your referral” in the cart.",
      network: "Network",
      address: "Wallet address",
      withdraw: "Withdraw {amount}",
      withdrawDone: "Request received — the transfer follows after a check.",
      tabs: { friends: "Friends", accruals: "Earnings", payouts: "Payouts" },
      friendCols: ["Friend", "With us since", "Deals", "Volume", "Your earnings"],
      accrualCols: ["Date", "Friend", "Sale", "%", "Earned", "Status"],
      payoutCols: ["Date", "Amount", "Where", "Status"],
      states: { pending: "waiting 7 days", available: "earned", cancelled: "cancelled (trade reverted)" },
      payoutStates: { requested: "waiting for transfer", paid: "paid", rejected: "rejected" },
      toSale: "added to a sale",
      empty: "Nothing yet",
      creatorEyebrow: "For streamers and channels",
      creatorTitle: "Apply for a higher rate",
      creatorText: "Running a stream, a Telegram channel or YouTube? We'll agree on separate terms for your audience.",
      creatorPerks: ["A higher rate on your viewers' sales", "Your own promo code with a bonus for the audience", "A link like gaben.market/your-name"],
      creatorBtn: "Apply",
      ruleTitle: "One rule: invite others, not yourself",
      ruleText: "Your second account is not a referral. Tying your own account to yourself, or a friend's you share Steam or a device with, or spamming the link — in Steam, DMs, comments — is gaming the program.",
      ruleWarn: "Money earned that way is cancelled, including what's already on the balance.",
      footnote: "The rate applies to your friend's sales, one level only. A person is tied for good to the first link or code they used, and only if they have never sold to us before. Earnings become available 7 days after the trade, once Steam trade protection is over; a reverted trade cancels them. Withdrawals from {min}.",
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
  const T = TEXT;

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
  const SUPPORT_URL = "https://t.me/gabenmarket_support";

  // Іконки — лінійні, одним кольором з текстом картки (stroke="currentColor").
  const ICON = {
    handshake: '<path d="M11 17l2 2a1 1 0 0 0 3-3"/><path d="M14 14l2.5 2.5a1 1 0 0 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="M21 3l1 11h-2"/><path d="M3 3L2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
    gauge: '<circle cx="12" cy="12" r="10"/><path d="M12 12l4-4"/><path d="M8 16h.01M16 16h.01M12 6h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 4 4 5-6"/>',
    crown: '<path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

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
  const linkFor = (code) => `${location.origin}/${code}`;

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
      const label = btn.querySelector("span") || btn;
      const was = label.textContent;
      label.textContent = T.copied;
      setTimeout(() => (label.textContent = was), 1500);
    }
  }

  const cardHead = (iconName, eyebrow, title, tone = "") => `
    <div class="ref-head">
      <span class="ref-icon ${tone}">${icon(iconName)}</span>
      <div>
        <div class="ref-eyebrow ${tone}">${esc(eyebrow)}</div>
        ${title ? `<h3>${esc(title)}</h3>` : ""}
      </div>
    </div>`;

  // ---- Посилання і код ----
  function programHtml() {
    const link = linkFor(data.code);
    const max = pct(data.levels[data.levels.length - 1].percent);
    const codeLine = editingCode
      ? `<div class="ref-code-edit">
           <input id="refCodeInput" type="text" maxlength="20" value="${esc(data.code)}" />
           <button class="btn-small" type="button" data-ref="save-code">${esc(T.save)}</button>
           <button class="btn-small ref-alt" type="button" data-ref="cancel-code">${esc(T.cancel)}</button>
         </div>`
      : `<div class="ref-code-line">
           ${esc(T.codeLabel)}
           <button class="ref-code-chip" type="button" data-ref="copy" data-value="${esc(data.code.toUpperCase())}" title="${esc(T.copy)}">
             <span>${esc(data.code.toUpperCase())}</span>${icon("copy")}
           </button>
           <button class="ref-linkish" type="button" data-ref="edit-code">${esc(T.edit)}</button>
         </div>`;
    return `
      <div class="ref-card ref-program">
        ${cardHead("handshake", T.programEyebrow, T.programTitle)}
        <p class="ref-lead">${esc(fill(T.programText, { bonus: data.rules.friendBonusPercent, max }))}</p>
        <div class="ref-linkbox">
          <span class="ref-linkbox-icon">${icon("link")}</span>
          <code>${esc(link)}</code>
          <button class="ref-copy-btn" type="button" data-ref="copy" data-value="${esc(link)}">${icon("copy")}<span>${esc(T.copy)}</span></button>
        </div>
        ${codeLine}
        <p id="refCodeStatus" class="card-hint"></p>
      </div>`;
  }

  // ---- Ставка й рівні ----
  function rateHtml() {
    const lv = data.level;
    const next = lv.next;
    const progress = next ? Math.min(100, (data.volume / next.minVolume) * 100) : 100;
    return `
      <div class="ref-card ref-rate">
        ${cardHead("gauge", T.rateEyebrow, "")}
        <div class="ref-rate-box">
          <div class="ref-rate-value">${pct(lv.percent)}</div>
          <div class="ref-rate-text">${esc(T.rateText)}</div>
        </div>
        <div class="ref-levels-row">${data.levels
          .map(
            (l) => `<div class="ref-level-chip ${l.key === lv.key ? "is-current" : ""}">
              <b>${esc(T.levels[l.key])} · ${pct(l.percent)}</b>
              <span>${esc(fill(T.levelFrom, { amount: usdWhole(l.minVolume) }))}</span>
            </div>`
          )
          .join("")}</div>
        <div class="ref-progress"><span style="width:${progress.toFixed(1)}%"></span></div>
        <p class="card-hint">${esc(
          next
            ? fill(T.toNext, { amount: usd(next.minVolume - data.volume), level: T.levels[next.key], percent: pct(next.percent) })
            : T.maxLevel
        )}</p>
      </div>`;
  }

  function statsHtml() {
    const b = data.balance;
    const tiles = [
      ["trophy", usd(b.earned + b.pending), "is-gold"],
      ["users", data.registered, ""],
      ["check", data.sold, ""],
      ["chart", usd(data.volume), ""],
    ];
    return `<div class="ref-stats">${tiles
      .map(
        ([ic, value, tone], i) => `<div class="ref-stat">
          <span class="ref-icon">${icon(ic)}</span>
          <div><div class="ref-stat-value ${tone}">${esc(value)}</div><div class="ref-stat-label">${esc(T.stats[i])}</div></div>
        </div>`
      )
      .join("")}</div>`;
  }

  // ---- Дохід і два способи його забрати ----
  function incomeHtml() {
    const b = data.balance;
    const r = data.rules;
    const canWithdraw = b.available >= r.minWithdraw;

    const wallet = canWithdraw
      ? `<div class="ref-withdraw">
           <select id="refNetwork" aria-label="${esc(T.network)}">${NETWORKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
           <input id="refAddress" type="text" placeholder="${esc(T.address)}" />
           <button class="btn-small" type="button" data-ref="withdraw">${esc(fill(T.withdraw, { amount: usd(b.available) }))}</button>
         </div>`
      : `<div class="ref-progress"><span style="width:${Math.min(100, (b.available / r.minWithdraw) * 100).toFixed(1)}%"></span></div>
         <p class="card-hint">${esc(fill(T.optWalletLocked, { left: usd(r.minWithdraw - b.available), amount: usd(b.available) }))}</p>`;

    return `
      <div class="ref-card ref-income">
        <h3>${esc(T.incomeTitle)}</h3>
        <div class="ref-money">
          <div><div class="card-hint">${esc(T.pending)}</div><div class="ref-money-value is-pending">${usd(b.pending)}</div><div class="card-hint">${esc(T.pendingHint)}</div></div>
          <div><div class="card-hint">${esc(T.available)}</div><div class="ref-money-value is-available">${usd(b.available)}</div><div class="card-hint">${esc(T.availableHint)}</div></div>
          <div><div class="card-hint">${esc(T.paid)}</div><div class="ref-money-value">${usd(b.paid)}</div><div class="card-hint">${esc(T.paidHint)}</div></div>
        </div>
        ${b.requested > 0 ? `<p class="ref-note">${esc(fill(T.requested, { amount: usd(b.requested) }))}</p>` : ""}

        <div class="ref-how-title">${esc(T.howTitle)}</div>
        <div class="ref-options">
          <div class="ref-option">
            <div class="ref-option-head"><span class="ref-option-icon">💸</span><div>
              <div class="ref-option-title">${esc(T.optWalletTitle)}</div>
              <div class="card-hint">${esc(fill(T.optWalletSub, { min: usd(r.minWithdraw) }))}</div>
            </div></div>
            ${wallet}
            <p id="refWithdrawStatus" class="card-hint"></p>
          </div>
          <div class="ref-option is-featured">
            <div class="ref-option-head"><span class="ref-option-icon">🎁</span><div>
              <div class="ref-option-title">${esc(T.optSaleTitle)}</div>
            </div></div>
            <p class="ref-option-text">${esc(T.optSaleText)}</p>
            <p class="ref-option-now">${esc(
              b.available > 0 ? fill(T.optSaleNow, { amount: usd(b.available) }) : T.optSaleEmpty
            )}</p>
            ${
              b.available > 0
                ? `<a class="btn-small" href="${ACCOUNT_URL}">${esc(T.optSaleBtn)}</a>
                   <p class="card-hint">${esc(T.optSaleHint)}</p>`
                : ""
            }
          </div>
        </div>
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
          usd(p.amount),
          esc(p.method === "sale" ? T.toSale : (p.network || "").toUpperCase()),
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

  // ---- Стрімерам і правила ----
  function creatorHtml() {
    return `
      <div class="ref-card ref-creator">
        ${cardHead("crown", T.creatorEyebrow, T.creatorTitle, "is-gold")}
        <p class="ref-lead">${esc(T.creatorText)}</p>
        <div class="ref-perks">${T.creatorPerks.map((p) => `<div class="ref-perk">${icon("check")}<span>${esc(p)}</span></div>`).join("")}</div>
        <a class="btn-gold ref-creator-btn" href="${SUPPORT_URL}" target="_blank" rel="noopener">${icon("chat")}${esc(T.creatorBtn)}</a>
      </div>`;
  }

  function ruleHtml() {
    return `
      <div class="ref-card ref-rule">
        <span class="ref-icon is-gold">${icon("shield")}</span>
        <div>
          <h3>${esc(T.ruleTitle)}</h3>
          <p>${esc(T.ruleText)}</p>
          <p class="ref-rule-warn">${esc(T.ruleWarn)}</p>
        </div>
      </div>
      <p class="ref-footnote">${esc(fill(T.footnote, { min: usd(data.rules.minWithdraw) }))}</p>`;
  }

  function lockedHtml() {
    return `
      <div class="ref-card ref-locked">
        ${cardHead("handshake", T.programEyebrow, T.lockedTitle)}
        <p class="ref-lead">${esc(fill(T.lockedText, { bonus: data.rules.friendBonusPercent }))}</p>
        <a class="btn-small" href="${ACCOUNT_URL}">${esc(T.lockedCta)}</a>
      </div>
      ${creatorHtml()}
      ${ruleHtml()}`;
  }

  function render() {
    if (!data.eligible) {
      root.innerHTML = lockedHtml();
      return;
    }
    root.innerHTML = `
      <div class="ref-grid">${programHtml()}${rateHtml()}</div>
      ${statsHtml()}
      <div class="ref-grid">${incomeHtml()}${historyHtml()}</div>
      ${creatorHtml()}
      ${ruleHtml()}`;
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
    if (action === "edit-code" || action === "cancel-code") {
      editingCode = action === "edit-code";
      render();
      if (editingCode) document.getElementById("refCodeInput")?.focus();
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
      const done = document.getElementById("refWithdrawStatus");
      if (done) done.textContent = T.withdrawDone;
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
