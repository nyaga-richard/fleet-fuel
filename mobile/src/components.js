// ─────────────────────────────────────────────────────────────────────────────
// Reusable mobile UI kit — every screen is assembled from THESE components.
// All values come from ../theme (spacing · typography · radius · shadows).
// No arbitrary numbers in screens; no padding hacks; nothing fixed-height.
//
//   Screen · ScreenHeader · SectionHeader · Card · StatCard · RequestCard ·
//   TxnCard · StatusBadge · Btn · Input · Field · Chip · SearchBar ·
//   FilterButton · EmptyState · OfflineBanner · KV · Sheet · Confirm ·
//   useNetState · useDebounced · useTabBarPad
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView,
  Platform, StyleSheet, Modal, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as NetInfo from '@react-native-community/netinfo';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  C, spacing as SP, SCREEN_PAD, SCREEN_PAD_SM, SECTION_GAP, CARD_PAD, CARD_GAP,
  FIELD_GAP, INPUT_H, BTN_H, BTN_H_LG, BTN_H_SM, SEARCH_H, TABBAR_CONTENT_H,
  T, radius as R, shadowCard, shadowFloat, STATUS_COLOR, ICON,
} from '../theme';
import { fmtQty, fmtDateTime } from './fmt';

// App-wide icon (Material Community set — consistent stroke/weight).
// Icons ALWAYS accompany text labels (spec §13/§37: never the sole indicator).
export function Icon({ name, size = ICON.md, color = C.text, ...rest }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} {...rest} />;
}

// ── Hooks ────────────────────────────────────────────────────────────────────
export function useNetState() {
  const [net, setNet] = useState({ isConnected: true, checked: false });
  useEffect(() => {
    const unsub = NetInfo.addEventListener((st) => setNet({ isConnected: !!st.isConnected, checked: true }));
    NetInfo.fetch().then((st) => setNet({ isConnected: !!st.isConnected, checked: true }));
    return unsub;
  }, []);
  return net;
}

