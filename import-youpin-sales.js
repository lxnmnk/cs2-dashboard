// Импорт продаж с Youpin в трекер сделок по флоту.
//
// Youpin не отдаёт историю продаж через API (см. переписку про их внутренний
// API), поэтому список снят со скриншотов "出售记录 / 已完成" руками. Зато
// флот там показан полностью — а флот и есть надёжный ключ: названия на
// Youpin китайские, два одинаковых ножа отличаются только им.
//
// Скрипт ничего не пишет без --apply: сначала показывает, что и с чем
// сопоставилось, и только потом закрывает позиции.
//
// Запуск (на сервере, там лежит настоящий trades.json):
//   node import-youpin-sales.js --rate 7.15            // показать, не менять
//   node import-youpin-sales.js --rate 7.15 --fee 2    // с комиссией площадки
//   node import-youpin-sales.js --rate 7.15 --apply    // записать
//
// --rate — сколько юаней в долларе. Трекер считает всё в долларах, а Youpin
// платит в юанях; курс знает только владелец (он зависит от того, как и
// когда выводились деньги), поэтому параметр обязательный.
const trades = require("./trades");

const OWNER = process.env.TRADES_OWNER || "lxnmnk";
const FLOAT_EPS = 1e-6;

// Продажи со скриншотов: флот, цена в юанях, время заказа и название, как
// оно подписано на Youpin. Название — только для сверки глазами: сопоставляем
// по флоту, на него опечатка в переводе не влияет.
const SALES = [
  { float: 0.1285888850688934, cny: 1697.5, soldAt: "2026-10-10T14:19:44", name: "★ Flip Knife | Crimson Web (MW)", cn: "折叠刀（★）| 深红之网" },
  { float: 0.1283525824546814, cny: 1505.0, soldAt: "2026-10-10T12:12:14", name: "★ Bayonet | Blue Steel (MW)", cn: "刺刀（★）| 蓝钢" },
  { float: 0.0625938326120377, cny: 2668.5, soldAt: "2026-10-09T18:15:15", name: "AK-47 | Case Hardened (FN)", cn: "AK-47 | 表面淬火" },
  { float: 0.1157256141304969, cny: 449.5, soldAt: "2026-10-09T13:25:23", name: "StatTrak™ M4A4 | ? (MW)", cn: "M4A4（StatTrak™）| 反冲精英" },

  { float: 0.1377593576908111, cny: 724.0, soldAt: "2026-10-18T00:22:10", name: "StatTrak™ AWP | Hyper Beast (MW)", cn: "AWP（StatTrak™）| 暴怒野兽" },
  { float: 0.1197489872574806, cny: 788.9, soldAt: "2026-10-11T20:04:31", name: "★ Ursus Knife | Case Hardened (MW)", cn: "熊刀（★）| 表面淬火" },
  { float: 0.2216612994670868, cny: 838.5, soldAt: "2026-10-10T23:32:06", name: "★ Flip Knife | Black Laminate (FT)", cn: "折叠刀（★）| 黑色层压板" },
  { float: 0.0326595194637775, cny: 3713.5, soldAt: "2026-10-10T20:07:31", name: "★ M9 Bayonet | Tiger Tooth (FN)", cn: "M9 刺刀（★）| 虎牙" },

  { float: 0.3127617537975311, cny: 205.45, soldAt: "2026-10-18T02:58:54", name: "Desert Eagle | Printstream (FT)", cn: "沙漠之鹰 | 印花集" },
  { float: 0.338134378194809, cny: 183.3, soldAt: "2026-10-18T02:44:27", name: "M4A4 | Neo-Noir (FT)", cn: "M4A4 | 黑色魅影" },
  { float: 0.5246633291244507, cny: 581.5, soldAt: "2026-10-18T02:25:57", name: "AK-47 | The Empress (BS)", cn: "AK-47 | 皇后" },
  { float: 0.2259500324726105, cny: 3639.5, soldAt: "2026-10-18T02:23:49", name: "★ Butterfly Knife | Black Laminate (FT)", cn: "蝴蝶刀（★）| 黑色层压板" },

  { float: 0.6349183917045593, cny: 242.0, soldAt: "2026-10-18T07:55:20", name: "★ Survival Knife | Rust Coat (BS)", cn: "求生匕首（★）| 外表生锈" },
  { float: 0.465388685464859, cny: 649.49, soldAt: "2026-10-18T07:22:03", name: "M4A1-S | Hyper Beast (BS)", cn: "M4A1消音版 | 暴怒野兽" },
  { float: 0.3481298387050629, cny: 183.3, soldAt: "2026-10-18T06:57:46", name: "M4A4 | Neo-Noir (FT)", cn: "M4A4 | 黑色魅影" },
  { float: 0.1171528622508049, cny: 295.0, soldAt: "2026-10-18T06:52:49", name: "M4A4 | ? (MW)", cn: "M4A4 | 反冲精英" },

  { float: 0.2255140990001884, cny: 198.79, soldAt: "2026-10-18T10:41:39", name: "StatTrak™ M4A4 | Neo-Noir (FT)", cn: "M4A4（StatTrak™）| 黑色魅影" },
  { float: 0.2784444689750671, cny: 180.49, soldAt: "2026-10-18T10:32:36", name: "M4A4 | Neo-Noir (FT)", cn: "M4A4 | 黑色魅影" },
  { float: 0.1194885298609734, cny: 340.18, soldAt: "2026-10-18T10:19:18", name: "USP-S | Printstream (MW)", cn: "USP 消音版 | 印花集" },
  { float: 0.131305143237114, cny: 340.18, soldAt: "2026-10-18T10:19:01", name: "USP-S | Printstream (MW)", cn: "USP 消音版 | 印花集" },

  { float: 0.1281113177537918, cny: 375.5, soldAt: "2026-10-18T13:35:11", name: "★ Kukri Knife | Stained (MW)", cn: "廓尔喀刀（★）| 人工染色" },
  { float: 0.3386396169662476, cny: 267.0, soldAt: "2026-10-18T13:24:18", name: "★ Broken Fang Gloves | Needle Point (FT)", cn: "狂牙手套（★）| 针尖" },
  { float: 0.3262555599212646, cny: 669.5, soldAt: "2026-10-18T12:09:46", name: "★ Skeleton Knife | Forest DDPAT (FT)", cn: "骷髅匕首（★）| 森林 DDPAT" },
  { float: 0.2252521514892578, cny: 255.5, soldAt: "2026-10-18T11:28:02", name: "★ Navaja Knife | Ultraviolet (FT)", cn: "折刀（★）| 致命紫罗兰" },

  { float: 0.013853594660759, cny: 545.5, soldAt: "2026-10-18T10:16:31", name: "★ Shadow Daggers | Gamma Doppler (FN) Phase 1", cn: "暗影双匕（★）| 伽玛多普勒" },
  { float: 0.6477757096290588, cny: 161.4, soldAt: "2026-10-18T10:14:03", name: "M4A4 | Neo-Noir (BS)", cn: "M4A4 | 黑色魅影" },
  { float: 0.1611234098672867, cny: 216.0, soldAt: "2026-10-18T09:59:06", name: "★ Shadow Daggers | Bright Water (FT)", cn: "暗影双匕（★）| 澄澈之水" },
  { float: 0.1358852088451385, cny: 252.99, soldAt: "2026-10-18T08:19:30", name: "AWP | Neo-Noir (MW)", cn: "AWP | 黑色魅影" },

  // --- вторая пачка скриншотов: 08-09.10 ---
  { float: 0.3394696116447449, cny: 774.5, soldAt: "2026-10-08T01:28:36", name: "M4A1-S | Hyper Beast (FT)", cn: "M4A1消音版 | 暴怒野兽" },
  { float: 0.0308950878679752, cny: 1049.0, soldAt: "2026-10-08T01:22:44", name: "M4A1-S | ? (FN), fade 96.5%", cn: "M4A1消音版 | 渐变之色" },
  { float: 0.1155628934502602, cny: 763.0, soldAt: "2026-10-08T01:17:07", name: "MAC-10 | Neon Rider (MW)", cn: "MAC-10 | 霓虹骑士" },
  { float: 0.1959762722253799, cny: 195.5, soldAt: "2026-10-08T01:16:44", name: "M4A4 | Neo-Noir (FT)", cn: "M4A4 | 黑色魅影" },

  { float: 0.1197829023003578, cny: 1889.5, soldAt: "2026-10-09T02:02:56", name: "★ Talon Knife | Damascus Steel (MW)", cn: "锯齿爪刀（★）| 大马士革钢" },
  { float: 0.1615714728832245, cny: 452.5, soldAt: "2026-10-08T15:35:22", name: "★ Classic Knife | Urban Masked (FT)", cn: "海豹短刀（★）| 都市伪装" },
  { float: 0.0686034634709358, cny: 1063.99, soldAt: "2026-10-08T06:45:29", name: "Glock-18 | Neo-Noir (FN)", cn: "格洛克 18 型 | 黑色魅影" },
  { float: 0.2808093428611755, cny: 26.89, soldAt: "2026-10-08T06:42:58", name: "UMP-45 | Neo-Noir (FT)", cn: "UMP-45 | 黑色魅影" },

  { float: 0.1207750886678696, cny: 208.96, soldAt: "2026-10-09T08:05:15", name: "AWP | Chrome Cannon (MW)", cn: "AWP | 镀铬大炮" },
  { float: 0.2090659588575363, cny: 241.95, soldAt: "2026-10-09T07:49:09", name: "AWP | Neo-Noir (FT)", cn: "AWP | 黑色魅影" },
  { float: 0.575280487537384, cny: 161.38, soldAt: "2026-10-09T06:55:07", name: "M4A4 | Temukau (BS)", cn: "M4A4 | 反冲精英" },

  // --- третья пачка скриншотов: 18-19.10 ---
  { float: 0.0625025629997253, cny: 257.85, soldAt: "2026-10-19T14:52:38", name: "★ Shadow Daggers | Bright Water (FN)", cn: "暗影双匕（★）| 澄澈之水" },
  { float: 0.1259768903255463, cny: 38.4, soldAt: "2026-10-19T14:21:12", name: "AK-47 | ? (MW)", cn: "AK-47 | 午夜层压板" },
  { float: 0.3584056794643402, cny: 335.0, soldAt: "2026-10-19T13:35:17", name: "★ Moto Gloves | Turtle (FT)", cn: "摩托手套（★）| 玳瑁" },
  { float: 0.2451740354299545, cny: 196.76, soldAt: "2026-10-19T12:31:47", name: "StatTrak™ M4A4 | Neo-Noir (FT)", cn: "M4A4（StatTrak™）| 黑色魅影" },
  { float: 0.1226486414670944, cny: 48.3, soldAt: "2026-10-19T13:16:16", name: "Desert Eagle | Mecha Industries (MW)", cn: "沙漠之鹰 | 机械工业" },
  { float: 0.1169273853302002, cny: 290.0, soldAt: "2026-10-19T13:05:22", name: "M4A4 | Temukau (MW)", cn: "M4A4 | 反冲精英" },
  { float: 0.105718769133091, cny: 59.18, soldAt: "2026-10-19T12:37:31", name: "P90 | ? (MW)", cn: "P90 | 美杜莎之视" },
  { float: 0.126557007431984, cny: 723.0, soldAt: "2026-10-19T11:48:43", name: "StatTrak™ AWP | Hyper Beast (MW)", cn: "AWP（StatTrak™）| 暴怒野兽" },
  { float: 0.0952870398759842, cny: 2982.0, soldAt: "2026-10-19T11:37:01", name: "★ Talon Knife | Case Hardened (MW)", cn: "锯齿爪刀（★）| 表面淬火" },
  { float: 0.3679559230804443, cny: 267.0, soldAt: "2026-10-19T02:24:53", name: "★ Broken Fang Gloves | Needle Point (FT)", cn: "狂牙手套（★）| 针尖" },
  { float: 0.2853803336620331, cny: 178.1, soldAt: "2026-10-18T14:14:51", name: "M4A4 | Temukau (FT)", cn: "M4A4 | 反冲精英" },
  { float: 0.1695018261671066, cny: 650.98, soldAt: "2026-10-18T13:56:08", name: "★ Flip Knife | Safari Mesh (FT)", cn: "折叠刀（★）| 狩猎网格" },
  { float: 0.0995782613754273, cny: 2647.99, soldAt: "2026-10-18T21:19:26", name: "★ Talon Knife | Blue Steel (MW)", cn: "锯齿爪刀（★）| 蓝钢" },
  { float: 0.0317849405109882, cny: 7293.0, soldAt: "2026-10-18T16:33:30", name: "★ Karambit | Doppler (FN) Phase 3", cn: "爪子刀（★）| 多普勒" },
];

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : null;
}

