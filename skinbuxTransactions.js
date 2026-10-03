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
    console.error(
      `[skinbux-tx] ${path} отклонён (${res.status}). Запрос:`,
      JSON.stringify(body),
      "Ответ:",
      JSON.stringify(data)
    );
    const message = data?.error?.message || `Майданчик відповів ${res.status}`;
    const err = new Error(message);
    err.code = data?.error?.code;
    // При INVALID_PRICE тут лежить їхня поточна ціна по кожному предмету:
    // details.items[] = { assetId, submittedPriceCents, currentPriceCents }.
    err.details = data?.error?.details;
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

// GET /transaction/status/:id -> { type, status } (у bulk-версии в ответе есть
// ещё id/price/steamTradeId). Путь именно /transaction/status/:id — в тексте
// документации он упоминается как "/status/:id", но это сокращение, по такому
// адресу реально отвечает 404.
async function getTransactionStatus(apiKey, id) {
  const res = await fetch(`${BASE}/transaction/status/${id}`, { headers: { "x-api-key": apiKey } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error?.message || `Майданчик відповів ${res.status}`);
  }
  return data.data;
}

function priceChangedError() {
  const err = new Error("PRICE_CHANGED");
  err.code = "PRICE_CHANGED";
  return err;
}

/**
 * requestSell, який переживає зміну ціни. Skinbux звіряє price зі своєю
 * поточною ціною, а та рухається щохвилини — між нашим читанням інвентарю й
 * запитом вона встигає з'їхати на кілька відсотків, і продаж падав з
 * INVALID_PRICE. У відповіді на таку помилку він сам називає актуальні ціни —
 * повторюємо один раз рівно з ними.
 *
 * minCentsByAsset — скільки ми вже пообіцяли клієнту за кожен предмет. Якщо
 * Skinbux тепер дає менше, не повторюємо (продали б у мінус), а кидаємо
 * PRICE_CHANGED: клієнт побачить нові ціни й вирішить сам.
 *
 * Повертає { result, items } — items з тими цінами, за якими реально продали.
 */
async function requestSellRepricing(apiKey, { items, steamId, tradeUrl }, { minCentsByAsset = {} } = {}) {
  try {
    return { result: await requestSell(apiKey, { items, steamId, tradeUrl }), items };
  } catch (err) {
    const drifted = err.message === "INVALID_PRICE" ? err.details?.items : null;
    if (!Array.isArray(drifted) || !drifted.length) throw err;

    const current = new Map(drifted.map((d) => [String(d.assetId), Number(d.currentPriceCents)]));
    const repriced = items.map((it) =>
      current.has(String(it.assetId)) ? { ...it, price: String(current.get(String(it.assetId))) } : it
    );
    if (repriced.some((it) => !Number.isFinite(Number(it.price)))) throw err;
    for (const it of repriced) {
      const min = minCentsByAsset[it.assetId];
      if (min != null && Number(it.price) < min) throw priceChangedError();
    }

    console.warn(
      "[skinbux-tx] Ціна змінилась, повторюю з цінами Skinbux:",
      drifted.map((d) => `${d.name}: ${d.submittedPriceCents} -> ${d.currentPriceCents}`).join("; ")
    );
    return { result: await requestSell(apiKey, { items: repriced, steamId, tradeUrl }), items: repriced };
  }
}

module.exports = { requestSell, requestSellRepricing, priceChangedError, getTransactionStatus };
