const MARKET_CATEGORIES = Object.freeze([
  { id: 'all', label: 'All categories' },
  { id: 'cat_gold', label: 'Gold' },
  { id: 'cat_mounts', label: 'Mounts' },
  { id: 'cat_cosmetics', label: 'Cosmetics' },
  { id: 'cat_materials', label: 'Materials' },
  { id: 'cat_potions', label: 'Potions' },
  { id: 'cat_food', label: 'Food' },
  { id: 'cat_keys', label: 'Keys' },
  { id: 'cat_pets', label: 'Pets' },
  { id: 'cat_furni', label: 'Furni' },
]);

function listingCurrency(listing) {
  return listing?.currency === 'token' || listing?.currency === 'kins' ? 'token' : 'gold';
}

function listingUnitPrice(listing) {
  const quantity = Number(listing?.quantity);
  const total = listingCurrency(listing) === 'token' ? Number(listing?.priceUsd) : Number(listing?.priceGold);
  return Number.isFinite(quantity) && quantity > 0 && Number.isFinite(total) ? total / quantity : Number.POSITIVE_INFINITY;
}

function formatMarketNumber(value, digits) {
  return Number(value).toFixed(digits).replace(/\.?0+$/, '');
}

function formatListingUnitPrice(listing) {
  const unitPrice = listingUnitPrice(listing);
  if (!Number.isFinite(unitPrice)) return '?/unit';
  const digits = unitPrice >= 1 ? 2 : unitPrice >= 0.01 ? 4 : unitPrice >= 0.0001 ? 6 : 8;
  const formatted = formatMarketNumber(unitPrice, digits);
  return listingCurrency(listing) === 'token' ? `$${formatted}/unit` : `${formatted}g/unit`;
}

module.exports = {
  formatListingUnitPrice,
  MARKET_CATEGORIES,
  listingCurrency,
  listingUnitPrice,
};
