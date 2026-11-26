// Історія цін предметів: buff ask/bid, youpin ask/bid, skinbux bid, cs.money bid.
//
// Раз на годину (о :50) сервер кладе сюди знімок цін з cache.rows. Старше
// 90 днів погодинні точки стискаються в одну на добу (середнє) — так файл
// предмета не росте безкінечно, а графік за рік лишається читабельним.
//
// Зберігання без бази: кожен предмет — свій файл priceHistory/<hash>.bin із
// записами фіксованого розміру (28 байт): час у секундах (uint32) і шість
// цін у центах (int32, -1 = ціни не було). Графік читає один файл предмета
// цілком (за 90 днів погодинно це ~60 КБ), запис — дописування в кінець.
// Пишемо лише предмети від minUsd: дешевих десятки тисяч, а графік по них
// нікому не потрібен.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, "priceHistory");
const META_FILE = path.join(DIR, "meta.json");
const FIELDS = [
  ["buff", "ask"],
  ["buff", "bid"],
  ["youpin", "ask"],
  ["youpin", "bid"],
  ["skinbux", "bid"],
  ["csmoney", "bid"],
];
const KEYS = FIELDS.map(([s, side]) => `${s}_${side}`);
const REC = 4 + FIELDS.length * 4;
const HOUR = 3600;
const DAY = 24 * HOUR;
const HOURLY_KEEP_DAYS = 90;
const NONE = -1;

function fileFor(name) {
  return path.join(DIR, crypto.createHash("sha1").update(String(name)).digest("hex").slice(0, 24) + ".bin");
}

function cents(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NONE;
}

function encode(points) {
  const buf = Buffer.alloc(points.length * REC);
  points.forEach((p, i) => {
    const o = i * REC;
    buf.writeUInt32LE(p.t, o);
    p.v.forEach((c, j) => buf.writeInt32LE(c, o + 4 + j * 4));
  });
  return buf;
}

/** Записи файлу → точки за часом, без дублів (той самий час — бере останній запис). */
function decode(buf) {
  const byTime = new Map();
  const n = Math.floor(buf.length / REC);
  for (let i = 0; i < n; i++) {
    const o = i * REC;
    const v = [];
    for (let j = 0; j < FIELDS.length; j++) v.push(buf.readInt32LE(o + 4 + j * 4));
    byTime.set(buf.readUInt32LE(o), v);
  }
  return [...byTime].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(META_FILE + ".tmp", JSON.stringify(meta, null, 2));
  fs.renameSync(META_FILE + ".tmp", META_FILE);
}

// Невеликий пул паралельних операцій з файлами: тисячі предметів підряд
// не мають ні блокувати сервер, ні відкривати тисячі файлів разом.
async function eachLimit(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  });
  await Promise.all(workers);
}

/**
 * Знімок цін на годину at. Одна година — один запис: повторний виклик у ту
 * саму годину нічого не пише. Повертає кількість записаних предметів.
 */
async function record(rows, { at = Date.now(), minUsd = 5 } = {}) {
  const hour = Math.floor(at / 1000 / HOUR) * HOUR;
  const meta = loadMeta();
  if (meta.lastHour >= hour) return 0;
  fs.mkdirSync(DIR, { recursive: true });
  const minCents = Math.round(minUsd * 100);
  const todo = [];
  for (const row of rows || []) {
    const v = FIELDS.map(([s, side]) => cents(row.prices?.[s]?.[side]));
    if (Math.max(...v) < minCents) continue;
    todo.push({ name: row.marketHashName, buf: encode([{ t: hour, v }]) });
  }
  await eachLimit(todo, 32, (x) => fsp.appendFile(fileFor(x.name), x.buf));
  saveMeta({ ...meta, lastHour: hour, lastCount: todo.length, lastAt: new Date().toISOString() });
  return todo.length;
}

/**
 * Історія предмета від fromSec (секунди). Повертає точки
 * [{ t, buff_ask, buff_bid, ... }] у доларах, null — ціни не було.
 */
async function read(name, { fromSec = 0 } = {}) {
  let buf;
  try {
    buf = await fsp.readFile(fileFor(name));
  } catch {
    return [];
  }
  return decode(buf)
    .filter((p) => p.t >= fromSec)
    .map((p) => {
      const out = { t: p.t };
      p.v.forEach((c, j) => (out[KEYS[j]] = c === NONE ? null : c / 100));
      return out;
    });
}

// Точки старші за cutoff — одна на добу (середнє по кожній ціні окремо;
// ціни, якої не було цілу добу, і в середньому немає).
function collapseOld(points, cutoff) {
  const days = new Map();
  const keep = [];
  for (const p of points) {
    if (p.t >= cutoff) {
      keep.push(p);
      continue;
    }
    const day = Math.floor(p.t / DAY) * DAY;
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(p);
  }
  const daily = [...days].map(([day, list]) => {
    if (list.length === 1) return list[0];
    const v = FIELDS.map((_, j) => {
      const xs = list.map((p) => p.v[j]).filter((c) => c !== NONE);
      return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : NONE;
    });
    return { t: day + 12 * HOUR, v };
  });
  return [...daily, ...keep].sort((a, b) => a.t - b.t);
}

/**
 * Раз на добу: погодинні точки старші за 90 днів → одна на добу. Файл
 * переписуємо лише тоді, коли в ньому справді є що стиснути.
 */
async function compact({ now = Date.now() } = {}) {
  const cutoff = Math.floor(now / 1000) - HOURLY_KEEP_DAYS * DAY;
  let files;
  try {
    files = (await fsp.readdir(DIR)).filter((f) => f.endsWith(".bin"));
  } catch {
    return 0;
  }
  let rewritten = 0;
  await eachLimit(files, 8, async (f) => {
    const file = path.join(DIR, f);
    const buf = await fsp.readFile(file);
    const points = decode(buf);
    const next = collapseOld(points, cutoff);
    if (next.length * REC === buf.length) return;
    await fsp.writeFile(file + ".tmp", encode(next));
    await fsp.rename(file + ".tmp", file);
    rewritten++;
  });
  return rewritten;
}

/** Імпорт готових точок (перенесення старої історії): дописує і прибирає дублі. */
async function importPoints(name, points) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(name);
  let old = [];
  try {
    old = decode(await fsp.readFile(file));
  } catch {
    // файлу ще нема
  }
  const byTime = new Map(old.map((p) => [p.t, p.v]));
  for (const p of points) {
    const prev = byTime.get(p.t) || FIELDS.map(() => NONE);
    // Ціни, яких в імпорті немає, не затираємо: імпорт buff/youpin не має
    // стерти skinbux, уже записаний за ту саму годину.
    byTime.set(p.t, prev.map((c, j) => (p.v[j] !== NONE ? p.v[j] : c)));
  }
  const merged = [...byTime].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  await fsp.writeFile(file + ".tmp", encode(merged));
  await fsp.rename(file + ".tmp", file);
  return merged.length;
}

module.exports = { FIELDS, KEYS, DIR, record, read, compact, importPoints, collapseOld, fileFor, cents, NONE, HOUR, DAY };
