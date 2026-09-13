// Вітрина розділу Trade — праворуч, "наші скіни". Насправді ми їх не тримаємо
// на руках (для цього є "Наші скіни" / my-skins): це популярні позиції, які під
// конкретний обмін докуповуються на Youpin898, як у вкладці "Купити скіни".
// Тому список — просто перелік market_hash_name; ціна рахується щоразу з
// актуального прайсу (youpin ask + TRADE_MARKUP), а позиції без ціни на
// Youpin у видачу не потрапляють.
//
// Націнка тут нижча, ніж у "Купити скіни" (buyQuote.js, 6%): в обміні ми
// заробляємо ще й на боці клієнта, беручи його предмети за 97% ціни Skinbux.
//
// Щоб додати/прибрати позицію — просто редагуйте список (назва має точно
// збігатися з market_hash_name; у дoplerів наш синтетичний суфікс " - Phase N").
const TRADE_MARKUP = 0.03;

const ITEMS = [
  // Ножі
  "★ Butterfly Knife | Fade (Factory New)",
  "★ Butterfly Knife | Doppler (Factory New) - Phase 2",
  "★ Butterfly Knife | Slaughter (Factory New)",
  "★ Butterfly Knife | Tiger Tooth (Factory New)",
  "★ Karambit | Doppler (Factory New) - Phase 2",
  "★ Karambit | Fade (Factory New)",
  "★ Karambit | Tiger Tooth (Factory New)",
  "★ Karambit | Slaughter (Factory New)",
  "★ Karambit | Marble Fade (Factory New)",
  "★ M9 Bayonet | Doppler (Factory New) - Phase 2",
  "★ M9 Bayonet | Marble Fade (Factory New)",
  "★ M9 Bayonet | Tiger Tooth (Factory New)",
  "★ M9 Bayonet | Fade (Factory New)",
  "★ Bayonet | Tiger Tooth (Factory New)",
  "★ Bayonet | Doppler (Factory New) - Phase 2",
  "★ Bayonet | Marble Fade (Factory New)",
  "★ Talon Knife | Marble Fade (Factory New)",
  "★ Talon Knife | Doppler (Factory New) - Phase 2",
  "★ Talon Knife | Tiger Tooth (Factory New)",
  "★ Skeleton Knife | Slaughter (Minimal Wear)",
  "★ Skeleton Knife | Crimson Web (Minimal Wear)",
  "★ Flip Knife | Doppler (Factory New) - Phase 4",
  "★ Flip Knife | Marble Fade (Factory New)",
  "★ Flip Knife | Tiger Tooth (Factory New)",
  "★ Stiletto Knife | Doppler (Factory New) - Phase 2",
  "★ Stiletto Knife | Tiger Tooth (Factory New)",
  "★ Huntsman Knife | Fade (Factory New)",
  "★ Huntsman Knife | Tiger Tooth (Factory New)",
  "★ Ursus Knife | Doppler (Factory New) - Phase 2",
  "★ Navaja Knife | Fade (Factory New)",
  "★ Shadow Daggers | Fade (Factory New)",
  "★ Nomad Knife | Fade (Factory New)",
  "★ Classic Knife | Fade (Factory New)",

  // Рукавиці
  "★ Sport Gloves | Pandora's Box (Field-Tested)",
  "★ Sport Gloves | Vice (Minimal Wear)",
  "★ Sport Gloves | Amphibious (Field-Tested)",
  "★ Specialist Gloves | Crimson Kimono (Field-Tested)",
  "★ Specialist Gloves | Fade (Field-Tested)",
  "★ Specialist Gloves | Emerald Web (Field-Tested)",
  "★ Driver Gloves | King Snake (Field-Tested)",
  "★ Moto Gloves | Spearmint (Field-Tested)",
  "★ Hand Wraps | Cobalt Skulls (Field-Tested)",
  "★ Hydra Gloves | Emerald (Field-Tested)",

  // Гвинтівки
  "AK-47 | Fire Serpent (Field-Tested)",
  "AK-47 | Asiimov (Field-Tested)",
  "AK-47 | Redline (Field-Tested)",
  "AK-47 | Neon Rider (Field-Tested)",
  "AK-47 | Vulcan (Minimal Wear)",
  "AK-47 | Bloodsport (Field-Tested)",
  "AK-47 | Case Hardened (Field-Tested)",
  "M4A4 | Asiimov (Field-Tested)",
  "M4A4 | Neo-Noir (Field-Tested)",
  "M4A4 | The Emperor (Field-Tested)",
  "M4A1-S | Printstream (Field-Tested)",
  "M4A1-S | Hyper Beast (Field-Tested)",
  "M4A1-S | Golden Coil (Field-Tested)",

  // AWP
  "AWP | Dragon Lore (Field-Tested)",
  "AWP | Asiimov (Field-Tested)",
  "AWP | Wildfire (Field-Tested)",
  "AWP | Neo-Noir (Field-Tested)",
  "AWP | Containment Breach (Field-Tested)",
  "AWP | Fade (Factory New)",
  "AWP | Gungnir (Field-Tested)",

  // Пістолети та інше
  "Glock-18 | Fade (Factory New)",
  "USP-S | Kill Confirmed (Field-Tested)",
  "USP-S | Neo-Noir (Field-Tested)",
  "Desert Eagle | Printstream (Field-Tested)",
  "Desert Eagle | Blaze (Factory New)",
  "Desert Eagle | Code Red (Field-Tested)",
  "SSG 08 | Dragonfire (Field-Tested)",
  "MAC-10 | Neon Rider (Field-Tested)",
  "M4A4 | Howl (Field-Tested)",
];

module.exports = { ITEMS, TRADE_MARKUP };
