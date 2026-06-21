const MARKET_CATEGORIES = Object.freeze([
  { id: 'all', label: 'All items' },
  { id: 'materials', label: 'Materials' },
  { id: 'food', label: 'Food' },
  { id: 'potions', label: 'Potions' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'cosmetics', label: 'Cosmetics' },
  { id: 'mounts', label: 'Mounts' },
  { id: 'pets', label: 'Pets' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'gold', label: 'Gold' },
  { id: 'other', label: 'Other' },
]);

const MATERIAL_ITEMS = new Set(['wood', 'stone', 'coal', 'metal']);
const FOOD_ITEMS = new Set(['fish', 'cooked_fish_meat']);
const EQUIPMENT_HINTS = ['axe', 'pickaxe', 'rod', 'hammer', 'sword', 'weapon', 'tool'];

function listingItemType(listing) {
  return String(listing?.itemType || listing?.item || '').trim().toLowerCase();
}

function marketCategoryForItem(itemType) {
  const item = String(itemType || '').trim().toLowerCase();
  if (MATERIAL_ITEMS.has(item)) return 'materials';
  if (FOOD_ITEMS.has(item)) return 'food';
  if (item.startsWith('potion_')) return 'potions';
  if (item === 'gold') return 'gold';
  if (item.startsWith('mount_')) return 'mounts';
  if (item.startsWith('pet_')) return 'pets';
  if (item.startsWith('furniture_') || item.includes('throne') || item.includes('marble_wall') || item.includes('gate')) return 'furniture';
  if (item.startsWith('cosmetic_') || item.startsWith('outfit_') || item.includes('wearable')) return 'cosmetics';
  if (EQUIPMENT_HINTS.some((hint) => item.includes(hint))) return 'equipment';
  return 'other';
}

function filterListingsByCategory(listings, category) {
  if (category === 'all') return [...listings];
  return listings.filter((listing) => marketCategoryForItem(listingItemType(listing)) === category);
}

function listingCurrency(listing) {
  return listing?.currency === 'token' || listing?.currency === 'kins' ? 'token' : 'gold';
}

function listingUnitPrice(listing) {
  const quantity = Number(listing?.quantity);
  const total = listingCurrency(listing) === 'token' ? Number(listing?.priceUsd) : Number(listing?.priceGold);
  return Number.isFinite(quantity) && quantity > 0 && Number.isFinite(total) ? total / quantity : Number.POSITIVE_INFINITY;
}

function sortListingsCheapest(listings) {
  return [...listings].sort((a, b) => {
    const currencyOrder = Number(listingCurrency(a) === 'token') - Number(listingCurrency(b) === 'token');
    if (currencyOrder) return currencyOrder;
    return listingUnitPrice(a) - listingUnitPrice(b);
  });
}

function availableMarketCategories(listings) {
  const available = new Set(listings.map((listing) => marketCategoryForItem(listingItemType(listing))));
  return MARKET_CATEGORIES.filter((category) => category.id === 'all' || available.has(category.id));
}

module.exports = {
  MARKET_CATEGORIES,
  availableMarketCategories,
  filterListingsByCategory,
  listingCurrency,
  listingItemType,
  listingUnitPrice,
  marketCategoryForItem,
  sortListingsCheapest,
};
