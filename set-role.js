// Меняет роль существующей учётки. Запускать на сервере:
//   node set-role.js <username> investor   — закрыть всё, кроме капитала
//   node set-role.js <username> panel      — обычный доступ к панели
//
// Нужно, когда учётка уже создана: пересоздавать её ради роли незачем, пароль
// и его хеш остаются прежними. Роль проверяется сервером на каждом запросе,
// но сессия уже вошедшего человека не перечитывается мгновенно — после смены
// роли попроси его зайти заново (или перезапусти сервер).
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "users.json");
const [, , username, role] = process.argv;

if (!username || !role) {
  console.error("Использование: node set-role.js <username> <investor|panel>");
  process.exit(1);
}
if (!["investor", "panel"].includes(role)) {
  console.error(`Неизвестная роль "${role}". Нужно investor или panel.`);
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(FILE, "utf8"));
const user = users.find((u) => u.username === username.trim().toLowerCase());
if (!user) {
  console.error(`Пользователь "${username}" не найден. Есть такие: ${users.map((u) => u.username).join(", ")}`);
  process.exit(1);
}

user.role = role === "investor" ? "investor" : null;
fs.writeFileSync(FILE, JSON.stringify(users, null, 2));

console.log(`Готово: "${user.username}" -> ${user.role || "полный доступ к панели"}`);
console.log("\nТеперь так:");
for (const u of users) console.log(`  ${u.username} -> ${u.role || "ПОЛНЫЙ ДОСТУП к панели"}`);
