// ============ INVENTORY SNAPSHOT HELPERS ============
// Keep only slot arrays needed by read-only status surfaces.
const SLOT_KEYS = ['invSlots', 'mountSlots', 'cosmeticSlots', 'petSlots', 'furnitureSlots'];

function cloneSlot(slot) {
  if (!slot || typeof slot !== 'object') return slot || null;
  return { ...slot };
}

function cloneSlots(slots) {
  if (!Array.isArray(slots)) return null;
  return slots.map(cloneSlot);
}

function pickInventorySnapshot(backpack = {}) {
  const snapshot = {};
  for (const key of SLOT_KEYS) {
    const slots = cloneSlots(backpack?.[key]);
    if (slots) snapshot[key] = slots;
  }
  return snapshot;
}

module.exports = { SLOT_KEYS, pickInventorySnapshot };
