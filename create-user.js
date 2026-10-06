// Создаёт учётку для входа на сайт. Запускать вручную на сервере:
//   node create-user.js <username> <password> [role]
// role: пусто — обычная учётка панели, "investor" — только страница капитала
// Открытой регистрации в самом сайте нет специально — аккаунты заводит
// только владелец сервера, чтобы посторонние из интернета не могли
// зарегистрироваться сами себе.
const { createUser } = require("./users");

const [, , username, password, role] = process.argv;

if (!username || !password) {
  console.error("Использование: node create-user.js <username> <password> [investor]");
  process.exit(1);
}

createUser(username, password, role || null)
  .then((name) => {
    console.log(`Готово: пользователь "${name}" создан${role ? ` с ролью "${role}"` : ""}.`);
  })
  .catch((err) => {
    console.error("Ошибка:", err.message);
    process.exit(1);
  });