const rate = Number(arg("rate"));
const feePercent = Number(arg("fee") || 0);
const apply = process.argv.includes("--apply");

if (!Number.isFinite(rate) || rate <= 0) {
  console.error("Нужен курс: --rate 7.15 (сколько юаней в долларе)");
  process.exit(1);
}
if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 50) {
  console.error("--fee — проценты от 0 до 50");
  process.exit(1);
}

function usd(cny) {
  return Math.round(((cny * (1 - feePercent / 100)) / rate) * 100) / 100;
}

const all = trades.listRawTrades(OWNER);
const holdings = all.filter((t) => t.status === "holding");
// Продажи, уже закрытые раньше — этим скриптом или руками в панели. Список
// скриншотов дополняется, и без этого прежние записи каждый раз попадали бы
// в "не нашлось". Площадку сравниваем нестрого: руками её подписывают и
// "Youpin898", и "youpin 898", и через поле "Other".
const isYoupin = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .startsWith("youpin");
const alreadySold = all.filter((t) => t.status === "sold" && isYoupin(t.sellSource));

const matched = [];
const unmatched = [];
const already = [];
const ambiguous = [];
const taken = new Set();

const sameFloat = (t, value) => t.floatValue != null && Math.abs(Number(t.floatValue) - value) < FLOAT_EPS;

