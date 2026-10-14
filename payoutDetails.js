// Реквізити виплати, які клієнт заповнює в кошику.
//
// Раніше спосіб виплати був одним словом ("card" / "crypto"), а куди саме
// слати гроші — з'ясовували в Telegram: власник писав клієнту, чекав номер
// картки, переписував його руками. Тепер людина вказує все одразу при
// продажу, і коли гроші виходять із холду, лишається тільки переказати.
//
// Дані тут чутливі: номер картки й ім'я власника. Тому:
//   * у логи вони не пишуться ніколи — тільки замаскований номер (mask);
//   * лежать поруч з угодою в skinbuxSales.json, який не йде в git;
//   * клієнт бачить свої, власник — своїх клієнтів, більше ніхто.
//
// Перевіряємо тут, а не в браузері: форму можна обійти, запит — ні.

// Список закритий: у банку, якого немає в списку, людина обирає "інший" і
// пише назву руками. Так ми не отримаємо в журналі випадковий рядок замість
// банку, але й не змусимо нікого шукати свій у чужому списку.
const BANKS = new Set(["mono", "privat24", "abank", "other"]);

// Мережі, в яких власник реально може заплатити. Помилка тут коштує грошей:
// USDT, надісланий не в ту мережу, не повернеш, — тому і список закритий, і
// адресу перевіряємо за форматом саме цієї мережі.
const NETWORKS = {
  "usdt-trc20": { label: "USDT TRC-20", chain: "tron" },
  "usdt-erc20": { label: "USDT ERC-20", chain: "evm" },
  "usdt-bep20": { label: "USDT BEP-20", chain: "evm" },
  "usdt-sol": { label: "USDT Solana", chain: "solana" },
  "usdc-trc20": { label: "USDC TRC-20", chain: "tron" },
  "usdc-erc20": { label: "USDC ERC-20", chain: "evm" },
  "usdc-bep20": { label: "USDC BEP-20", chain: "evm" },
};

// Формат адреси залежить від мережі, а не від монети: USDT і USDC в ERC-20
// живуть на одній і тій самій адресі 0x…, у TRC-20 — на T…, у Solana — base58.
const ADDRESS_RE = {
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

function digitsOf(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Перевірка номера картки за Luhn — та сама, якою перевіряють банки.
 * Ловить переставлені цифри й одруківки, тобто саме те, через що гроші
 * пішли б не туди.
 */
function luhnValid(digits) {
  if (!/^\d{16}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let n = Number(digits[15 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** "4441 **** **** 3333" — для панелі, логів і будь-якого місця, крім виплати. */
function mask(cardNumber) {
  const d = digitsOf(cardNumber);
  if (d.length < 8) return "****";
  return `${d.slice(0, 4)} **** **** ${d.slice(-4)}`;
}

/** "4441111122223333" -> "4441 1111 2222 3333", щоб переписувати не плутаючись. */
function formatCard(cardNumber) {
  const d = digitsOf(cardNumber);
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
}

/**
 * Приводить до ладу й перевіряє те, що прийшло з кошика.
 * Кидає помилку з текстом, який не соромно показати клієнту.
 */
function parse(method, raw) {
  const input = raw && typeof raw === "object" ? raw : {};

  if (method === "card") {
    const bank = String(input.bank || "").trim().toLowerCase();
    if (!BANKS.has(bank)) throw new Error("Обери банк");

    const bankName = String(input.bankName || "").trim().slice(0, 40);
    if (bank === "other" && bankName.length < 2) throw new Error("Напиши назву банку");

    const card = digitsOf(input.cardNumber);
    if (card.length !== 16) throw new Error("Номер картки — 16 цифр");
    if (!luhnValid(card)) throw new Error("Номер картки з помилкою — перевір цифри");

    // Ім'я потрібне, бо банк показує його відправнику при переказі: якщо воно
    // не збігається, переказ або не піде, або піде не тому.
    const holder = String(input.holder || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!/^[\p{L}'’-]{2,}(\s+[\p{L}'’-]{2,})+$/u.test(holder)) {
      throw new Error("Ім'я та прізвище — як на картці, двома словами");
    }

    return { method: "card", bank, bankName: bank === "other" ? bankName : "", cardNumber: card, holder };
  }

  if (method === "crypto") {
    const network = String(input.network || "").trim().toLowerCase();
    const net = NETWORKS[network];
    if (!net) throw new Error("Обери мережу");

    const address = String(input.address || "").trim();
    if (!ADDRESS_RE[net.chain].test(address)) {
      throw new Error(`Адреса не схожа на ${net.label} — перевір мережу й адресу`);
    }

    return { method: "crypto", network, address };
  }

  throw new Error("Невідомий спосіб виплати");
}

/** Один рядок для Telegram і панелі власника. */
function describe(details) {
  if (!details) return "";
  if (details.method === "card") {
    const bank = details.bank === "other" ? details.bankName : { mono: "monobank", privat24: "privat24", abank: "a-bank" }[details.bank];
    return `${bank} · ${formatCard(details.cardNumber)} · ${details.holder}`;
  }
  if (details.method === "crypto") {
    return `${NETWORKS[details.network]?.label || details.network} · ${details.address}`;
  }
  return "";
}

/** Те саме, але безпечне для логів і будь-якого спільного екрана. */
function describeMasked(details) {
  if (!details) return "";
  if (details.method === "card") return `${details.bank} · ${mask(details.cardNumber)}`;
  if (details.method === "crypto") return `${details.network} · ${details.address.slice(0, 6)}…${details.address.slice(-4)}`;
  return "";
}

module.exports = { BANKS, NETWORKS, parse, mask, formatCard, describe, describeMasked, luhnValid };
