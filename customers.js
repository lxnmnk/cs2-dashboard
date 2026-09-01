// Клиенты сайта (личный кабинет), которые вошли через Steam. Отдельно от
// users.json — там внутренние аккаунты владельца (lxnmnk/tarhun) для
// /arbitrage и /mytrades, тут — покупатели с публичных страниц.
const fs = require("fs");
const path = require("path");

const CUSTOMERS_FILE = path.join(__dirname, "customers.json");

function loadCustomers() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveCustomers(customers) {
  fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

// Заводит клиента при первом входе, на повторных — обновляет ник/аватар
// (они могут поменяться в Steam) и lastLoginAt.
function upsertBySteamId(steamId, profile) {
  const customers = loadCustomers();
  const now = new Date().toISOString();
  let customer = customers.find((c) => c.steamId === steamId);

  if (customer) {
    customer.displayName = profile.displayName;
    customer.avatar = profile.avatar;
    customer.profileUrl = profile.profileUrl;
    customer.lastLoginAt = now;
  } else {
    customer = {
      steamId,
      displayName: profile.displayName,
      avatar: profile.avatar,
      profileUrl: profile.profileUrl,
      createdAt: now,
      lastLoginAt: now,
    };
    customers.push(customer);
  }

  saveCustomers(customers);
  return customer;
}

function findBySteamId(steamId) {
  return loadCustomers().find((c) => c.steamId === steamId) || null;
}

module.exports = { upsertBySteamId, findBySteamId };