export function useDebounced(value, delay = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

// Bottom padding for scrollable content on tab screens: the REAL tab bar
// height (content + safe-area inset) + breathing room. Never a blind 100.
export function useTabBarPad(extra = SP.lg) {
  const insets = useSafeAreaInsets();
  return TABBAR_CONTENT_H + insets.bottom + extra;
}

// ── Screen scaffolding ───────────────────────────────────────────────────────
// Structure (spec §3): SafeArea → padding → Header → Search/Filters → Content.
// Horizontal padding is 16 (14 on very small devices) — computed, not random.
export function Screen({ children, keyboard = false, scroll = false, pad = true, style }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const padH = width < 350 ? SCREEN_PAD_SM : SCREEN_PAD;

  let body = <View style={[styles.flex, pad && { paddingHorizontal: padH }, style]}>{children}</View>;
  if (scroll) {
    body = (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[pad && { paddingHorizontal: padH, paddingTop: SP.sm }, { paddingBottom: SP.xxl + insets.bottom }, style]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }
  if (keyboard) {
    body = (
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {body}
      </KeyboardAvoidingView>
    );
  }
  return <SafeAreaView edges={['top', 'left', 'right']} style={styles.flex}>{body}</SafeAreaView>;
}

export function ScreenHeader({ title, subtitle, right }) {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={T.title} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={[T.subtitle, { marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
}

export function SectionHeader({ children, style }) {
  return <Text style={[T.sectionTitle, { marginBottom: SP.sm, marginTop: SP.xs }, style]}>{children}</Text>;
}

// ── Surfaces ─────────────────────────────────────────────────────────────────
export function Card({ children, onPress, style }) {
  const body = <View style={[styles.card, style]}>{children}</View>;
  if (!onPress) return body;
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} accessibilityRole="button">
      {body}
    </TouchableOpacity>
  );
}

// Compact KPI tile (spec §7): content-sized, no min-height.
export function StatCard({ label, value, tone = C.text, onPress, style }) {
  const body = (
    <View style={[styles.statCard, style]}>
      <Text style={[T.metric, { color: tone }]}>{value}</Text>
      <Text style={[T.sectionTitle, { marginTop: 2 }]} numberOfLines={2}>{label}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.85} onPress={onPress} accessibilityRole="button">
      {body}
    </TouchableOpacity>
  );
}

// ── Domain cards ─────────────────────────────────────────────────────────────
// Fuel request card (spec §6): scannable, grouped rows, whole card tappable.
export function RequestCard({ request, onPress }) {
  const r = request;
  return (
    <Card onPress={onPress}>
      <View style={styles.rowBetween}>
        <Text style={T.mono}>{r.request_no || 'pending sync'}</Text>
        <StatusBadge status={r.status} />
      </View>
      <Text style={[T.cardTitle, { fontSize: 16, marginTop: 6 }]} numberOfLines={1}>
        {r.plate || 'vehicle'}
        {!!r.driver_name && <Text style={T.secondary}> · {r.driver_name}</Text>}
      </Text>
      <View style={[styles.rowBetween, { marginTop: 6 }]}>
        <Text style={T.secondary}>{r.fuel_type_name || 'Fuel'}{r.destination ? ` · ${r.destination}` : ''}</Text>
        <Text style={[T.bodyStrong, { fontVariant: ['tabular-nums'] }]}>{fmtQty(r.quantity)}</Text>
      </View>
      <View style={[styles.rowBetween, { marginTop: SP.sm, paddingTop: SP.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderSoft }]}>
        <Text style={T.secondary}>{fmtDateTime(r.created_at)}</Text>
        <Text style={{ color: C.accent2, fontSize: 12.5, fontWeight: '600' }}>View details →</Text>
      </View>
    </Card>
  );
}

// Fuel transaction card.
export function TxnCard({ txn }) {
  const t = txn;
  return (
    <Card>
      <View style={styles.rowBetween}>
        <Text style={T.mono}>{t.txn_no || 'FT-…'}</Text>
        <StatusBadge status={t.status} />
      </View>
      <View style={[styles.rowBetween, { marginTop: 6 }]}>
        <Text style={T.cardTitle} numberOfLines={1}>{t.plate || '—'}</Text>
        <Text style={[T.bodyStrong, { fontVariant: ['tabular-nums'] }]}>{fmtQty(t.quantity)}</Text>
      </View>
      <Text style={[T.secondary, { marginTop: 4 }]}>{t.fuel_type_name || ''}{t.pump_name ? ` · ${t.pump_name}` : ''} · {fmtDateTime(t.created_at)}</Text>
    </Card>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  const color = STATUS_COLOR[status] || C.muted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[T.badge, { color }]}>{String(status || '—').replace(/_/g, ' ')}</Text>
    </View>
  );
}

export function Btn({ label, onPress, variant = 'primary', busy, disabled, small, large, icon, style }) {
  const bg = { primary: C.accent, secondary: C.panel2, success: C.green, danger: C.red, warn: C.amber }[variant] || C.accent;
  const off = disabled || busy;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={[styles.btn, { backgroundColor: bg, height: small ? BTN_H_SM : large ? BTN_H_LG : BTN_H, opacity: off ? 0.5 : 1 }, style]}
    >
      {busy ? <ActivityIndicator color="#fff" size="small" /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {!!icon && <Icon name={icon} size={small ? ICON.sm : ICON.md} color="#ffffff" />}
          <Text style={styles.btnText}>{label}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export function Input(props) {
  return <TextInput placeholderTextColor={C.muted} {...props} style={[styles.input, props.style]} />;
}

export function Field({ label, hint, error, children }) {
  return (
    <View style={{ marginBottom: FIELD_GAP }}>
      {!!label && <Text style={[T.label, { marginBottom: 6 }]}>{label}</Text>}
      {children}
      {!!error && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <Icon name="alert-circle" size={ICON.sm} color={C.red} />
          <Text style={styles.fieldError}>{error}</Text>
        </View>
      )}
      {!!hint && !error && <Text style={styles.fieldHint}>{hint}</Text>}
    </View>
  );
}

export function Chip({ label, active, onPress, sub }) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipOn]}
    >
      <Text style={[styles.chipText, active && { color: '#fff', fontWeight: '700' }]}>{label}</Text>
      {!!sub && <Text style={[styles.chipSub, active && { color: '#dbeafe' }]}>{sub}</Text>}
    </TouchableOpacity>
  );
}

