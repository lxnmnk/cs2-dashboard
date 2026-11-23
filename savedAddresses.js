// Збережені адреси для виводу в крипті (вкладка "Баланс" у профілі).
//
// Адреса прив'язана до конкретної мережі, а не до ланцюга: 0x… підходить і
// для ERC-20, і для BEP-20 за форматом, але біржа може не приймати депозит в
// іншій мережі, і такий переказ не повернеш. Тому зберегти одну адресу для
// двох мереж — це дві окремі дії людини.
//
// Файл savedAddresses.json — стан, у git не йде, на сервер не заливається.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const payoutDetails = require("./payoutDetails");

const FILE = path.join(__dirname, "savedAddresses.json");
const MAX_PER_CLIENT = 20;
const MAX_LABEL = 30;

class SavedAddressError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Биті дані не підміняємо порожнім списком: наступний запис стер би адреси
// всіх клієнтів.
function loadAll() {
  let text;
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("savedAddresses.json: неверный формат");
  return data;
}

function saveAll(data) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// EVM-адреса не залежить від регістру, Tron і Solana — залежать.
function sameAddress(network, a, b) {
  return payoutDetails.NETWORKS[network]?.chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function cleanLabel(label) {
  return String(label ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL)
    .trim();
}

const publicEntry = ({ id, network, address, label }) => ({ id, network, address, label });

function listFor(steamId) {
  const list = loadAll()[String(steamId)];
  return Array.isArray(list) ? list.map(publicEntry) : [];
}

/** Зберегти адресу. Така сама вже є в цій мережі — лише оновлюємо назву. */
function add(steamId, { network, address, label }) {
  let details;
  try {
    details = payoutDetails.parse("crypto", { network, address });
  } catch {
    throw new SavedAddressError("BAD_ADDRESS");
  }
  const id = String(steamId);
  const all = loadAll();
  const list = Array.isArray(all[id]) ? all[id] : [];
  const existing = list.find((x) => x.network === details.network && sameAddress(details.network, x.address, details.address));
  if (existing) {
    existing.label = cleanLabel(label);
  } else {
    if (list.length >= MAX_PER_CLIENT) throw new SavedAddressError("LIMIT");
    list.push({
      id: crypto.randomUUID(),
      network: details.network,
      address: details.address,
      label: cleanLabel(label),
      createdAt: new Date().toISOString(),
    });
  }
  all[id] = list;
  saveAll(all);
  return list.map(publicEntry);
}

/** Видалити свою адресу. Чужий id просто не знайдеться. */
function remove(steamId, entryId) {
  const id = String(steamId);
  const all = loadAll();
  const list = Array.isArray(all[id]) ? all[id] : [];
  const next = list.filter((x) => x.id !== String(entryId));
  if (next.length === list.length) throw new SavedAddressError("NOT_FOUND");
  if (next.length) all[id] = next;
  else delete all[id];
  saveAll(all);
  return next.map(publicEntry);
}

module.exports = { MAX_PER_CLIENT, MAX_LABEL, SavedAddressError, listFor, add, remove };
