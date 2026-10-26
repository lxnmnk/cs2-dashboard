// Источник: skinbux — https://api.skinbux.com/v1/prices
// Документация: https://documenter.getpostman.com/view/4148020/2sAXjF8uax
// Авторизация: заголовок x-api-key
//
// 17.08.2026: skinbux поменял формат ответа — поля sellPrice/sell_accept/
// rawSellPrice, которые раньше были подтверждены (сверкой с эталонным виджетом)
// как "цена, за которую ОНИ покупают у вас", из ответа ПРОПАЛИ. Остались только
// buyPrice/buy_accept, и теперь buyPrice — это и есть цена, за которую skinbux
// выкупает предмет у вас (bid). Сверено владельцем с ценой продажи на
// skinbux.com 26.10.2026, перед тем как csfloat-bot начал ставить по ней ордера
// (автобай, см. autobuyFeed.js).
//
// Формат ответа: { name, phase, buyPrice, buy_accept, appId }
// buyPrice — в ЦЕНТАХ. 100000000 — служебное значение "недоступно".
// buy_accept показывает, реально ли сейчас можно продать этот предмет.
const URL = "https://api.skinbux.com/v1/prices";
const UNAVAILABLE_SENTINEL = 100000000;

/**
 * Находит массив предметов независимо от того, как именно обёрнут ответ
 * ({ items: [...] }, { data: { items: [...] } }, { data: { prices: [...] } },
 * { data: [...] } или просто [...]).
 */
function extractItemsArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (data.data) {
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.data.items)) return data.data.items;
    if (Array.isArray(data.data.prices)) return data.data.prices;
  }
  throw new Error("неожиданный формат ответа skinbux — не найден список предметов");
}

/**
 * skinbux — по сути buyback-сервис: buyPrice/buy_accept — единственная
 * сторона, которую сейчас отдаёт API (см. предупреждение выше про смену
 * формата 17.08.2026) — используем как bid (цену инстант-выкупа).
 *
 * Для Doppler/Gamma Doppler в ответе бывает несколько записей с одинаковым
 * name, но разным полем phase (Phase 1-4, Ruby, Sapphire, Black Pearl, Emerald).
 * Чтобы такие записи не перезатирали друг друга в карте, к имени добавляется
 * суффикс " - <Phase>" — это создаёт отдельную строку в таблице для каждой фазы.
 *
 * Возвращает Map<key, { ask: null, bid }>
 */
async function fetchSkinbuxLatest(apiKey) {
  if (!apiKey) {
    throw new Error("SKINBUX_API_KEY не задан в .env");
  }

  const res = await fetch(URL, {
    headers: {
      "x-api-key": apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`skinbux ответил ${res.status}: ${text}`);
  }

  const data = await res.json();
  const items = extractItemsArray(data);
  const map = new Map();

  for (const item of items) {
    const bid =
      item.buy_accept && item.buyPrice != null && item.buyPrice > 0 && item.buyPrice < UNAVAILABLE_SENTINEL
        ? item.buyPrice / 100
        : null;

    if (bid == null) continue;

    const key = item.phase ? `${item.name} - ${item.phase}` : item.name;
    map.set(key, { ask: null, bid });
  }

  return map;
}

module.exports = { fetchSkinbuxLatest };
