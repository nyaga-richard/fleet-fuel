// Spacing system — the ONLY spacing values used in the app.
// Hierarchy: xs/sm glue elements together · md/lg separate related items ·
// xl/xxl separate sections · xxxl separates major regions.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

// Semantic layout constants (composed from the scale above).
export const SCREEN_PAD = 16;      // horizontal screen margin (14 on small devices)
export const SCREEN_PAD_SM = 14;
export const SECTION_GAP = 20;     // vertical space between sections
export const CARD_PAD = 16;        // card inner padding
export const CARD_GAP = 12;        // card-to-card margin
export const FIELD_GAP = 14;       // between form fields

// Control sizes — comfortable touch targets without being bulky.
export const INPUT_H = 48;
export const BTN_H = 48;
export const BTN_H_LG = 52;        // important actions (ISSUE FUEL, COMPLETE)
export const BTN_H_SM = 38;
export const SEARCH_H = 46;
export const TABBAR_CONTENT_H = 56; // tab bar height BEFORE the safe-area inset
