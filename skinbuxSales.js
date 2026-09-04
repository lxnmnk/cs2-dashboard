// Журнал автоматических продаж клиентов через Skinbux (см.
// skinbuxTransactions.js) — что именно и когда ушло, чтобы вебхук
// (server.js /api/webhooks/skinbux) знал, какую запись обновлять по
// приходу статуса, и чтобы можно было свериться вручную при споре.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "skinbuxSales.json");

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveAll(sales) {
  fs.writeFileSync(FILE, JSON.stringify(sales, null, 2));
}

function record({ id, steamId, customerName, items, totalPrice, offerId, expiresAt }) {
  const sales = loadAll();
  sales.push({
    id,
    steamId,
    customerName,
    items,
    totalPrice,
    offerId,
    expiresAt,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveAll(sales);
}

function updateStatus(id, status, steamOfferId) {
  const sales = loadAll();
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return null;
  sale.status = status;
  if (steamOfferId) sale.offerId = steamOfferId;
  sale.updatedAt = new Date().toISOString();
  saveAll(sales);
  return sale;
}

module.exports = { record, updateStatus, loadAll };
