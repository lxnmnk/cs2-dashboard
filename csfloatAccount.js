// Баланс аккаунта CSFloat — одна из строк банка (capitalBank.js). Берём его
// сами, чтобы не переписывать руками при каждом подсчёте прибыли.
//
// Эндпоинт /api/v1/me в публичной документации CSFloat не описан, поэтому имя
// поля с балансом ищем в нескольких местах: у них это центы, а лежать могут
// как в корне, так и внутри user. Если не нашли — честно падаем с ошибкой, и
// страница предложит вписать баланс руками, а не покажет тихий ноль.
const BASE_URL = process.env.CSFLOAT_BASE_URL || "https://csfloat.com";

const BALANCE_PATHS = ["balance", "user.balance", "user.balance_cents", "balance_cents", "user.pending_balance"];

function pick(obj, paths) {
  for (const path of paths) {
    let value = obj;
    for (const part of path.split(".")) value = value?.[part];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

async function fetchBalance(apiKey) {
  if (!apiKey) throw new Error("CSFLOAT_API_KEY не задан");

  const res = await fetch(`${BASE_URL}/api/v1/me`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CSFloat ${res.status}: ${text.slice(0, 120)}`);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("CSFloat вернул не JSON");
  }

  const cents = pick(payload, BALANCE_PATHS);
  if (cents == null) throw new Error("в ответе нет баланса — впиши руками");
  return Math.round(cents) / 100;
}

module.exports = { fetchBalance };
