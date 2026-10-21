// Записать доступ к skin.place в .env из скопированного cURL.
//
// Кука сессии у skin.place — одна строка на 10-12 экранов (там же вся
// аналитика), и выделять её руками от кавычки до кавычки легко с ошибкой.
// Поэтому: в браузере Copy as cURL (bash), вставить целиком в curl.txt рядом
// с этим файлом и запустить
//
//   node skinplace-cookie.js
//
// Скрипт сам достанет куку, публичный ключ и account из адреса, запишет их
// в .env (заменив старые значения) и удалит curl.txt — чтобы кука не
// осталась лежать в открытом файле. Саму куку не печатает.
const fs = require("fs");
const path = require("path");

const CURL_FILE = path.join(__dirname, "curl.txt");
const ENV_FILE = path.join(__dirname, ".env");

if (!fs.existsSync(CURL_FILE)) {
  console.error("Нет файла curl.txt — вставь в него скопированный cURL и запусти снова.");
  process.exit(1);
}

const curl = fs.readFileSync(CURL_FILE, "utf8");

// Chrome кладёт куки либо в -b '...', либо в -H 'cookie: ...'.
const cookieMatch =
  curl.match(/(?:-b|--cookie) '([^']+)'/) || curl.match(/-H '[Cc]ookie: ([^']+)'/);
if (!cookieMatch) {
  console.error("В curl.txt не нашлось куки. Скопируй именно «Copy as cURL (bash)» по запросу inventory?project=csgo.");
  process.exit(1);
}
let cookie = cookieMatch[1].trim();
// Если XSRF-TOKEN нет среди кук, но есть в заголовке — достаточно и его:
// в куке он лежит закодированным, в заголовке раскодированным.
const xsrfHeader = curl.match(/-H '[Xx]-[Xx][Ss][Rr][Ff]-[Tt][Oo][Kk][Ee][Nn]: ([^']+)'/);
if (!/XSRF-TOKEN=/.test(cookie) && xsrfHeader) {
  cookie += `; XSRF-TOKEN=${encodeURIComponent(xsrfHeader[1].trim())}`;
}
if (!/XSRF-TOKEN=/.test(cookie)) {
  console.error("В куке нет XSRF-TOKEN — похоже, скопирован не тот запрос. Нужен inventory?project=csgo с api.skin.place.");
  process.exit(1);
}

// Ключ и account берём из адреса запроса, чтобы не переписывать руками.
// Новый Chrome пишет адрес как curl --url '...', старый — curl '...'.
const urlMatch = curl.match(/curl (?:--url )?'([^']+)'/);
let publicKey = null;
let account = null;
if (urlMatch) {
  try {
    const url = new URL(urlMatch[1]);
    publicKey = url.searchParams.get("public_key");
    const inner = new URLSearchParams((url.searchParams.get("query_params") || "").replace(/^\?/, ""));
    account = inner.get("account");
  } catch {
    // адрес не разобрался — оставим то, что уже есть в .env
  }
}

const updates = { SKINPLACE_COOKIE: cookie };
if (publicKey) updates.SKINPLACE_PUBLIC_KEY = publicKey;
if (account) updates.SKINPLACE_ACCOUNT = account;

const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
const kept = lines.filter((line) => !Object.keys(updates).some((k) => line.startsWith(`${k}=`)));
while (kept.length && kept[kept.length - 1] === "") kept.pop();
for (const [k, v] of Object.entries(updates)) kept.push(`${k}=${JSON.stringify(v)}`);
fs.writeFileSync(ENV_FILE, kept.join("\n") + "\n");

fs.unlinkSync(CURL_FILE);

console.log("Готово, записано в .env:");
console.log(`  SKINPLACE_COOKIE      — ${cookie.split(";").length} частей, XSRF-TOKEN есть`);
if (publicKey) console.log(`  SKINPLACE_PUBLIC_KEY  — ${publicKey.slice(0, 8)}…`);
if (account) console.log(`  SKINPLACE_ACCOUNT     — ${account}`);
console.log("curl.txt удалён. Перезапусти сайт, если он уже запущен: pm2 restart cs2-dashboard");
