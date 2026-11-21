// Float как способ отличить два одинаковых скина друг от друга.
//
// Зачем вообще: в трекере спокойно лежат две "M4A4 | Temukau (Field-Tested)",
// купленные за разные деньги. Когда приходит продажа, надо закрыть именно ту,
// которую продали, иначе прибыль по обеим строкам неверная. По названию их не
// различить, по цене продажи — тоже (Skinbux обе оценит одинаково).
//
// Что у нас есть:
//   * float покупки — отдаёт CSFloat при импорте (contract.item.float_value),
//     руками его можно вписать в форме добавления;
//   * float предметов, которые ЛЕЖАТ в инвентаре сейчас — отдаёт Skinbux
//     (inventory/user, inspect.float; у Steam этого нет вообще).
//
// Чего у нас нет: float проданного предмета. Ни /account/transactions, ни
// /transaction/status/:id его не возвращают — в транзакции только name, phase
// и price (проверено на живом аккаунте). Поэтому идём с другой стороны: если
// float позиции СОВПАЛ с предметом в инвентаре — вещь на месте, значит продали
// не её. А позиция, чьего float в инвентаре больше нет, — как раз проданная.
// Так "по флоту выбирается тот скин, который продал", хотя сама площадка float
// продажи и не сообщает.
//
// ⚠️ Чего в этом инвентаре нет: предметов в трейд-бане. Skinbux отдаёт только
// то, что можно обменять прямо сейчас — проверено на живом аккаунте, 64 из 64
// предметов пришли с tradable: true, ни одного заблокированного. Поэтому
// позиция под защитой сделки выглядит отсюда "исчезнувшей", хотя она на месте.
// Трейд-бан мы знаем сами (trades.js: customUnlockAt из CSFloat или дата
// покупки + 7 дней), и такие позиции в сверку не берём вовсе.
//
// Допуск сравнения: float приходит с полной точностью double из обоих
// источников, поэтому сравниваем жёстко. 1e-6 — только на случай, если
// где-то по пути число округлили до шестого знака; два разных предмета одного
// скина так близко не встают.
const FLOAT_EPS = 1e-6;
const { stripPhaseSuffix } = require("./itemName");

/** Предмет в трейд-бане: инвентарь Skinbux его не показывает, судить по нему нельзя. */
function isLockedPosition(trade) {
  return trade.isLocked === true;
}

/** Сколько знаков после точки в записи числа (0.1183 -> 4). */
function decimals(n) {
  const s = String(n);
  if (/e/i.test(s)) return 20;
  return (s.split(".")[1] || "").length;
}

/**
 * Тот же предмет по float. Обычно float приходит с полной точностью и
 * сравнивается жёстко (FLOAT_EPS). Но вписанный руками бывает короче —
 * "0.1183" у Bowie Knife, который в инвентаре 0.118346: тогда сравниваем с
 * точностью до последнего вписанного знака (обрезали или округлили — не
 * важно). Меньше 4 знаков — не сравниваем вольно: 0.12 подошло бы слишком
 * многим.
 */
function sameFloat(a, b) {
  if (a == null || b == null) return false;
  const d = Math.min(decimals(a), decimals(b));
  const tolerance = d < 6 && d >= 4 ? Math.pow(10, -d) : FLOAT_EPS;
  return Math.abs(Number(a) - Number(b)) < tolerance;
}

/**
 * Название предмета инвентаря так, как его пишет трекер. Skinbux отдаёт фазу
 * доплера отдельным полем, а в market_hash_name её нет; в трекере же она в
 * названии (" - Phase 2"). Без этого каждый доплер на месте выглядел
 * "проданным": имена не сходились, и float искался не там.
 */
function inventoryKey(item) {
  const name = item?.marketHashName;
  if (!name || !item.phase || !/Doppler/.test(name) || stripPhaseSuffix(name).phase) return name;
  return `${name} - ${item.phase}`;
}

