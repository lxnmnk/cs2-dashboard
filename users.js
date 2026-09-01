// Учётки для входа на сайт (общие цены, личные сделки у каждого).
// Аккаунты создаются только вручную через create-user.js — открытой
// регистрации нет, чтобы кто угодно из интернета не мог себе завести логин.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const USERS_FILE = path.join(__dirname, "users.json");
const SALT_ROUNDS = 12;

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

async function createUser(username, password) {
  const normalized = username.trim().toLowerCase();
  if (!normalized) throw new Error("Имя пользователя не может быть пустым");
  if (!password || password.length < 8) throw new Error("Пароль должен быть не короче 8 символов");

  const users = loadUsers();
  if (users.some((u) => u.username === normalized)) {
    throw new Error(`Пользователь "${normalized}" уже существует`);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  users.push({ username: normalized, passwordHash, createdAt: new Date().toISOString() });
  saveUsers(users);
  return normalized;
}

/**
 * Возвращает username при успехе, иначе null. Намеренно не различает
 * "нет такого пользователя" и "неверный пароль" в сообщении об ошибке —
 * чтобы не давать угадывать существующие логины.
 */
async function verifyUser(username, password) {
  const normalized = (username || "").trim().toLowerCase();
  const users = loadUsers();
  const user = users.find((u) => u.username === normalized);
  if (!user) return null;

  const ok = await bcrypt.compare(password || "", user.passwordHash);
  return ok ? user.username : null;
}

function userExists(username) {
  const normalized = (username || "").trim().toLowerCase();
  return loadUsers().some((u) => u.username === normalized);
}

module.exports = { createUser, verifyUser, userExists };
