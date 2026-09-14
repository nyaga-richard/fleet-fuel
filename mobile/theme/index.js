// ─────────────────────────────────────────────────────────────────────────────
// Fleet Fuel mobile design system — import EVERYTHING from here:
//
//   import { C, spacing, T, radius, shadowCard, BTN_H, STATUS_COLOR } from '../theme';
//
// No arbitrary padding/margin/font values in screens. Ever.
// ─────────────────────────────────────────────────────────────────────────────
export { C } from './colors';
export { spacing, SCREEN_PAD, SCREEN_PAD_SM, SECTION_GAP, CARD_PAD, CARD_GAP, FIELD_GAP, INPUT_H, BTN_H, BTN_H_LG, BTN_H_SM, SEARCH_H, TABBAR_CONTENT_H } from './spacing';
export { fontSize, T } from './typography';
export { ICON } from './icons';
export { radius } from './radius';
export { shadowCard, shadowFloat } from './shadows';

export const STATUS_COLOR = {
  pending: '#f59e0b',
  approved: '#22c55e',
  authorized: '#22c55e',
  issued: '#3b82f6',
  rejected: '#ef4444',
  cancelled: '#8fa0b8',
  completed: '#22c55e',
  reversed: '#ef4444',
  opening: '#a78bfa',
  receipt: '#22c55e',
  issue: '#f59e0b',
  adjustment: '#eab308',
  reversal: '#38bdf8',
};
