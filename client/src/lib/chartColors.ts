// Balance categorical palette — sage anchors the positive/asset side, clay the
// negative, gold the caution/crypto slot, then warm tans and muted neighbors
// for charts with more series. Single source of truth so every chart/legend
// uses the same category-to-color mapping.
export const CHART_COLORS = [
  '#7c8b6f', // sage (primary accent)
  '#c9963a', // gold
  '#b5654a', // clay scale
  '#a7bb92', // light sage
  '#cbb08a', // tan
  '#8a4a38', // deep clay
  '#5c7050', // deep sage
  '#cdbfa6', // warm sand
  '#a89a84', // muted stone
  '#7c8b99', // warm slate
];

// 4-color subset for asset-class-style breakdowns (liquid / investments / crypto / other).
export const ASSET_COLORS = ['#7c8b6f', '#a7bb92', '#c9963a', '#cdbfa6'];