/** Инвентарь -> название предмета (как в трекере): список float'ов, которые там лежат. */
function floatsByName(inventory) {
  const map = new Map();
  for (const item of inventory || []) {
    const key = inventoryKey(item);
    if (item?.float == null || !key) continue;
    const list = map.get(key) || [];
    list.push(Number(item.float));
    map.set(key, list);
  }
  return map;
}

/** Сколько предметов с таким названием вообще лежит в инвентаре (включая те,
 *  чей float Skinbux не отдал — у части предметов inspect пустой). */
function countsByName(inventory) {
  const map = new Map();
  for (const item of inventory || []) {
    const key = inventoryKey(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/**
 * Инвентарь Skinbux + то, что видит CSFloat (инвентарь и выставленные лоты).
 * Skinbux показывает не всё: предметы, выставленные на CSFloat, у него
 * пропадают (так "проданными" выходили Ursus Blue Steel, Talon Case Hardened и
 * два Huntsman Gamma Doppler, висевшие на столе). Добавляем только то, чьего
 * float в Skinbux нет, — иначе один предмет посчитался бы дважды.
 */
function mergeInventories(primary, extra) {
  if (!primary) return primary;
  const merged = [...primary];
  let added = 0;
  for (const item of extra || []) {
    if (item?.float == null || !item.marketHashName) continue;
    if (merged.some((m) => sameFloat(m.float, item.float))) continue;
    merged.push(item);
    added++;
  }
  return { items: merged, added };
}

/**
 * Делит позиции одного названия на три кучки по тому, что говорит инвентарь.
 *   held    — float позиции нашёлся в инвентаре: предмет на месте, не продан;
 *   gone    — float известен, но в инвентаре его нет: предмет ушёл;
 *   unknown — float позиции мы не знаем, сказать нечего.
 * unclaimed — float'ы из инвентаря, не привязанные ни к одной позиции (куплено
 * до трекера, чужие предметы на аккаунте и т.п.).
 *
 * inventoryFloats = null (инвентарь недоступен) — всё уходит в unknown, то
 * есть поведение остаётся прежним, FIFO.
 */
function splitByInventory(positions, inventoryFloats) {
  const pool = inventoryFloats ? [...inventoryFloats] : null;
  const held = [];
  const gone = [];
  const unknown = [];

  // Сначала точные совпадения, потом вписанные руками коротко: иначе "0.1183"
  // мог бы забрать float, который на самом деле принадлежит другой позиции.
  const strict = (a, b) => Math.abs(Number(a) - Number(b)) < FLOAT_EPS;
  const pending = [];
  for (const position of positions) {
    if (!pool || position.floatValue == null) {
      unknown.push(position);
      continue;
    }
    const at = pool.findIndex((f) => strict(f, position.floatValue));
    if (at >= 0) {
      pool.splice(at, 1);
      held.push(position);
    } else {
      pending.push(position);
    }
  }
  for (const position of pending) {
    const at = pool.findIndex((f) => sameFloat(f, position.floatValue));
    if (at >= 0) {
      pool.splice(at, 1);
      held.push(position);
    } else {
      gone.push(position);
    }
  }

  return { held, gone, unknown, unclaimed: pool || [] };
}

/**
 * Какие позиции можно дополнить float'ом из инвентаря — для старых записей и
 * ручного ввода (youpin, cs.money), где float никто не вписывал.
 *
 * Берёмся только за однозначный случай: у названия ровно одна позиция без
 * float, ровно один непривязанный предмет в инвентаре — и при этом предметов
 * в инвентаре столько же, сколько позиций в трекере. Последнее условие важно:
 * если предметов больше, часть из них трекер не знает (куплено до него,
 * отложено), и тогда непонятно, чей именно это float — вписав его, мы бы
 * пометили позицию как "вещь на месте" и больше её не закрыли. Все остальные
 * случаи уходят в ambiguous: там float вписывается руками.
 */
function planFill(rawTrades, inventory) {
  const invFloats = floatsByName(inventory);
  const invCounts = countsByName(inventory);
  const byName = new Map();
  for (const trade of rawTrades) {
    if (trade.status !== "holding") continue;
    const list = byName.get(trade.marketHashName) || [];
    list.push(trade);
    byName.set(trade.marketHashName, list);
  }

  const assignments = [];
  const ambiguous = [];

  for (const [name, all] of byName) {
    const floats = invFloats.get(name);
    if (!floats?.length) continue;
    // Заблокированной позиции float из инвентаря не принадлежит: её предмета
    // там нет, и свободный float — от какого-то другого.
    const positions = all.filter((p) => !isLockedPosition(p));
    if (!positions.length) continue;
    const { unknown, unclaimed } = splitByInventory(positions, floats);
    if (!unknown.length || !unclaimed.length) continue;

    const sameCount = positions.length === (invCounts.get(name) || 0);
    if (sameCount && unknown.length === 1 && unclaimed.length === 1) {
      assignments.push({ id: unknown[0].id, marketHashName: name, floatValue: unclaimed[0] });
    } else {
      ambiguous.push({ marketHashName: name, positions: unknown.length, items: unclaimed.length });
    }
  }

  return { assignments, ambiguous };
}

/**
 * Сверка открытых позиций с инвентарём: чего уже нет на аккаунте.
 *
 * Зачем отдельно от импорта продаж: импорт закрывает только то, что продано
 * через Skinbux. Предмет, проданный на Youpin или отданный в прямом трейде,
 * из инвентаря исчезает молча, и позиция висит открытой, завышая и "вложено",
 * и банк. Здесь мы ничего не закрываем сами — только показываем, чего нет,
 * а цену и дату продажи владелец вписывает руками.
 *
 * Как решается судьба каждой позиции:
 *   here    — float позиции нашёлся в инвентаре, предмет на месте;
 *   gone    — float известен и в инвентаре его нет; либо float неизвестен, но
 *             предметов с таким названием в инвентаре не осталось вовсе;
 *   unclear — float неизвестен, а предметы с таким названием ещё есть, и
 *             какой именно из одинаковых ушёл — не скажет никто. missing в
 *             строке говорит, скольких из них не хватает (0 — похоже, все на
 *             месте). Лечится вписанным руками float'ом.
 */
function checkHoldings(rawTrades, inventory) {
  const invFloats = floatsByName(inventory);
  const invCounts = countsByName(inventory);

  const byName = new Map();
  for (const trade of rawTrades) {
    if (trade.status !== "holding") continue;
    const list = byName.get(trade.marketHashName) || [];
    list.push(trade);
    byName.set(trade.marketHashName, list);
  }

  const rows = [];
  for (const [name, all] of byName) {
    all.sort((a, b) => new Date(a.buyDate) - new Date(b.buyDate));
    // Заблокированных в инвентаре нет по определению — ни судить о них, ни
    // считать их в сравнении количеств нельзя.
    const positions = all.filter((p) => !isLockedPosition(p));
    for (const p of all.filter(isLockedPosition)) rows.push({ ...rowOf(p), status: "locked" });
    if (!positions.length) continue;

    const { held, gone, unknown } = splitByInventory(positions, invFloats.get(name) || []);
    // Предметы с таким названием, которые ещё лежат в инвентаре и не закреплены
    // ни за одной позицией по float: только они могут оказаться "теми самыми".
    const unmatchedInv = Math.max(0, (invCounts.get(name) || 0) - held.length);

    for (const p of held) rows.push({ ...rowOf(p), status: "here" });
    for (const p of gone) rows.push({ ...rowOf(p), status: "gone", reason: "float" });

    if (!unknown.length) continue;
    if (unmatchedInv === 0) {
      // Предметов с таким названием в инвентаре не осталось — ушли все.
      for (const p of unknown) rows.push({ ...rowOf(p), status: "gone", reason: "name" });
    } else {
      const missing = Math.max(0, unknown.length - unmatchedInv);
      for (const p of unknown) rows.push({ ...rowOf(p), status: "unclear", missing, sameName: unknown.length });
    }
  }

  const count = (status) => rows.filter((r) => r.status === status).length;
  const sum = (status) =>
    round2(rows.filter((r) => r.status === status).reduce((acc, r) => acc + (Number(r.buyPrice) || 0), 0));
  return {
    rows,
    gone: count("gone"),
    goneSum: sum("gone"),
    here: count("here"),
    unclear: count("unclear"),
    unclearSum: sum("unclear"),
    // Под защитой сделки: инвентарь их не видит, поэтому мы о них молчим.
    locked: count("locked"),
    lockedSum: sum("locked"),
  };
}

/**
 * Друга думка від самого Steam перед тим, як сказати "предмета немає".
 *
 * Інвентар Skinbux показує не все: частину предметів він пропускає, і тоді
 * ножі й рукавиці, які лежать на акаунті, виходили "проданими" (так було з
 * двома Sport Gloves | Vice і Butterfly Knife | Case Hardened). Інвентар Steam
 * float не дає, зате бачить усе. Тож по кожній назві рахуємо: скільки
 * відкритих позицій і скільки таких предметів реально лежить у Steam. "Пішли"
 * можуть бути лише ті, на які предметів у Steam не вистачає; решта — на місці.
 *
 * steamItems — інвентар Steam (marketHashName без фази доплера);
 * null — Steam недоступний, звіт лишається як є.
 */
function confirmWithSteam(report, steamItems, rawTrades) {
  if (!steamItems) return report;
  const baseOf = (name) => String(name).replace(/ - (Phase \d|Ruby|Sapphire|Black Pearl|Emerald)$/, "");
  const steamCount = new Map();
  for (const it of steamItems) {
    const key = baseOf(it.marketHashName);
    steamCount.set(key, (steamCount.get(key) || 0) + 1);
  }
  const positionsByName = new Map();
  for (const t of rawTrades) {
    if (t.status !== "holding") continue;
    const key = baseOf(t.marketHashName);
    positionsByName.set(key, (positionsByName.get(key) || 0) + 1);
  }

  // Скільки "пішло" можна лишити по кожній назві — решту повертаємо в "here".
  const goneLeft = new Map();
  const rows = report.rows.map((r) => {
    if (r.status !== "gone") return r;
    const key = baseOf(r.marketHashName);
    if (!goneLeft.has(key)) goneLeft.set(key, Math.max(0, (positionsByName.get(key) || 0) - (steamCount.get(key) || 0)));
    const left = goneLeft.get(key);
    if (left > 0) {
      goneLeft.set(key, left - 1);
      return r;
    }
    return { ...r, status: "here", via: "steam" };
  });

  const count = (status) => rows.filter((r) => r.status === status).length;
  const sum = (status) =>
    round2(rows.filter((r) => r.status === status).reduce((acc, r) => acc + (Number(r.buyPrice) || 0), 0));
  return { ...report, rows, gone: count("gone"), goneSum: sum("gone"), here: count("here"), steamChecked: true };
}

function rowOf(trade) {
  return {
    id: trade.id,
    marketHashName: trade.marketHashName,
    name: trade.name,
    wear: trade.wear,
    buyPrice: round2(trade.buyPrice),
    buyDate: trade.buyDate,
    buySource: trade.buySource,
    floatValue: trade.floatValue ?? null,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Проставляет найденные float'ы в копии списка — для предпросмотра, без записи. */
function applyFillInMemory(rawTrades, assignments) {
  const byId = new Map(assignments.map((a) => [a.id, a.floatValue]));
  return rawTrades.map((t) => (byId.has(t.id) ? { ...t, floatValue: byId.get(t.id) } : t));
}

module.exports = {
  confirmWithSteam,
  FLOAT_EPS,
  sameFloat,
  floatsByName,
  countsByName,
  inventoryKey,
  mergeInventories,
  splitByInventory,
  planFill,
  applyFillInMemory,
  checkHoldings,
};
