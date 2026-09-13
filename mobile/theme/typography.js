import { C } from './colors';

// Typography scale — weight and size carry the hierarchy; not everything bold.
export const fontSize = {
  xs: 12,
  sm: 13,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const T = {
  title:       { fontSize: 24, fontWeight: '700', letterSpacing: -0.5, color: C.text }, // screen title
  subtitle:    { fontSize: 14, color: C.muted },                                        // under titles
  sectionTitle:{ fontSize: 13, fontWeight: '700', color: C.muted, letterSpacing: 0.6, textTransform: 'uppercase' },
  cardTitle:   { fontSize: 15.5, fontWeight: '700', color: C.text },
  body:        { fontSize: 14, color: C.text },
  bodyStrong:  { fontSize: 15, fontWeight: '600', color: C.text },
  secondary:   { fontSize: 12.5, color: C.muted },
  label:       { fontSize: 13, fontWeight: '600', color: C.muted },                     // form labels
  badge:       { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  mono:        { fontSize: 12.5, color: C.text, fontVariant: ['tabular-nums'] },
  metric:      { fontSize: 22, fontWeight: '800', color: C.text, fontVariant: ['tabular-nums'] },
};
