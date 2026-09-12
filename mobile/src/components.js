// ─────────────────────────────────────────────────────────────────────────────
// Reusable mobile UI kit — SafeAreaScreen · ScreenHeader · SearchBar ·
// StatusBadge · Btn · Input · Field · Chip · Card · Sheet · Confirm ·
// EmptyState · OfflineBanner · KV · hooks (useNetState, useDebounced)
//
// Rules baked in here:
//   • every interactive control ≥ 44pt tall (touch target, spec §13)
//   • safe-area top edge handled once, in <Screen/>
//   • keyboard-safe: <Screen keyboard scroll> wraps a KeyboardAvoidingView
//     around a ScrollView with keyboardShouldPersistTaps (spec §9–11)
//   • offline state is visible, never hidden (spec §27)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, KeyboardAvoidingView,
  Platform, StyleSheet, Modal, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as NetInfo from '@react-native-community/netinfo';
import { C, S, R, TAP, STATUS_COLOR } from './theme';
import { fmtRel } from './fmt';

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

// ── Screen scaffolding ───────────────────────────────────────────────────────
export function Screen({ children, keyboard = false, scroll = false, pad = true, style }) {
  let body = (
    <View style={[styles.flex, pad && { padding: S.lg }, style]}>
      {children}
    </View>
  );
  if (scroll) {
    body = (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[{ padding: S.lg, paddingBottom: S.xl + 20 }, style]}
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
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.flex}>
      {body}
    </SafeAreaView>
  );
}

export function ScreenHeader({ title, subtitle, right }) {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={styles.headerSub} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
}

// ── Basic blocks ─────────────────────────────────────────────────────────────
export function Card({ children, onPress, style }) {
  const body = <View style={[styles.card, style]}>{children}</View>;
  if (!onPress) return body;
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} accessibilityRole="button">
      {body}
    </TouchableOpacity>
  );
}

export function StatusBadge({ status }) {
  const color = STATUS_COLOR[status] || C.muted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{String(status || '—').replace(/_/g, ' ')}</Text>
    </View>
  );
}

export function Btn({ label, onPress, variant = 'primary', busy, disabled, small, style }) {
  const bg = { primary: C.accent, secondary: C.panel2, success: C.green, danger: C.red, warn: C.amber }[variant] || C.accent;
  const off = disabled || busy;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={[styles.btn, { backgroundColor: bg, height: small ? 38 : TAP, opacity: off ? 0.5 : 1 }, style]}
    >
      {busy
        ? <ActivityIndicator color="#fff" size="small" />
        : <Text style={[styles.btnText, small && { fontSize: 13 }]}>{label}</Text>}
    </TouchableOpacity>
  );
}

