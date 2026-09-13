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
  "★ Karambit | Doppler (Factory New) - Phase 2",
  "★ M9 Bayonet | Doppler (Factory New) - Phase 2",
  "★ Karambit | Tiger Tooth (Factory New)",
  "★ Talon Knife | Marble Fade (Factory New)",
  "★ Skeleton Knife | Slaughter (Minimal Wear)",
  "★ Flip Knife | Doppler (Factory New) - Phase 4",
  "★ Bayonet | Tiger Tooth (Factory New)",
  "★ Huntsman Knife | Fade (Factory New)",

  // Рукавиці
  "★ Sport Gloves | Pandora's Box (Field-Tested)",
  "★ Specialist Gloves | Crimson Kimono (Field-Tested)",

  // Гвинтівки
  "AK-47 | Fire Serpent (Field-Tested)",
  "AK-47 | Asiimov (Field-Tested)",
  "AK-47 | Redline (Field-Tested)",
  "M4A4 | Asiimov (Field-Tested)",
  "M4A1-S | Printstream (Field-Tested)",
  "M4A1-S | Hyper Beast (Field-Tested)",

  // AWP
  "AWP | Dragon Lore (Field-Tested)",
  "AWP | Asiimov (Field-Tested)",
  "AWP | Wildfire (Field-Tested)",
  "AWP | Neo-Noir (Field-Tested)",

  // Пістолети
  "Glock-18 | Fade (Factory New)",
  "USP-S | Kill Confirmed (Field-Tested)",
  "Desert Eagle | Printstream (Field-Tested)",
];

module.exports = { ITEMS, TRADE_MARKUP };