for (const sale of SALES) {
  const hits = holdings.filter((t) => sameFloat(t, sale.float) && !taken.has(t.id));
  if (hits.length > 1) {
    ambiguous.push({ sale, hits });
    continue;
  }
  if (hits.length === 1) {
    taken.add(hits[0].id);
    matched.push({ sale, trade: hits[0] });
    continue;
  }
  if (alreadySold.some((t) => sameFloat(t, sale.float))) already.push(sale);
  else unmatched.push(sale);
}

const money = (n) => `$${n.toFixed(2)}`;

console.log(`Владелец: ${OWNER} · открытых позиций: ${holdings.length} · продаж в списке: ${SALES.length}`);
console.log(`Курс: ${rate} ¥/$${feePercent ? ` · комиссия ${feePercent}%` : ""} · режим: ${apply ? "ЗАПИСЫВАЮ" : "вхолостую"}\n`);

if (matched.length) {
  console.log(`Сопоставлено по флоту: ${matched.length}`);
  let bought = 0;
  let sold = 0;
  for (const { sale, trade } of matched) {
    const price = usd(sale.cny);
    bought += Number(trade.buyPrice) || 0;
    sold += price;
    const profit = price - (Number(trade.buyPrice) || 0);
    console.log(
      `  ${trade.marketHashName.slice(0, 44).padEnd(45)} куплен ${money(Number(trade.buyPrice) || 0).padStart(9)}` +
        ` → ¥${String(sale.cny).padStart(8)} = ${money(price).padStart(9)}` +
        `  ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}`
    );
  }
  console.log(`  ИТОГО: вложено ${money(bought)} · получено ${money(sold)} · ${sold - bought >= 0 ? "+" : ""}${(sold - bought).toFixed(2)}\n`);
}