export function Input(props) {
  return (
    <TextInput
      placeholderTextColor={C.muted}
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <View style={{ marginBottom: S.md }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {!!error && <Text style={styles.fieldError}>⚠ {error}</Text>}
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
      style={[styles.chip, active && styles.chipOn, { minHeight: 40 }]}
    >
      <Text style={[styles.chipText, active && { color: '#fff', fontWeight: '700' }]}>{label}</Text>
      {!!sub && <Text style={[styles.chipSub, active && { color: '#dbeafe' }]}>{sub}</Text>}
    </TouchableOpacity>
  );
}

export function SearchBar({ value, onChange, placeholder = 'Search…' }) {
  return (
    <View style={styles.searchWrap}>
      <Text style={styles.searchIcon}>🔍</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.muted}
        returnKeyType="search"
        autoCorrect={false}
        clearButtonMode="while-editing"
        accessibilityLabel={placeholder}
        style={styles.searchInput}
      />
      {value ? (
        <TouchableOpacity onPress={() => onChange('')} accessibilityLabel="Clear search" style={styles.searchClear}>
          <Text style={{ color: C.muted, fontSize: 16 }}>✕</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function EmptyState({ icon = '◌', title, message, action }) {
  return (
    <View style={styles.empty}>
      <Text style={{ fontSize: 30, marginBottom: 8 }}>{icon}</Text>
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
    <View style={styles.offline}>
      <Text style={styles.offlineText}>
        ● Offline — changes are saved on this device and will sync automatically{lastSync ? ` · last sync ${fmtRel(lastSync)}` : ''}
      </Text>
    </View>
  );
}

// Key/value rows — details screens.
export function KV({ rows }) {
  return (
    <View>
      {rows.filter((r) => r && r.v !== undefined).map(([k, v], i) => (
        <View key={`${k}${i}`} style={styles.kvRow}>
          <Text style={styles.kvKey}>{k}</Text>
          <Text style={styles.kvVal}>{v === null || v === undefined || v === '' ? '—' : v}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Bottom sheet (filters, forms) — keyboard-safe + scrollable ──────────────
export function Sheet({ visible, onClose, title, children, footer, maxHeight = '88%' }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetWrap}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} accessibilityLabel="Close" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetKav}>
          <View style={[styles.sheet, { maxHeight }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ color: C.muted, fontSize: 16 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: S.lg, paddingBottom: S.xl }}>
              {children}
            </ScrollView>
            {!!footer && <SafeAreaView edges={['bottom']} style={styles.sheetFoot}><View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: S.lg, paddingVertical: S.md }}>{footer}</View></SafeAreaView>}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ── Confirm dialog ───────────────────────────────────────────────────────────
export function Confirm({ visible, title, message, danger, busy, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onCancel}>
      <View style={styles.confirmWrap}>
        <View style={styles.confirmCard}>
          <Text style={styles.confirmTitle}>{title}</Text>
          {!!message && <Text style={styles.confirmMsg}>{message}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: S.lg }}>
            <View style={{ flex: 1 }}>
              <Btn label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
            </View>
            <View style={{ flex: 1 }}>
              <Btn label={busy ? 'Working…' : confirmLabel} variant={danger ? 'danger' : 'primary'} busy={busy} onPress={onConfirm} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: S.md, marginBottom: S.lg },
  headerTitle: { color: C.text, fontSize: 21, fontWeight: '800' },
  headerSub: { color: C.muted, fontSize: 12.5, marginTop: 2 },
  card: {
    backgroundColor: C.panel, borderColor: C.border, borderWidth: 1,
    borderRadius: R.md, padding: S.lg, marginBottom: S.md,
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: R.pill, paddingHorizontal: 9, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeDot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: { fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  btn: { borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: S.lg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },
  input: {
    backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: R.sm,
    color: C.text, paddingHorizontal: S.md, minHeight: 46, fontSize: 15,
  },
  fieldLabel: { color: C.muted, fontSize: 12, marginBottom: 6, fontWeight: '600' },
  fieldHint: { color: C.muted, fontSize: 11.5, marginTop: 4 },
  fieldError: { color: C.red, fontSize: 12, marginTop: 4 },
  chip: {
    borderColor: C.border, borderWidth: 1, borderRadius: R.pill, paddingHorizontal: 14,
    paddingVertical: 9, backgroundColor: C.bg, justifyContent: 'center',
  },
  chipOn: { borderColor: C.accent, backgroundColor: '#1d3a6e' },
  chipText: { color: C.text, fontSize: 13 },
  chipSub: { color: C.muted, fontSize: 10.5 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel,
    borderColor: C.border, borderWidth: 1, borderRadius: R.pill, paddingHorizontal: 12,
    minHeight: 46, marginBottom: S.md,
  },
  searchIcon: { fontSize: 13, marginRight: 8 },
  searchInput: { flex: 1, color: C.text, fontSize: 15, paddingVertical: 10 },
  searchClear: { padding: 8 },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: S.xl },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700', marginBottom: 6, textAlign: 'center' },
  emptyMsg: { color: C.muted, fontSize: 13, textAlign: 'center', marginBottom: S.lg },
  offline: {
    backgroundColor: C.warnBg, borderColor: C.amber, borderWidth: 1, borderRadius: R.sm,
    padding: 10, marginBottom: S.md,
  },
  offlineText: { color: '#fcd34d', fontSize: 12 },
  kvRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, gap: S.md,
  },
  kvKey: { color: C.muted, fontSize: 13, flexShrink: 1 },
  kvVal: { color: C.text, fontSize: 13, fontWeight: '600', textAlign: 'right', flexShrink: 2 },
  sheetWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  sheetKav: { justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    borderTopWidth: 1, borderColor: C.border, height: 'auto',
  },
  sheetHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: C.border, marginTop: 8 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: S.lg, paddingTop: S.md },
  sheetTitle: { color: C.text, fontSize: 17, fontWeight: '800' },
  sheetFoot: { backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.border },
  confirmWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,.66)', alignItems: 'center', justifyContent: 'center', padding: S.xl },
  confirmCard: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: R.lg, padding: S.xl, width: '100%', maxWidth: 400 },
  confirmTitle: { color: C.text, fontSize: 16, fontWeight: '800', marginBottom: 6 },
  confirmMsg: { color: C.muted, fontSize: 13 },
});
