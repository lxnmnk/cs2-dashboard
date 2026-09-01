// Источник: cs2.sh — отдаёт buff163, youpin898 и csfloat одним запросом
// Документация: https://cs2.sh/docs/introduction , https://cs2.sh/llms-full.txt
const BASE_URL = "https://api.cs2.sh";

/**
 * У Doppler/Gamma Doppler cs2.sh кладёт цены по конкретным фазам в поле
 * item.variants: { "Phase 1": {csfloat, buff, youpin, ...}, "Ruby": {...}, ... },
 * а на верхнем уровне item — усреднённую цену по всей линейке без фазы.
 * Разворачиваем variants в отдельные записи с суффиксом " - <Phase>" — тем же
 * форматом, что используют skinbux/csmoney (см. sources/skinbux.js, sources/csmoney.js),
 * чтобы фазовые строки из всех источников схлопывались в одну строку таблицы.
 */
function expandVariants(rawItems) {
  const result = {};

  for (const [name, item] of Object.entries(rawItems)) {
    result[name] = item;

    for (const [phase, variant] of Object.entries(item.variants || {})) {
      result[`${name} - ${phase}`] = variant;
    }
  }

  return result;
}

/**
 * Тянет текущие цены по ВСЕМ предметам разом.
 * GET /v1/prices/latest доступен на всех планах (включая бесплатный developer-ключ).
 * Возвращает { "AK-47 | Redline (Field-Tested)": { buff: {...}, youpin: {...}, csfloat: {...} }, ... }
 */
async function fetchCs2ShLatest(apiKey) {
  if (!apiKey) {
    throw new Error("CS2SH_API_KEY не задан в .env");
  }

  const res = await fetch(`${BASE_URL}/v1/prices/latest`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Accept-Encoding": "gzip",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`cs2.sh ответил ${res.status}: ${text}`);
  }

  const data = await res.json();
  return expandVariants(data.items || {});
}

module.exports = { fetchCs2ShLatest };
