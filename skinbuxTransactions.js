// Реальные (не только цены) операции Skinbux — создание автоматического
// обмена, когда клиент продаёт скин: предмет уходит в Steam-бота Skinbux,
// деньги по факту завершения обмена приходят на баланс Skinbux владельца
// сайта (это не подтверждено официальной строкой в документации, но это
// стандартная схема партнёрского API — сам предмет физически никогда не
// попадает во внутренний инвентарь владельца, поэтому это НЕ то же самое,
// что обычная покупка в trades.js).
// Документация: https://documenter.getpostman.com/view/4148020/2sAXjF8uax
const BASE = "https://api.skinbux.com/v1";

async function call(apiKey, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const message = data?.error?.message || `Skinbux ответил ${res.status}`;
    const err = new Error(message);
    err.code = data?.error?.code;
    throw err;
  }
  return data.data;
}

/**
 * Один или несколько предметов сразу — Skinbux сам создаёт и отправляет
 * трейд клиенту (steamId) на переданный tradeUrl.
 * items: [{ assetId, name, price, phase }]
 * Возвращает { id, offerId, expires_at, steamId, profileDetails } — id это
 * ID транзакции в самом Skinbux (не steamOfferId), нужен для /status/:id и
 * для сверки с вебхуками.
 */
function requestSell(apiKey, { items, steamId, tradeUrl }) {
  return call(apiKey, "/transaction/requestSell", { items, steamId, tradeUrl });
}

async function getTransactionStatus(apiKey, id) {
  const res = await fetch(`${BASE}/status/${id}`, { headers: { "x-api-key": apiKey } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error?.message || `Skinbux ответил ${res.status}`);
  }
  return data.data;
}

module.exports = { requestSell, getTransactionStatus };
