// Steam ID и трейд-ссылки — для площадок, которые показывают цены выкупа
// только по чужому инвентарю (buyoutLookup.js).

/** Номер аккаунта для трейд-ссылки из SteamID64 — простая разница, без steamid.io. */
function steamId64ToPartner(steamId64) {
  return (BigInt(String(steamId64)) - 76561197960265728n).toString();
}

/**
 * Трейд-ссылка на аккаунт. Токен площадки не проверяют — им нужен только
 * номер аккаунта, чтобы найти инвентарь; обмен по этой ссылке никто не шлёт.
 */
function tradeLinkFor(partner) {
  return `https://steamcommunity.com/tradeoffer/new/?partner=${partner}&token=qqfvz`;
}

module.exports = { steamId64ToPartner, tradeLinkFor };
