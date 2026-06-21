const POTION_TYPES = Object.freeze({
  health: 'potion_health',
  shield: 'potion_shield',
  strength: 'potion_strength',
  poison: 'potion_poison',
});

const POTION_LABELS = Object.freeze({
  potion_health: 'Health',
  potion_shield: 'Shield',
  potion_strength: 'Strength',
  potion_poison: 'Poison',
});

function normalizePotionType(value) {
  const key = String(value || '').trim().toLowerCase();
  if (POTION_TYPES[key]) return POTION_TYPES[key];
  return Object.values(POTION_TYPES).includes(key) ? key : null;
}

function parsePotionQuantity(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const quantity = Number(text);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 999 ? quantity : null;
}

module.exports = { POTION_TYPES, POTION_LABELS, normalizePotionType, parsePotionQuantity };
