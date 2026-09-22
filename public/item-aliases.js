// Пошук предметів російською/українською: "скелетний ніж" -> "skeleton knife",
// "калаш градієнт" -> "ak-47 fade". Назви в market_hash_name завжди англійські,
// а люди шукають так, як звикли в грі, тому перед пошуком перекладаємо кожне
// слово запиту. Невідоме слово лишаємо як є — воно просто не знайдеться, як і
// раніше.
//
// Файл один на сервер (itemName.js) і на браузер (item-filters.js, swap.js),
// щоб словник не розʼїхався: у Node підключається через require, у сторінці —
// звичайним <script> (кладе все у window).
const ITEM_ALIASES = {
  // --- Типи предметів ---
  нож: "knife",
  ніж: "knife",
  ножик: "knife",
  ножи: "knife",
  ножі: "knife",
  перчатки: "gloves",
  перчатка: "gloves",
  рукавиці: "gloves",
  рукавички: "gloves",
  наклейка: "sticker",
  наклейки: "sticker",
  сувенир: "souvenir",
  сувенір: "souvenir",
  кейс: "case",
  ключ: "key",
  брелок: "charm",
  агент: "agent",

  // --- Ножі ---
  штык: "bayonet",
  штик: "bayonet",
  багнет: "bayonet",
  байонет: "bayonet",
  м9: "m9",
  керамбит: "karambit",
  керамбіт: "karambit",
  бабочка: "butterfly",
  метелик: "butterfly",
  фальшион: "falchion",
  фальшіон: "falchion",
  складной: "flip",
  складаний: "flip",
  флип: "flip",
  фліп: "flip",
  охотничий: "huntsman",
  мисливський: "huntsman",
  хантсман: "huntsman",
  кинжалы: "shadow daggers",
  кинджали: "shadow daggers",
  теневые: "shadow",
  тіньові: "shadow",
  боуи: "bowie",
  боуі: "bowie",
  наваха: "navaja",
  стилет: "stiletto",
  коготь: "talon",
  кіготь: "talon",
  тэлон: "talon",
  медвежий: "ursus",
  урсус: "ursus",
  ведмежий: "ursus",
  классический: "classic",
  класичний: "classic",
  паракорд: "paracord",
  выживания: "survival",
  виживання: "survival",
  бродяга: "nomad",
  бродяги: "nomad",
  номад: "nomad",
  скелетный: "skeleton",
  скелетний: "skeleton",
  скелет: "skeleton",
  кукри: "kukri",
  кукрі: "kukri",
  потрошитель: "gut",
  потрошитель_нож: "gut knife",

  // --- Рукавиці ---
  спортивные: "sport",
  спортивні: "sport",
  специалиста: "specialist",
  спеціаліста: "specialist",
  бинты: "hand wraps",
  бинти: "hand wraps",
  мото: "moto",
  водителя: "driver",
  водія: "driver",
  ищейки: "bloodhound",
  гончака: "bloodhound",
  гидра: "hydra",
  гідра: "hydra",
  сломанный: "broken fang",
  зламаний: "broken fang",

  // --- Зброя (як її звуть у розмові) ---
  калаш: "ak-47",
  калашников: "ak-47",
  ак: "ak-47",
  авп: "awp",
  ави: "awp",
  дигл: "desert eagle",
  дігл: "desert eagle",
  орел: "desert eagle",
  пустынный: "desert",
  пустельний: "desert",
  глок: "glock",
  усп: "usp",
  юсп: "usp",
  дьюлы: "dual berettas",
  дуалы: "dual berettas",
  беретты: "berettas",
  скаут: "ssg 08",
  скут: "ssg 08",
  автоснайперка: "scar-20",
  фамас: "famas",
  галил: "galil",
  галіл: "galil",
  негев: "negev",
  максимка: "m249",
  дробовик: "nova",
  обрез: "sawed-off",
  обріз: "sawed-off",

  // --- Популярні забарвлення ---
  градиент: "fade",
  градієнт: "fade",
  фейд: "fade",
  доплер: "doppler",
  допплер: "doppler",
  мраморный: "marble",
  мармуровий: "marble",
  тигровый: "tiger",
  тигровий: "tiger",
  клык: "tooth",
  ікло: "tooth",
  убойный: "slaughter",
  забійний: "slaughter",
  закаленное: "case hardened",
  загартоване: "case hardened",
  закалка: "case hardened",
  багровая: "crimson",
  багряна: "crimson",
  паутина: "web",
  павутина: "web",
  вороненая: "blue steel",
  вороняча: "blue steel",
  ультрафиолет: "ultraviolet",
  ультрафіолет: "ultraviolet",
  дамасская: "damascus",
  дамаська: "damascus",
  сталь: "steel",
  ржавый: "rust coat",
  іржавий: "rust coat",
  выжженный: "scorched",
  випалений: "scorched",
  пятнистый: "stained",
  плямистий: "stained",
  сетка: "safari mesh",
  сітка: "safari mesh",
  сафари: "safari",
  сафарі: "safari",
  лесной: "boreal forest",
  лісовий: "boreal forest",
  ночь: "night",
  ніч: "night",
  чистая: "bright water",
  чиста: "bright water",
  вода: "water",
  рубин: "ruby",
  рубін: "ruby",
  сапфир: "sapphire",
  сапфір: "sapphire",
  изумруд: "emerald",
  смарагд: "emerald",
  жемчужина: "black pearl",
  перлина: "black pearl",
  азимов: "asiimov",
  азімов: "asiimov",
  редлайн: "redline",
  гипер: "hyper beast",
  гіпер: "hyper beast",
  зверь: "beast",
  звір: "beast",
  принтстрим: "printstream",
  принтстрім: "printstream",
  драконлор: "dragon lore",
  дракон: "dragon",
  лор: "lore",
  неонрайдер: "neon rider",
  неон: "neon",
  змей: "serpent",
  змій: "serpent",
  огненный: "fire",
  вогняний: "fire",
  пламя: "wildfire",
  полумʼя: "wildfire",
  кимоно: "kimono",
  кімоно: "kimono",
  пандора: "pandora",
  ящик: "box",

  // --- Якість ---
  прямо: "factory new",
  новое: "factory new",
  нове: "factory new",
  поношенное: "minimal wear",
  зношене: "minimal wear",
  закаленное_в_боях: "case hardened",
};

