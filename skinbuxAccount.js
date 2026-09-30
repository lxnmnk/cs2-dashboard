// Баланс партнёрского аккаунта Skinbux — строка банка (capitalBank.js).
//
// Эндпоинта нет в их документации (там только /buy, /sell, /requestSell,
// /status/:id и инвентарь), но он работает и отдаёт ровно то, что нужно:
//   { "balance": 105375, "pendingBalance": 632119 }
// Оба числа в центах: balance — можно выводить сейчас, pendingBalance — ещё
// в холде (Skinbux держит деньги 7 дней после обмена, см. skinbuxSales.js).
//
// В банк идут оба: деньги в холде никуда не денутся, просто придут позже —
// ровно как предметы в трейд-бане. Но показываем их отдельной строкой, чтобы
// было видно, какая часть банка сейчас недоступна.
const BASE = "https://api.skinbux.com/v1";

async function fetchBalance(apiKey) {
  if (!apiKey) throw new Error("SKINBUX_API_KEY не задан");

  const res = await fetch(`${BASE}/account/balance`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Skinbux ответил ${res.status}: ${text.slice(0, 120)}`);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Skinbux вернул не JSON");
  }
  const data = payload?.data;
  if (!payload?.success || !data) throw new Error("Skinbux не отдал баланс");

  const available = Math.round(Number(data.balance) || 0) / 100;
  const pending = Math.round(Number(data.pendingBalance) || 0) / 100;
  return { available, pending, total: Math.round((available + pending) * 100) / 100 };
}

module.exports = { fetchBalance };
