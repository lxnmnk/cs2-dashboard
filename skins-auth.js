// Записать вход skins.com в .env из скопированного cURL.
//
// В браузере на skins.com/inventory: Network → запрос inventory?... →
// Copy as cURL (bash), вставить целиком в curl.txt рядом с этим файлом и
// запустить
//
//   node skins-auth.js
//
// Скрипт достанет заголовок Authorization, запишет его в .env (SKINS_AUTH,
// заменив старый), удалит curl.txt — чтобы токен не остался лежать в открытом
// файле — и скажет, до какого времени он действует. Сам токен не печатает.
const fs = require("fs");
const path = require("path");

const CURL_FILE = path.join(__dirname, "curl.txt");
const ENV_FILE = path.join(__dirname, ".env");

if (!fs.existsSync(CURL_FILE)) {
  console.error("Нет файла curl.txt — вставь в него скопированный cURL и запусти снова.");
  process.exit(1);
}

const curl = fs.readFileSync(CURL_FILE, "utf8");
if (!/api\.skins\.com/.test(curl)) {
  console.error("Это не запрос к api.skins.com. Нужен inventory?... со страницы skins.com/inventory.");
  process.exit(1);
}

const authMatch = curl.match(/-H '[Aa]uthorization: ([^']+)'/);
if (!authMatch) {
  console.error("В curl.txt нет заголовка authorization. Скопируй «Copy as cURL (bash)» по запросу inventory?...");
  process.exit(1);
}
const auth = authMatch[1].trim();

const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
const kept = lines.filter((line) => !line.startsWith("SKINS_AUTH="));
while (kept.length && kept[kept.length - 1] === "") kept.pop();
kept.push(`SKINS_AUTH=${JSON.stringify(auth)}`);
fs.writeFileSync(ENV_FILE, kept.join("\n") + "\n");

fs.unlinkSync(CURL_FILE);

// Если это JWT — в нём записано, до какого времени он действует. Читаем
// только это поле, сам токен не показываем.
let expires = "неизвестно (это не JWT)";
let issued = null;
try {
  const payload = JSON.parse(Buffer.from(auth.replace(/^Bearer\s+/i, "").split(".")[1], "base64url").toString());
  if (payload.iat) issued = new Date(payload.iat * 1000).toLocaleString("ru-RU");
  if (payload.exp) {
    const at = new Date(payload.exp * 1000);
    const hours = Math.round((at - Date.now()) / 36e5);
    expires = `${at.toLocaleString("ru-RU")} (через ~${hours} ч)`;
  }
} catch {
  // не JWT — ничего страшного
}

console.log("Готово, записано в .env:");
console.log(`  SKINS_AUTH — ${auth.length} символов${/^Bearer /i.test(auth) ? ", Bearer" : ""}`);
// Дата выдачи — чтобы отличать новый вход от старого: если skins.com
// отзовёт вход раньше срока, по ней видно, тот же это токен или свежий.
if (issued) console.log(`  выдан: ${issued}`);
console.log(`  действует до: ${expires}`);
console.log("curl.txt удалён. Перезапусти сайт, если он уже запущен: pm2 restart cs2-dashboard");
