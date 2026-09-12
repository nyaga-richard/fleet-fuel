import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TextInput, TouchableOpacity, Modal, Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  cachedRequests, cachedVehicles, cachedFuelTypes, enqueue, outboxCount,
} from '../../src/db';
import { fullSync } from '../../src/sync';

const C = {
  bg: '#0b1220', panel: '#14203a', border: '#24344f', text: '#e6ecf5',
  muted: '#8fa0b8', accent: '#3b82f6', green: '#22c55e', amber: '#f59e0b', red: '#ef4444',
};

const STATUS_COLOR = {
  pending: C.amber, approved: C.green, issued: C.accent,
  rejected: C.red, cancelled: C.muted,
};

export default function RequestsScreen() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    setRows(await cachedRequests(100));
    setPendingCount(await outboxCount());
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.button} onPress={() => setModal(true)}>
        <Text style={styles.buttonText}>+ New fuel request</Text>
      </TouchableOpacity>
      {pendingCount > 0 && (
        <Text style={styles.pendingNote}>⏳ {pendingCount} queued change(s) will sync automatically</Text>
      )}
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{item.request_no || 'local'}</Text>
              <Text style={[styles.badge, { color: STATUS_COLOR[item.status] || C.muted, borderColor: STATUS_COLOR[item.status] || C.muted }]}>
                {item.status}
              </Text>
            </View>
            <Text style={styles.cardMain}>{item.plate || 'vehicle'} — {Number(item.quantity).toLocaleString()} L</Text>
            <Text style={styles.muted}>{item.driver_name || ''} · {new Date(item.created_at).toLocaleString()}</Text>
          </View>
        )}
        ListEmptyComponent={(
          <Text style={styles.muted}>No requests on this device yet. Pull down on Home to sync, or create one.</Text>
        )}
      />

      <NewRequestModal
        visible={modal}
        onClose={() => setModal(false)}
        onSaved={() => { load(); fullSync(); }}
        user={user}
      />
    </View>
  );
}

function NewRequestModal({ visible, onClose, onSaved, user }) {
  const [vehicles, setVehicles] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [vehicleId, setVehicleId] = useState(null);
  const [fuelId, setFuelId] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [destination, setDestination] = useState('');

  useFocusEffect(useCallback(() => {
    (async () => { setVehicles(await cachedVehicles()); setFuels(await cachedFuelTypes()); })();
  }, [visible]));

  async function save() {
    const qty = Number(quantity);
    if (!vehicleId || !fuelId || !qty || qty <= 0) {
      Alert.alert('Missing fields', 'Vehicle, fuel type and a positive quantity are required.');
      return;
    }
    // 1. Queue locally first — works fully offline, survives app/device restart.
    await enqueue('fuel_request', {
      vehicle_id: vehicleId,
      fuel_type_id: fuelId,
      quantity: qty,
      destination: destination || null,
      created_at: new Date().toISOString(),
      created_by_role: user?.role,
    });
    // 2. Show it in the local list immediately, then best-effort sync.
    onClose();
    setQuantity(''); setDestination(''); setVehicleId(null); setFuelId(null);
    onSaved();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalWrap}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New fuel request</Text>
          <Text style={styles.label}>Vehicle</Text>
          <View style={styles.chipRow}>
            {vehicles.map((v) => (
              <TouchableOpacity key={v.id} style={[styles.chip, vehicleId === v.id && styles.chipOn]} onPress={() => setVehicleId(v.id)}>
                <Text style={{ color: C.text, fontSize: 12.5 }}>{v.plate}</Text>
              </TouchableOpacity>
            ))}
            {vehicles.length === 0 && <Text style={styles.muted}>No vehicles cached — sync first.</Text>}
          </View>
          <Text style={styles.label}>Fuel type</Text>
          <View style={styles.chipRow}>
            {fuels.map((f) => (
              <TouchableOpacity key={f.id} style={[styles.chip, fuelId === f.id && styles.chipOn]} onPress={() => setFuelId(f.id)}>
                <Text style={{ color: C.text, fontSize: 12.5 }}>{f.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>Quantity (litres)</Text>
          <TextInput style={styles.input} keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} placeholder="e.g. 40" placeholderTextColor={C.muted} />
          <Text style={styles.label}>Destination</Text>
          <TextInput style={styles.input} value={destination} onChangeText={setDestination} placeholder="optional" placeholderTextColor={C.muted} />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={save}>
              <Text style={styles.buttonText}>Save (works offline)</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.secondary, { flex: 1 }]} onPress={onClose}>
              <Text style={[styles.buttonText, { color: C.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 16 },
  card: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
  cardTitle: { color: C.muted, fontSize: 12, letterSpacing: 0.5 },
  cardMain: { color: C.text, fontSize: 16, fontWeight: '600', marginVertical: 4 },
  badge: { fontSize: 11, borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 1, textTransform: 'capitalize', overflow: 'hidden' },
  muted: { color: C.muted, fontSize: 12 },
  pendingNote: { color: C.amber, fontSize: 12, marginVertical: 8 },
  button: { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  secondary: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1 },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: C.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '90%' },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  label: { color: C.muted, fontSize: 12, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 8, color: C.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderColor: C.border, borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.bg },
  chipOn: { borderColor: C.accent, backgroundColor: '#1d3a6e' },
});