export function SearchBar({ value, onChange, placeholder = 'Search…', autoFocus = false }) {
  return (
    <View style={styles.searchWrap}>
      <Icon name="magnify" size={ICON.md} color={C.muted} style={styles.searchIcon} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.muted}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        style={styles.searchInput}
      />
      {!!value && (
        <TouchableOpacity onPress={() => onChange('')} accessibilityLabel="Clear search" style={styles.searchClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="close" size={ICON.md} color={C.muted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

export function FilterButton({ count, onPress }) {
  const on = count > 0;
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Open filters"
      style={[styles.filterBtn, on && styles.filterBtnOn]}
    >
      <Text style={[styles.filterBtnText, on && { color: '#fff' }]}>
        <Icon name="cog-outline" size={ICON.sm} color={on ? '#ffffff' : C.muted} />
        Filters{on ? ` · ${count}` : ''}</Text>
    </TouchableOpacity>
  );
}

// ── States ───────────────────────────────────────────────────────────────────
// Collapsible filter container (§12/§13/§36): collapsed by default with a
// one-line summary of active filters — data owns the screen, not the form.
export function FilterBar({ summary, count = 0, children, style }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[{ marginBottom: SP.md }, style]}>
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={(open ? 'Hide' : 'Show') + ` filters, ${count} active`}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: SP.sm,
          minHeight: BTN_H, paddingHorizontal: CARD_PAD, borderRadius: 14,
          backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
        }}
      >
        <Icon name="tune" size={ICON.md} color={C.accent2} />
        <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>Filters</Text>
        {count > 0 && (
          <View style={{ backgroundColor: C.accent, borderRadius: 10, minWidth: 20, height: 20, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{count}</Text>
          </View>
        )}
        {!!summary && !open && (
          <Text style={{ color: C.muted, fontSize: 12, flex: 1 }} numberOfLines={1}>{summary}</Text>
        )}
        <View style={{ flex: summary && !open ? 0 : 1 }} />
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={ICON.md} color={C.muted} />
      </TouchableOpacity>
      {open && (
        <View style={{
          marginTop: SP.sm, padding: CARD_PAD, borderRadius: 14,
          backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
        }}>
          {children}
        </View>
      )}
    </View>
  );
}

export function EmptyState({ icon = 'circle-outline', title, message, action }) {
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={ICON.xxl} color={C.muted} style={{ marginBottom: SP.sm }} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {!!message && <Text style={styles.emptyMsg}>{message}</Text>}
      {action}
    </View>
  );
}

export function OfflineBanner({ lastSync }) {
  const net = useNetState();
  if (net.checked && net.isConnected) return null;
  return (
    <View style={[styles.offline, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
      <Icon name="cloud-off-outline" size={ICON.md} color="#fcd34d" />
      <Text style={[styles.offlineText, { flex: 1 }]}>
        Offline — changes are saved on this device and will sync automatically{lastSync ? ` · last sync ${fmtRelShort(lastSync)}` : ''}
      </Text>
    </View>
  );
}

function fmtRelShort(s) {
  const secs = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  return `${Math.floor(secs / 3600)} h ago`;
}

// Key/value rows — grouped details (spec §15).
export function KV({ rows }) {
  return (
    <View>
      {rows.filter((r) => r && r[1] !== undefined && r[1] !== null).map(([k, v], i) => (
        <View key={`${k}${i}`} style={styles.kvRow}>
          <Text style={[T.secondary, { flexShrink: 1 }]}>{k}</Text>
          <Text style={[T.body, { textAlign: 'right', flexShrink: 2, fontWeight: '600' }]}>{v === '' ? '—' : v}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Bottom sheet — safe-area aware, keyboard aware, scrollable (spec §22) ───
export function Sheet({ visible, onClose, title, children, footer, maxHeight = '88%' }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetWrap}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} accessibilityLabel="Close" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetKav}>
          <View style={[styles.sheet, { maxHeight }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHead}>
              <Text style={[T.cardTitle, { fontSize: 17 }]}>{title}</Text>
              <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Icon name="close" size={ICON.lg} color={C.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: SCREEN_PAD, paddingTop: SP.md, paddingBottom: SP.xl + insets.bottom }}>
              {children}
            </ScrollView>
            {!!footer && (
              <View style={[styles.sheetFoot, { paddingBottom: insets.bottom + SP.md }]}>
                {footer}
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ── Searchable selector (spec §15–20) ────────────────────────────────────────
// Closed: a 50px field showing the selection. Tap → bottom sheet with a
// prominent auto-focused search and full-width 52px result rows (✓ on the
// selected one). Case-insensitive partial search across title+sub. Honest
// offline behaviour: an empty cached list shows the sync hint — never fake data.
export function SelectField({ label, placeholder = 'Select…', value, onChange, options = [], emptyHint, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = options.find((o) => o.value === value) || null;
  const term = q.trim().toLowerCase();
  const list = term
    ? options.filter((o) =>
        String(o.label || '').toLowerCase().includes(term)
        || String(o.sub || '').toLowerCase().includes(term))
    : options;

  function pick(v) { setOpen(false); setQ(''); onChange(v); }

  return (
    <View style={{ marginBottom: FIELD_GAP }}>
      {!!label && <Text style={[T.label, { marginBottom: 6 }]}>{label}</Text>}
      <TouchableOpacity
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label || 'Select'}: ${selected?.label || placeholder}`}
        style={[styles.selectField, disabled && { opacity: 0.5 }]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          {selected
            ? <>
                <Text style={T.body} numberOfLines={1}>{selected.label}</Text>
                {!!selected.sub && <Text style={T.secondary} numberOfLines={1}>{selected.sub}</Text>}
              </>
            : <Text style={[T.body, { color: C.muted }]}>{placeholder}</Text>}
        </View>
        <Icon name="chevron-down" size={ICON.md} color={C.muted} />
      </TouchableOpacity>

      <Sheet visible={open} onClose={() => { setOpen(false); setQ(''); }} title={label ? `Select ${String(label).replace(/\s*\*$/, '')}` : 'Select'}>
        <SearchBar value={q} onChange={setQ} placeholder="Type to search…" autoFocus />
        {options.length === 0 && (
          <EmptyState icon="cloud-off-outline" title="Nothing available" message={emptyHint || 'No records are cached on this device yet. Sync first, then try again.'} />
        )}
        {options.length > 0 && list.length === 0 && (
          <EmptyState icon="text-search" title={`No matches for “${q.trim()}”`} message="Try a different spelling or clear the search." />
        )}
        {list.map((o) => {
          const on = o.value === value;
          return (
            <TouchableOpacity
              key={String(o.value)}
              onPress={() => pick(o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.selectRow, on && styles.selectRowOn]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[T.bodyStrong, on && { color: C.accent2 }]} numberOfLines={1}>{o.label}</Text>
                {!!o.sub && <Text style={T.secondary} numberOfLines={1}>{o.sub}</Text>}
              </View>
              {on && <Icon name="check-bold" size={ICON.md} color={C.accent2} />}
            </TouchableOpacity>
          );
        })}
        {!!value && (
          <Btn label="Clear selection" variant="secondary" small onPress={() => pick('')} style={{ marginTop: SP.md }} />
        )}
      </Sheet>
    </View>
  );
}

// ── Confirm dialog ───────────────────────────────────────────────────────────
export function Confirm({ visible, title, message, danger, busy, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onCancel}>
      <View style={styles.confirmWrap}>
        <View style={styles.confirmCard}>
          <Text style={[T.cardTitle, { fontSize: 16, marginBottom: 6 }]}>{title}</Text>
          {!!message && <Text style={T.secondary}>{message}</Text>}
          <View style={{ flexDirection: 'row', gap: SP.md, marginTop: SECTION_GAP - 6 }}>
            <View style={{ flex: 1 }}><Btn label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} /></View>
            <View style={{ flex: 1 }}><Btn label={busy ? 'Working…' : confirmLabel} variant={danger ? 'danger' : 'primary'} busy={busy} onPress={onConfirm} /></View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Styles — composed ONLY from theme tokens ─────────────────────────────────
// Rebuilt when the appearance changes so re-mounted screens pick up the new
// palette (§31–§40). Everything else in this file reads C at render time.
let styles;
function buildStyles() {
 styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SP.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: SP.md, paddingTop: SP.sm, paddingBottom: SP.md },

  card: {
    backgroundColor: C.panel, borderColor: C.borderSoft, borderWidth: 1,
    borderRadius: R.lg, padding: CARD_PAD, marginBottom: CARD_GAP, ...shadowCard,
  },
  statCard: {
    backgroundColor: C.panel, borderColor: C.borderSoft, borderWidth: 1,
    borderLeftWidth: 3, borderLeftColor: C.accent,
    borderRadius: R.lg, padding: CARD_PAD - 2, ...shadowCard,
  },

  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: R.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },

  btn: { borderRadius: R.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SP.lg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15, letterSpacing: 0.2 },

  input: {
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: R.md,
    color: C.text, paddingHorizontal: SCREEN_PAD - 2, minHeight: INPUT_H, fontSize: 15,
  },
  fieldError: { color: C.red, fontSize: T.badge.fontSize + 1.5, marginTop: 6, fontWeight: '600' },
  fieldHint: { color: C.muted, fontSize: 11.5, marginTop: 6 },

  chip: {
    borderColor: C.border, borderWidth: 1, borderRadius: R.xl, paddingHorizontal: 14,
    minHeight: 40, backgroundColor: C.bg, justifyContent: 'center',
  },
  chipOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  chipText: { color: C.text, fontSize: 13 },
  chipSub: { color: C.muted, fontSize: 10.5 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel,
    borderColor: C.border, borderWidth: 1, borderRadius: R.md, paddingHorizontal: 14,
    height: SEARCH_H, marginBottom: SP.md,
  },
  searchIcon: { fontSize: 13, marginRight: SP.sm },
  searchInput: { flex: 1, color: C.text, fontSize: 15, paddingVertical: 0 },
  searchClear: { padding: SP.sm },

  filterBtn: {
    borderColor: C.border, borderWidth: 1, borderRadius: R.xl, paddingHorizontal: 14,
    minHeight: 40, justifyContent: 'center', backgroundColor: C.bg,
  },
  filterBtnOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  filterBtnText: { color: C.text, fontSize: 13, fontWeight: '600' },

  empty: { alignItems: 'center', paddingVertical: 44, paddingHorizontal: SP.xxl },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700', marginBottom: 6, textAlign: 'center' },
  emptyMsg: { color: C.muted, fontSize: 13, textAlign: 'center', marginBottom: SP.lg },

  offline: { backgroundColor: C.warnBg, borderColor: C.amber, borderWidth: 1, borderRadius: R.md, padding: 10, marginBottom: SP.md },
  offlineText: { color: '#fcd34d', fontSize: 12 },

  kvRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderSoft, gap: SP.md,
  },

  selectField: {
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: R.md,
    paddingHorizontal: SCREEN_PAD - 2, minHeight: INPUT_H, flexDirection: 'row',
    alignItems: 'center', gap: SP.sm,
  },
  selectRow: {
    flexDirection: 'row', alignItems: 'center', gap: SP.md, minHeight: 52,
    paddingHorizontal: SCREEN_PAD - 4, paddingVertical: SP.sm,
    borderRadius: R.md, marginBottom: 2,
  },
  selectRowOn: { backgroundColor: C.accentSoft },
  sheetWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  sheetKav: { justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.panel, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl,
    borderTopWidth: 1, borderColor: C.border, height: 'auto', ...shadowFloat,
  },
  sheetHandle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.border, marginTop: SP.sm },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: SCREEN_PAD, paddingTop: SP.md, paddingBottom: SP.sm },
  sheetFoot: { borderTopWidth: 1, borderTopColor: C.border, paddingTop: SP.md, flexDirection: 'row', gap: SP.md, paddingHorizontal: SCREEN_PAD },

  confirmWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,.66)', alignItems: 'center', justifyContent: 'center', padding: SP.xxl },
  confirmCard: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: R.lg, padding: SP.xxl, width: '100%', maxWidth: 400, ...shadowFloat },
 });
}
buildStyles();
export { buildStyles as rebuildComponentStyles };
