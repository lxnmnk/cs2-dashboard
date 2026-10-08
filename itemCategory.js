// Категорія предмета за його назвою — для вкладок у каталозі ("Ножі",
// "Пістолети", "Рукавиці"...).
//
// Беремо зі списку зброї, а не з чужого довідника: список у CS2 фіксований і
// не змінювався роками, зате жодного зайвого запиту й жодної залежності. Нові
// предмети, яких тут немає, потраплять у "other" — видно одразу, бо вони
// зберуться в одній вкладці, а не розповзуться по всіх.
const WEAPONS = {
  pistol: [
    "Desert Eagle", "Dual Berettas", "Five-SeveN", "Glock-18", "P2000",
    "P250", "R8 Revolver", "Tec-9", "USP-S", "CZ75-Auto",
  ],
  rifle: ["AK-47", "AUG", "FAMAS", "Galil AR", "M4A1-S", "M4A4", "SG 553"],
  sniper: ["AWP", "G3SG1", "SCAR-20", "SSG 08"],
  smg: ["MAC-10", "MP5-SD", "MP7", "MP9", "P90", "PP-Bizon", "UMP-45"],
  shotgun: ["MAG-7", "Nova", "Sawed-Off", "XM1014"],
  machinegun: ["M249", "Negev"],
  knife: [
    "Bayonet", "Bowie Knife", "Butterfly Knife", "Classic Knife", "Falchion Knife",
    "Flip Knife", "Gut Knife", "Huntsman Knife", "Karambit", "Kukri Knife",
    "M9 Bayonet", "Navaja Knife", "Nomad Knife", "Paracord Knife", "Shadow Daggers",
    "Skeleton Knife", "Stiletto Knife", "Survival Knife", "Talon Knife", "Ursus Knife",
  ],
  gloves: [
    "Bloodhound Gloves", "Broken Fang Gloves", "Driver Gloves", "Hand Wraps",
    "Hydra Gloves", "Moto Gloves", "Specialist Gloves", "Sport Gloves",
  ],
};

// Назва зброї -> категорія. Довші назви перевіряємо першими, інакше "M4A1-S"
// сховався б за "M4A4"-подібними збігами, а "MP5-SD" за "MP5".
const BY_WEAPON = [];
for (const [category, names] of Object.entries(WEAPONS)) {
  for (const name of names) BY_WEAPON.push([name, category]);
}
BY_WEAPON.sort((a, b) => b[0].length - a[0].length);

// Предмети, у яких немає "зброя | скін": визначаємо за початком назви.
const PREFIXES = [
  ["Sticker |", "sticker"],
  ["Charm |", "charm"],
  ["Patch |", "patch"],
  ["Music Kit |", "music"],
  ["Sealed Graffiti |", "graffiti"],
  ["Graffiti |", "graffiti"],
];

// ...і за характерним хвостом назви.
const SUFFIXES = [
  ["Case", "case"],
  ["Capsule", "case"],
  ["Package", "case"],
  ["Case Key", "case"],
  ["Pin", "pin"],
];

const ZEUS = "Zeus x27";

/**
 * Категорія предмета. Повертає один із ключів: knife, pistol, rifle, sniper,
 * smg, shotgun, machinegun, gloves, sticker, charm, patch, music, graffiti,
 * case, pin, agent, other.
 */
function categoryOf(marketHashName) {
  const name = String(marketHashName || "");
  if (!name) return "other";

  for (const [prefix, category] of PREFIXES) {
    if (name.startsWith(prefix)) return category;
  }
  for (const [suffix, category] of SUFFIXES) {
    if (name.endsWith(suffix)) return category;
  }
  if (name.startsWith(ZEUS)) return "other";

  // Зброя завжди стоїть до " | ", а префікси StatTrak™ / Souvenir / ★ — до неї.
  // Префікси зрізаємо по колу, а не одним списком замін: у "★ StatTrak™ M9
  // Bayonet" їх два підряд, і за один прохід лишався б "StatTrak™ M9 Bayonet",
  // який зі списком зброї вже не збігається.
  let weaponPart = name.split(" | ")[0].trim();
  for (let i = 0; i < 3; i++) {
    const stripped = weaponPart.replace(/^(★|StatTrak™|Souvenir)\s+/, "");
    if (stripped === weaponPart) break;
    weaponPart = stripped;
  }

  for (const [weapon, category] of BY_WEAPON) {
    if (weaponPart === weapon) return category;
  }

  // Агенти виглядають як "Ім'я | Загін" і не мають зброї в першій частині.
  if (name.includes(" | ") && !name.startsWith("★")) return "agent";
  return "other";
}

/** Порядок вкладок у каталозі: спершу те, що купують найчастіше. */
const CATEGORY_ORDER = [
  "knife", "gloves", "rifle", "sniper", "pistol", "smg",
  "shotgun", "machinegun", "sticker", "charm", "agent", "case", "other",
];

module.exports = { categoryOf, CATEGORY_ORDER, WEAPONS };