/**
 * Перекладає слова запиту англійською там, де знаємо переклад.
 * ["скелетний", "ніж"] -> ["skeleton", "knife"]
 * Багатослівний переклад ("bright water") розбивається на окремі слова, бо
 * пошук усе одно вимагає, щоб знайшлося кожне слово.
 */
function translateSearchTokens(tokens) {
  const out = [];
  for (const token of tokens) {
    const alias = ITEM_ALIASES[token];
    // Розбиваємо так само, як normalizeForSearch розбиває назву: у "ak-47"
    // дефіса в нормалізованій назві немає, там просто "ak 47".
    if (alias) out.push(...alias.split(/[- _]+/).filter(Boolean));
    else out.push(token);
  }
  return out;
}

/**
 * Нормалізує рядок для пошуку: лишає тільки букви й цифри через один пробіл,
 * щоб "AWP | Gungnir (FT)" і "awp gungnir" були однакові. Те саме робить
 * itemName.js на сервері — тримаємо в одному місці, щоб не розходились.
 */
function normalizeForSearch(s) {
  return (s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * true, если каждое слово запроса нашлось в тексте — либо как есть (так
 * находятся официальные русские/украинские названия, которые сервер кладёт
 * рядом с английским — searchAlt), либо через словарь выше ("калаш" -> ak 47).
 * Поэтому работают и смешанные запросы: "калаш красная линия".
 */
function matchesQuery(text, query) {
  const raw = normalizeForSearch(query).split(" ").filter(Boolean);
  if (!raw.length) return true;
  const hay = normalizeForSearch(text);
  return raw.every((token) => {
    if (hay.includes(token)) return true;
    const alias = ITEM_ALIASES[token];
    return !!alias && alias.split(/[- _]+/).filter(Boolean).every((w) => hay.includes(w));
  });
}

/** Слова запиту, вже перекладені англійською. */
function searchTokens(query) {
  return translateSearchTokens(normalizeForSearch(query).split(" ").filter(Boolean));
}

/** true, якщо в назві знайшлося кожне слово запиту (у будь-якому порядку). */
function matchesTokens(name, tokens) {
  if (!tokens || !tokens.length) return true;
  const normalized = normalizeForSearch(name);
  return tokens.every((t) => normalized.includes(t));
}

if (typeof window !== "undefined") {
  window.ITEM_ALIASES = ITEM_ALIASES;
  window.translateSearchTokens = translateSearchTokens;
  window.searchTokens = searchTokens;
  window.matchesTokens = matchesTokens;
  window.matchesQuery = matchesQuery;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ITEM_ALIASES, translateSearchTokens, matchesQuery, normalizeForSearch };
}