if (already.length) {
  console.log(`Уже записаны прошлым запуском: ${already.length}\n`);
}

if (ambiguous.length) {
  console.log(`Несколько позиций с одним флотом (руками): ${ambiguous.length}`);
  for (const { sale, hits } of ambiguous) {
    console.log(`  ${sale.name} (${sale.float}) → ${hits.map((h) => h.id.slice(0, 8)).join(", ")}`);
  }
  console.log();
}

if (unmatched.length) {
  console.log(`Не нашлось в трекере: ${unmatched.length}`);
  for (const sale of unmatched) {
    console.log(`  ${sale.name.padEnd(45)} float ${sale.float} · ¥${sale.cny} · ${sale.soldAt.replace("T", " ")}`);
  }
  console.log("  (позиция продана не из трекера, флот не записан или продана раньше)\n");
}

if (!apply) {
  console.log("Это был холостой прогон. Чтобы записать — повтори команду с --apply");
  process.exit(0);
}

let saved = 0;
for (const { sale, trade } of matched) {
  try {
    trades.sellTrade(trade.id, OWNER, {
      sellSource: "youpin",
      sellPrice: usd(sale.cny),
      sellDate: new Date(sale.soldAt).toISOString(),
      sellSide: "ask", // на Youpin мы выставляем лот, а не сдаём в чужой бид
    });
    saved++;
  } catch (err) {
    console.error(`  ${trade.marketHashName}: ${err.message}`);
  }
}
console.log(`Записано продаж: ${saved} из ${matched.length}`);
