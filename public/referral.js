// Вкладка "Реферали" в профілі (сервер — referrals.js).
//
// Будова своя, не з чужих кабінетів: головне тут — золотий купон з кодом
// (тим, чим людина ділиться; той самий стиль, що в банерах партнерів), поруч
// "сходи" ставки, під ними ланцюжок від переходів до грошей, гаманець з двома
// способами забрати зароблене, історія, смуга для стрімерів і "чесна гра".
//
// Тексти тут, а не в ACCOUNT_CONFIG кожної мовної сторінки: вкладка одна й
// та сама, і три копії підписів у трьох HTML розійшлися б при першій правці.
// Мову беремо з <html lang>.
(function () {
  const LANG = { ru: "ru", en: "en" }[document.documentElement.lang] || "uk";

  const TEXT = {
    uk: {
      couponTop: "Твій код для друзів",
      couponLocked: "Код з'явиться після першого продажу",
      couponPerk: "Друг отримує +{bonus}% до ціни · ти — до {max} з кожного його продажу",
      copyLink: "Копіювати посилання",
      copy: "Копіювати",
      copied: "Скопійовано",
      changeCode: "Змінити код",
      save: "Зберегти",
      cancel: "Скасувати",
      oldCodeNote: "Код змінено. Старі посилання теж працюють.",
      lockedText: "Продай будь-який скін — і тут з'явиться твій код. Друзі за ним отримають +{bonus}% до ціни, а ти — відсоток від кожного їхнього продажу. Назавжди.",
      lockedCta: "Продати скін",
      ladderTitle: "Твоя ставка",
      ladderSub: "з кожного продажу друзів",
      youAreHere: "ти тут",
      levels: { start: "Старт", silver: "Срібло", gold: "Золото" },
      levelFrom: "від {amount}",
      toNext: "Ще {amount} продажів друзів — і {percent}",
      maxLevel: "Найвища ставка — далі тільки партнерські умови",
      flow: ["Перейшли за посиланням", "Закріпились за тобою", "Продали скіни", "Тобі нараховано"],
      flowVolume: "на суму {amount}",
      walletTitle: "Можна забрати",
      walletMeta: "Чекає {pending} · виплачено {paid}",
      walletPendingHint: "«Чекає» — 7 днів захисту трейду Steam після продажу друга.",
      requested: "Заявка на {amount} — чекає переказу",
      wayWallet: "На гаманець",
      wayWalletSub: "USDT або USDC · від {min}",
      wayWalletLocked: "Ще {left} — і можна виводити",
      waySale: "До свого продажу",
      waySaleSub: "Без мінімуму — галочка «Додати реферальні» в кошику",
      waySaleBtn: "Продати скін",
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
      empty: "Поки порожньо — поділись купоном вище",
      partnerText: "Стрімиш чи ведеш канал? Зробимо код під твою аудиторію і ставку, вищу за звичайну.",
      partnerBtn: "Написати в Telegram",
      fairTitle: "Чесна гра",
      fairYes: "Так можна",
      fairNo: "Так не можна",
      fairYesList: ["Скинути посилання друзям і в свої чати", "Розповісти про сайт на стрімі чи в каналі", "Додати код в опис свого профілю Steam"],
      fairNoList: ["Закріплювати свої другі акаунти чи акаунти з того ж пристрою", "Спамити посиланням у Steam, особистих і коментарях", "Обіцяти від нашого імені те, чого ми не даємо, — «гарантовано дорожче за всіх»"],
      fairNote: "За порушення зароблене анулюється — разом із уже нарахованим.",
      termsTitle: "Усі умови",
      terms: [
        "Ти отримуєш відсоток від суми кожного продажу людей, яких запросив. З тих, кого запросили вони, — ні.",
        "Людина закріплюється за тобою назавжди — за першим посиланням чи кодом, яким скористалась. Тільки нові клієнти: хто вже продавав нам, не закріплюється.",
        "Нарахування стає доступним через 7 днів після обміну, коли мине захист трейду Steam. Якщо обмін відкатили — нарахування скасовується.",
        "Ставка залежить від суми продажів усіх твоїх друзів. Нова ставка діє на наступні продажі.",
        "Вивід на гаманець — у USDT або USDC від {min}. До виплати за свій продаж — будь-яка сума.",
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
      couponTop: "Твой код для друзей",
      couponLocked: "Код появится после первой продажи",
      couponPerk: "Друг получает +{bonus}% к цене · ты — до {max} с каждой его продажи",
      copyLink: "Копировать ссылку",
      copy: "Копировать",
      copied: "Скопировано",
      changeCode: "Изменить код",
      save: "Сохранить",
      cancel: "Отмена",
      oldCodeNote: "Код изменён. Старые ссылки тоже работают.",
      lockedText: "Продай любой скин — и здесь появится твой код. Друзья по нему получат +{bonus}% к цене, а ты — процент с каждой их продажи. Навсегда.",
      lockedCta: "Продать скин",
      ladderTitle: "Твоя ставка",
      ladderSub: "с каждой продажи друзей",
      youAreHere: "ты здесь",
      levels: { start: "Старт", silver: "Серебро", gold: "Золото" },
      levelFrom: "от {amount}",
      toNext: "Ещё {amount} продаж друзей — и {percent}",
      maxLevel: "Высшая ставка — дальше только партнёрские условия",
      flow: ["Перешли по ссылке", "Закрепились за тобой", "Продали скины", "Тебе начислено"],
      flowVolume: "на сумму {amount}",
      walletTitle: "Можно забрать",
      walletMeta: "Ожидает {pending} · выплачено {paid}",
      walletPendingHint: "«Ожидает» — 7 дней защиты трейда Steam после продажи друга.",
      requested: "Заявка на {amount} — ждёт перевода",
      wayWallet: "На кошелёк",
      wayWalletSub: "USDT или USDC · от {min}",
      wayWalletLocked: "Ещё {left} — и можно выводить",
      waySale: "К своей продаже",
      waySaleSub: "Без минимума — галочка «Добавить реферальные» в корзине",
      waySaleBtn: "Продать скин",
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
      empty: "Пока пусто — поделись купоном выше",
      partnerText: "Стримишь или ведёшь канал? Сделаем код под твою аудиторию и ставку выше обычной.",
      partnerBtn: "Написать в Telegram",
      fairTitle: "Честная игра",
      fairYes: "Так можно",
      fairNo: "Так нельзя",
      fairYesList: ["Скинуть ссылку друзьям и в свои чаты", "Рассказать о сайте на стриме или в канале", "Добавить код в описание своего профиля Steam"],
      fairNoList: ["Закреплять свои вторые аккаунты или аккаунты с того же устройства", "Спамить ссылкой в Steam, личке и комментариях", "Обещать от нашего имени то, чего мы не даём, — «гарантированно дороже всех»"],
      fairNote: "За нарушения заработанное аннулируется — вместе с уже начисленным.",
      termsTitle: "Все условия",
      terms: [
        "Ты получаешь процент с суммы каждой продажи людей, которых пригласил. С тех, кого пригласили они, — нет.",
        "Человек закрепляется за тобой навсегда — по первой ссылке или коду, которым воспользовался. Только новые клиенты: кто уже продавал нам, не закрепляется.",
        "Начисление становится доступным через 7 дней после обмена, когда пройдёт защита трейда Steam. Если обмен откатили — начисление отменяется.",
        "Ставка зависит от суммы продаж всех твоих друзей. Новая ставка действует на следующие продажи.",
        "Вывод на кошелёк — в USDT или USDC от {min}. К выплате за свою продажу — любая сумма.",
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
      couponTop: "Your code for friends",
      couponLocked: "Your code appears after your first sale",
      couponPerk: "A friend gets +{bonus}% on price · you get up to {max} of every sale they make",
      copyLink: "Copy link",
      copy: "Copy",
      copied: "Copied",
      changeCode: "Change code",
      save: "Save",
      cancel: "Cancel",
      oldCodeNote: "Code changed. Old links keep working.",
      lockedText: "Sell any skin and your code shows up here. Friends get +{bonus}% on their price with it, and you get a cut of every sale they make. For good.",
      lockedCta: "Sell a skin",
      ladderTitle: "Your rate",
      ladderSub: "of every sale your friends make",
      youAreHere: "you",
      levels: { start: "Start", silver: "Silver", gold: "Gold" },
      levelFrom: "from {amount}",
      toNext: "{amount} more in friends' sales for {percent}",
      maxLevel: "Top rate — beyond this, only partner terms",
      flow: ["Opened your link", "Tied to you", "Sold skins", "Earned by you"],
      flowVolume: "worth {amount}",
      walletTitle: "Ready to take",
      walletMeta: "Pending {pending} · paid out {paid}",
      walletPendingHint: "“Pending” is the 7-day Steam trade protection after a friend's sale.",
      requested: "Request for {amount} — waiting for transfer",
      wayWallet: "To a wallet",
      wayWalletSub: "USDT or USDC · from {min}",
      wayWalletLocked: "{left} more and you can withdraw",
      waySale: "Onto your own sale",
      waySaleSub: "No minimum — tick “Add your referral” in the cart",
      waySaleBtn: "Sell a skin",
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
      empty: "Nothing yet — share the coupon above",
      partnerText: "Streaming or running a channel? We'll make a code for your audience and a higher rate than usual.",
      partnerBtn: "Message us on Telegram",
      fairTitle: "Fair play",
      fairYes: "Go ahead",
      fairNo: "Not allowed",
      fairYesList: ["Send the link to friends and your group chats", "Talk about the site on stream or in your channel", "Put the code in your Steam profile description"],
      fairNoList: ["Tying your own second accounts, or accounts from the same device", "Spamming the link in Steam, DMs and comments", "Promising things on our behalf we don't offer — “always pays more than anyone”"],
      fairNote: "Break these and the earnings are cancelled — including what's already on the balance.",
      termsTitle: "Full terms",
      terms: [
        "You get a percentage of every sale made by people you invited. Nothing from the people they invite.",
        "A person is tied to you for good — by the first link or code they used. New clients only: someone who already sold to us can't be tied to anyone.",
        "Earnings become available 7 days after the trade, once Steam trade protection is over. If the trade is reverted, the earning is cancelled.",
        "Your rate depends on the total sales of all your friends. A new rate applies to the next sales.",
        "Withdrawals to a wallet in USDT or USDC from {min}. Onto your own sale — any amount.",
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

  const root = document.getElementById("referralRoot");
  if (!root) return;

  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  // Пороги — круглі суми, копійки там тільки заважають читати.
  const usdWhole = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  const pct = (n) => `${String(n).replace(".", LANG === "en" ? "." : ",")}%`;
  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(LANG === "en" ? "en-GB" : "uk-UA") : "—");
  // Посилання показуємо без https:// — коротше, і на купоні так читається
  // як адреса, а копіюється все одно повне.
  const linkFor = (code) => `${location.origin}/${code}`;
  const shortLink = (code) => `${location.host}/${code}`;

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
      btn.classList.add("is-done");
      setTimeout(() => {
        btn.textContent = was;
        btn.classList.remove("is-done");
      }, 1500);
    }
  }

  // ---- Купон: код, посилання, що отримають обидва ----
  function couponHtml() {
    const max = pct(data.levels[data.levels.length - 1].percent);
    const perk = fill(T.couponPerk, { bonus: data.rules.friendBonusPercent, max });
    if (!data.eligible) {
      return `
        <div class="ref-coupon-wrap">
          <div class="ref-coupon is-locked">
            <div class="ref-coupon-top">${esc(T.couponTop)}</div>
            <div class="ref-coupon-code">? ? ? ?</div>
            <div class="ref-coupon-link">${esc(T.couponLocked)}</div>
            <div class="ref-coupon-perk">${esc(perk)}</div>
          </div>
          <p class="ref-coupon-note">${esc(fill(T.lockedText, { bonus: data.rules.friendBonusPercent }))}</p>
          <a class="btn-gold" href="${ACCOUNT_URL}">${esc(T.lockedCta)}</a>
        </div>`;
    }
    const code = data.code.toUpperCase();
    const below = editingCode
      ? `<div class="ref-code-edit">
           <input id="refCodeInput" type="text" maxlength="20" value="${esc(data.code)}" />
           <button class="btn-small" type="button" data-ref="save-code">${esc(T.save)}</button>
           <button class="btn-small ref-alt" type="button" data-ref="cancel-code">${esc(T.cancel)}</button>
         </div>`
      : `<button class="ref-linkish" type="button" data-ref="edit-code">${esc(T.changeCode)}</button>`;
    return `
      <div class="ref-coupon-wrap">
        <div class="ref-coupon">
          <div class="ref-coupon-top">${esc(T.couponTop)}</div>
          <button class="ref-coupon-code" type="button" data-ref="copy" data-value="${esc(code)}" title="${esc(T.copy)}">${esc(code)}</button>
          <div class="ref-coupon-link">${esc(shortLink(data.code))}</div>
          <button class="ref-coupon-btn" type="button" data-ref="copy" data-value="${esc(linkFor(data.code))}">${esc(T.copyLink)}</button>
          <div class="ref-coupon-perk">${esc(perk)}</div>
        </div>
        ${below}
        <p id="refCodeStatus" class="card-hint"></p>
      </div>`;
  }

  // ---- Сходи ставки: три сходинки різної висоти, своя підсвічена ----
  // Рівні — справжні сходи кольору свого металу (бронза, срібло, золото),
  // на кожній сходинці медаль з відсотком. Досягнуті — в повному кольорі,
  // недосягнуті — приглушені із замком. Під сходами шкала з бігунком:
  // скільки продали друзі і де наступна межа.
  const METALS = ["bronze", "silver", "gold"];

  // Шкала нерівна: кожен відрізок між рівнями займає однакову ширину, інакше
  // $500 із $2000 тулилися б біля самого початку.
  function trackPosition(volume) {
    const marks = data.levels.map((l) => l.minVolume);
    const seg = 100 / (marks.length - 1);
    for (let i = 0; i < marks.length - 1; i++) {
      if (volume < marks[i + 1]) return i * seg + ((volume - marks[i]) / (marks[i + 1] - marks[i])) * seg;
    }
    return 100;
  }

  function ladderHtml() {
    const lv = data.level;
    const next = lv.next;
    // levelFor на сервері віддає копію рівня, тож шукаємо свій за ключем.
    const currentIndex = data.eligible ? data.levels.findIndex((l) => l.key === lv.key) : -1;
    const pos = data.eligible ? trackPosition(data.volume) : 0;
    const marks = data.levels.map((l, i) => ({ left: (100 / (data.levels.length - 1)) * i, label: usdWhole(l.minVolume) }));
    return `
      <div class="ref-ladder">
        <div class="ref-ladder-head">
          <div class="ref-ladder-title">${esc(T.ladderTitle)}</div>
          <div class="ref-ladder-pct">${pct(lv.percent)}</div>
          <div class="ref-ladder-sub">${esc(T.ladderSub)}</div>
        </div>
        <div class="ref-stairs">${data.levels
          .map((l, i) => {
            const state = i === currentIndex ? "is-current" : i < currentIndex ? "is-reached" : "is-locked";
            return `<div class="ref-stair is-${METALS[i] || "gold"} ${state}" style="--h:${56 + i * 34}px">
              ${i === currentIndex ? `<span class="ref-stair-you">${esc(T.youAreHere)}</span>` : ""}
              <div class="ref-medal">${state === "is-locked" ? '<span class="ref-medal-lock">🔒</span>' : ""}<b>${pct(l.percent)}</b></div>
              <div class="ref-stair-block">
                <div class="ref-stair-name">${esc(T.levels[l.key])}</div>
                <div class="ref-stair-from">${esc(fill(T.levelFrom, { amount: usdWhole(l.minVolume) }))}</div>
              </div>
            </div>`;
          })
          .join("")}</div>
        <div class="ref-track">
          <div class="ref-track-line"><span style="width:${pos.toFixed(1)}%"></span></div>
          ${data.eligible ? `<div class="ref-track-knob" style="left:${pos.toFixed(1)}%"><span>${esc(usdWhole(data.volume))}</span></div>` : ""}
          ${marks.map((m) => `<div class="ref-track-mark" style="left:${m.left}%"><span>${esc(m.label)}</span></div>`).join("")}
        </div>
        <p class="ref-ladder-next">${esc(
          next ? fill(T.toNext, { amount: usd(next.minVolume - data.volume), percent: pct(next.percent) }) : T.maxLevel
        )}</p>
      </div>`;
  }

  // ---- Ланцюжок: як із переходів виходять гроші ----
  function flowHtml() {
    const b = data.balance;
    const steps = [
      [data.clicks, ""],
      [data.registered, ""],
      [data.sold, fill(T.flowVolume, { amount: usd(data.volume) })],
      [usd(b.earned + b.pending), ""],
    ];
    return `<div class="ref-flow">${steps
      .map(
        ([value, extra], i) => `<div class="ref-flow-step ${i === steps.length - 1 ? "is-money" : ""}">
          <div class="ref-flow-value">${esc(value)}</div>
          <div class="ref-flow-label">${esc(T.flow[i])}</div>
          ${extra ? `<div class="ref-flow-extra">${esc(extra)}</div>` : ""}
        </div>`
      )
      .join('<div class="ref-flow-arrow" aria-hidden="true"></div>')}</div>`;
  }

  // ---- Гаманець: скільки можна забрати і двома рядками — як ----
  function walletHtml() {
    const b = data.balance;
    const r = data.rules;
    const canWithdraw = b.available >= r.minWithdraw;
    const walletAction = canWithdraw
      ? `<div class="ref-withdraw">
           <select id="refNetwork" aria-label="${esc(T.network)}">${NETWORKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
           <input id="refAddress" type="text" placeholder="${esc(T.address)}" />
           <button class="btn-small" type="button" data-ref="withdraw">${esc(fill(T.withdraw, { amount: usd(b.available) }))}</button>
         </div>`
      : `<div class="ref-way-locked">
           <div class="ref-meter"><span style="width:${Math.min(100, (b.available / r.minWithdraw) * 100).toFixed(1)}%"></span></div>
           <span>${esc(fill(T.wayWalletLocked, { left: usd(r.minWithdraw - b.available) }))}</span>
         </div>`;
    return `
      <div class="ref-panel ref-wallet">
        <div class="ref-wallet-label">${esc(T.walletTitle)}</div>
        <div class="ref-wallet-amount">${usd(b.available)}</div>
        <div class="ref-wallet-meta">${esc(fill(T.walletMeta, { pending: usd(b.pending), paid: usd(b.paid) }))}</div>
        ${b.requested > 0 ? `<p class="ref-wallet-request">${esc(fill(T.requested, { amount: usd(b.requested) }))}</p>` : ""}
        <div class="ref-way">
          <div class="ref-way-head"><span class="ref-way-name">💸 ${esc(T.wayWallet)}</span><span class="ref-way-sub">${esc(fill(T.wayWalletSub, { min: usd(r.minWithdraw) }))}</span></div>
          ${walletAction}
          <p id="refWithdrawStatus" class="card-hint"></p>
        </div>
        <div class="ref-way">
          <div class="ref-way-head"><span class="ref-way-name">🛒 ${esc(T.waySale)}</span><span class="ref-way-sub">${esc(T.waySaleSub)}</span></div>
          ${b.available > 0 ? `<a class="btn-small" href="${ACCOUNT_URL}">${esc(T.waySaleBtn)}</a>` : ""}
        </div>
        <p class="ref-wallet-hint">${esc(T.walletPendingHint)}</p>
      </div>`;
  }

  function tableHtml(cols, rows) {
    if (!rows.length) return `<p class="ref-empty">${esc(T.empty)}</p>`;
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
      <div class="ref-panel ref-history">
        <div class="ref-seg">${Object.entries(T.tabs)
          .map(([k, label]) => `<button type="button" class="${tab === k ? "active" : ""}" data-ref-tab="${k}">${esc(label)}</button>`)
          .join("")}</div>
        ${body}
      </div>`;
  }

  // ---- Стрімерам — одна смуга, без окремої великої картки ----
  function partnerHtml() {
    return `
      <div class="ref-partner-strip">
        <span class="ref-partner-mic" aria-hidden="true">🎙️</span>
        <span>${esc(T.partnerText)}</span>
        <a class="btn-small" href="${SUPPORT_URL}" target="_blank" rel="noopener">${esc(T.partnerBtn)}</a>
      </div>`;
  }

  // ---- Чесна гра: що можна і чого не можна; повні умови — під катом ----
  function fairHtml() {
    const list = (items) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
    return `
      <div class="ref-panel ref-fair">
        <h3>${esc(T.fairTitle)}</h3>
        <div class="ref-fair-cols">
          <div class="ref-fair-col is-yes"><div class="ref-fair-label">✓ ${esc(T.fairYes)}</div>${list(T.fairYesList)}</div>
          <div class="ref-fair-col is-no"><div class="ref-fair-label">✕ ${esc(T.fairNo)}</div>${list(T.fairNoList)}</div>
        </div>
        <p class="ref-fair-note">${esc(T.fairNote)}</p>
        <details class="ref-terms">
          <summary>${esc(T.termsTitle)}</summary>
          <ol>${T.terms.map((t) => `<li>${esc(fill(t, { min: usd(data.rules.minWithdraw) }))}</li>`).join("")}</ol>
        </details>
      </div>`;
  }

  function render() {
    const hero = `<div class="ref-hero">${couponHtml()}${ladderHtml()}</div>`;
    if (!data.eligible) {
      root.innerHTML = `${hero}${partnerHtml()}${fairHtml()}`;
      return;
    }
    root.innerHTML = `
      ${hero}
      ${flowHtml()}
      <div class="ref-split">${walletHtml()}${historyHtml()}</div>
      ${partnerHtml()}
      ${fairHtml()}`;
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
