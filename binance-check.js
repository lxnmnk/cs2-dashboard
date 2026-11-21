// Перевірка ключа Binance перед увімкненням автовиплат (запускати на сервері).
//
//   node binance-check.js
//     — лише читання: чи працює ключ, скільки вільно USDT/USDC, комісії й
//       мінімуми по мережах, якими платимо клієнтам.
//
//   node binance-check.js --withdraw <мережа> <адреса> <сума>
//     — ОДИН справжній тестовий вивід (наприклад, $15 на власний гаманець),
//       щоб перевірити права ключа й Travel Rule. Мережа — як у payoutDetails:
//       usdt-trc20, usdt-erc20, usdt-bep20, usdt-sol, usdc-erc20, usdc-bep20.
//       Потім скрипт хвилину стежить за статусом в історії Binance.
require("dotenv").config();
const crypto = require("crypto");
const binance = require("./binanceWallet");

(async () => {
  if (!binance.configured()) {
    console.log("В .env нет BINANCE_API_KEY / BINANCE_API_SECRET.");
    process.exit(1);
  }
  const [flag, networkId, address, amountRaw] = process.argv.slice(2);

  if (flag !== "--withdraw") {
    for (const [id, n] of Object.entries(binance.NETWORKS)) {
      const q = await binance.quote(id);
      console.log(
        q
          ? `${n.label.padEnd(12)} вывод ${q.enabled ? "открыт" : "ЗАКРЫТ"} · комиссия ${q.fee} · минимум ${q.min} · свободно ${q.free} ${n.coin}`
          : `${n.label.padEnd(12)} нет в Binance`
      );
    }
    return;
  }

  const amount = Number(amountRaw);
  if (!binance.NETWORKS[networkId] || !address || !(amount > 0)) {
    console.log("Пример: node binance-check.js --withdraw usdt-trc20 T... 15");
    process.exit(1);
  }
  const orderId = `test-${crypto.randomUUID().slice(0, 8)}`;
  const requestedAt = new Date().toISOString();
  const r = await binance.withdraw({ networkId, address, amount, orderId });
  console.log(`Вывод создан: Binance #${r.id}, orderId ${orderId}. Слежу за статусом...`);
  for (let i = 0; i < 12; i++) {
    await new Promise((ok) => setTimeout(ok, 5000));
    const f = await binance.findWithdrawal(orderId, requestedAt);
    if (f) {
      console.log(`статус ${f.status} (${f.rawStatus}) · списано ${f.amount} · комиссия ${f.fee}${f.txId ? ` · tx ${f.txId}` : ""}${f.info ? ` · ${f.info}` : ""}`);
      if (["paid", "failed", "rejected"].includes(f.status)) return;
    }
  }
  console.log("Дальше статус смотри в Binance → История выводов.");
})().catch((e) => {
  console.error("Ошибка:", e.message, e.code ? `(код ${e.code})` : "");
  process.exit(1);
});
