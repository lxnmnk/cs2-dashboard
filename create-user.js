// Создаёт учётку для входа на сайт. Запускать вручную на сервере:
//   node create-user.js <username> <password>
// Открытой регистрации в самом сайте нет специально — аккаунты заводит
// только владелец сервера, чтобы посторонние из интернета не могли
// зарегистрироваться сами себе.
const { createUser } = require("./users");

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error("Использование: node create-user.js <username> <password>");
  process.exit(1);
}

createUser(username, password)
  .then((name) => {
    console.log(`Готово: пользователь "${name}" создан.`);
  })
  .catch((err) => {
    console.error("Ошибка:", err.message);
    process.exit(1);
  });
