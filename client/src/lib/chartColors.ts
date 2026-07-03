// Balance categorical palette — warm-harmonious hues extending off the
// semantic anchors (gold/slate/amber/clay), for charts with more series
// than the four status colors alone can distinguish. Single source of
// truth so every chart/legend uses the same category-to-color mapping.
export const CHART_COLORS = [
  '#c9963a', // gold (positive)
  '#7c8b99', // warm slate (info)
  '#ce8642', // amber (warning)
  '#b5654a', // clay/rust (negative)
  '#a78bfa', // muted violet
  '#f472b6', // dusty pink
  '#34d399', // soft moss
  '#fb923c', // burnt orange
  '#60a5fa', // dusty blue
  '#f87171', // soft red
];

// 4-color subset for asset-class-style breakdowns (liquid / investments / crypto / other).
export const ASSET_COLORS = [CHART_COLORS[0], CHART_COLORS[1], CHART_COLORS[2], '#9b8dee'];
