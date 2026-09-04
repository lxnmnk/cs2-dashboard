// Вход клиента через Steam (OpenID 2.0) — без паролей. Сам логин ключа API не
// требует, ключ (.env STEAM_API_KEY) нужен только чтобы после входа подтянуть
// ник/аватар через ISteamUser/GetPlayerSummaries.
const { RelyingParty } = require("openid");

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid";
const STEAM_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;

// SITE_BASE_URL фиксирует протокол/домен для redirect/realm (важно за nginx-
// прокси, где req.protocol всегда "http"). Если не задан — берём из запроса
// (годится для локального теста).
function baseUrl(req) {
  return process.env.SITE_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

// req.query.lang зберігається у returnUrl і Steam повертає його назад у
// query рядку колбека без змін — так /auth/steam/return дізнається, якою
// мовою був /account, з якого клієнт почав логін.
function buildRelyingParty(req) {
  const lang = ["ru", "en"].includes(req.query.lang) ? `?lang=${req.query.lang}` : "";
  const returnUrl = `${baseUrl(req)}/auth/steam/return${lang}`;
  const realm = baseUrl(req);
  return new RelyingParty(returnUrl, realm, true, false, []);
}

function startLogin(req, res) {
  const party = buildRelyingParty(req);
  party.authenticate(STEAM_OPENID_ENDPOINT, false, (err, authUrl) => {
    if (err || !authUrl) {
      res.status(500).send("Steam login is temporarily unavailable, try again later.");
      return;
    }
    res.redirect(authUrl);
  });
}

// Возвращает Promise<string steamId64> либо кидает Error, если Steam не
// подтвердил подлинность ответа.
function verifyReturn(req) {
  return new Promise((resolve, reject) => {
    const party = buildRelyingParty(req);
    party.verifyAssertion(req, (err, result) => {
      if (err) return reject(err);
      if (!result?.authenticated) return reject(new Error("Steam did not confirm the login."));
      const match = STEAM_ID_RE.exec(result.claimedIdentifier || "");
      if (!match) return reject(new Error("Could not extract SteamID from Steam's response."));
      resolve(match[1]);
    });
  });
}

async function fetchSteamProfile(steamId) {
  const apiKey = process.env.STEAM_API_KEY;
  const fallback = { displayName: `Steam user ${steamId}`, avatar: null, profileUrl: `https://steamcommunity.com/profiles/${steamId}` };
  if (!apiKey) return fallback;

  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`;
    const resp = await fetch(url);
    if (!resp.ok) return fallback;
    const data = await resp.json();
    const player = data?.response?.players?.[0];
    if (!player) return fallback;
    return {
      displayName: player.personaname || fallback.displayName,
      avatar: player.avatarfull || player.avatarmedium || player.avatar || null,
      profileUrl: player.profileurl || fallback.profileUrl,
    };
  } catch {
    return fallback;
  }
}

module.exports = { startLogin, verifyReturn, fetchSteamProfile };
