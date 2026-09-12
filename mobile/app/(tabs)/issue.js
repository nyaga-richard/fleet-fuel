import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TextInput, TouchableOpacity, Modal, Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  cachedRequests, cachedPumps, enqueue, outboxCount,
} from '../../src/db';
import { fullSync } from '../../src/sync';

const C = {
  bg: '#0b1220', panel: '#14203a', border: '#24344f', text: '#e6ecf5',
  muted: '#8fa0b8', accent: '#3b82f6', green: '#22c55e', amber: '#f59e0b', red: '#ef4444',
};

export default function IssueScreen() {
  const { user } = useAuth();
  const canIssue = ['attendant', 'manager', 'admin'].includes(user?.role);
  const [approved, setApproved] = useState([]);
  const [txns, setTxns] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    const rows = await cachedRequests(200);
    setApproved(rows.filter((r) => r.status === 'approved'));
    setTxns(rows); // reuse cache list for the "recent" section
    setPendingCount(await outboxCount());
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!canIssue) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.muted}>Your role does not issue fuel. Approvals happen on the web console.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.button} onPress={() => setModal(true)}>
        <Text style={styles.buttonText}>⛽ Issue fuel (works offline)</Text>
      </TouchableOpacity>
      {pendingCount > 0 && (
        <Text style={styles.pendingNote}>⏳ {pendingCount} queued change(s) will sync automatically</Text>
      )}
      <Text style={styles.section}>Recent requests & issues</Text>
      <FlatList
        data={txns.slice(0, 30)}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{item.txn_no || item.request_no}</Text>
              <Text style={[styles.badge, { color: C.muted, borderColor: C.border }]}>{item.status}</Text>
            </View>
            <Text style={styles.cardMain}>{item.plate || ''} — {Number(item.quantity).toLocaleString()} L</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.muted}>Nothing cached yet — sync first from the Home tab.</Text>}
      />

      <IssueModal
        visible={modal}
        approved={approved}
        onClose={() => setModal(false)}
        onSaved={() => { load(); fullSync(); }}
      />
    </View>
  );
}

function IssueModal({ visible, approved, onClose, onSaved }) {
  const [pumps, setPumps] = useState([]);
  const [requestId, setRequestId] = useState(null);
  const [pumpId, setPumpId] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [pumpReading, setPumpReading] = useState('');
  const [odometer, setOdometer] = useState('');

  useFocusEffect(useCallback(() => {
    (async () => setPumps(await cachedPumps()))();
  }, [visible]));

  function pickRequest(id) {
    setRequestId(id);
    const r = approved.find((x) => x.id === id);
    if (r) setQuantity(String(r.quantity));
  }

  async function save() {
    const req = approved.find((x) => x.id === requestId);
    const qty = Number(quantity);
    if (!req || !pumpId || !qty || qty <= 0) {
      Alert.alert('Missing fields', 'Request, pump and a positive quantity are required.');
      return;
    }
    await enqueue('fuel_transaction', {
      request_no: req.request_no, // resolved server-side; works across devices
      pump_id: pumpId,
      quantity: qty,
      pump_reading: pumpReading ? Number(pumpReading) : null,
      odometer: odometer ? Number(odometer) : null,
      created_at: new Date().toISOString(),
    });
    onClose();
    setQuantity(''); setPumpReading(''); setOdometer(''); setRequestId(null); setPumpId(null);
    onSaved();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalWrap}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Issue fuel</Text>
          <Text style={styles.label}>Approved request</Text>
          <View style={styles.chipRow}>
            {approved.slice(0, 12).map((r) => (
              <TouchableOpacity key={r.id} style={[styles.chip, requestId === r.id && styles.chipOn]} onPress={() => pickRequest(r.id)}>
                <Text style={{ color: C.text, fontSize: 12.5 }}>{r.request_no} · {r.plate}</Text>
              </TouchableOpacity>
            ))}
            {approved.length === 0 && <Text style={styles.muted}>No approved requests cached — connect once to sync approvals.</Text>}
          </View>
          <Text style={styles.label}>Pump</Text>
          <View style={styles.chipRow}>
            {pumps.map((p) => (
              <TouchableOpacity key={p.id} style={[styles.chip, pumpId === p.id && styles.chipOn]} onPress={() => setPumpId(p.id)}>
                <Text style={{ color: C.text, fontSize: 12.5 }}>{p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>Quantity (litres)</Text>
          <TextInput style={styles.input} keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} />
          <Text style={styles.label}>Pump meter reading</Text>
          <TextInput style={styles.input} keyboardType="decimal-pad" value={pumpReading} onChangeText={setPumpReading} placeholder="optional" placeholderTextColor={C.muted} />
          <Text style={styles.label}>Odometer (km)</Text>
          <TextInput style={styles.input} keyboardType="decimal-pad" value={odometer} onChangeText={setOdometer} placeholder="optional" placeholderTextColor={C.muted} />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={save}>
              <Text style={styles.buttonText}>Queue issue</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.secondary, { flex: 1 }]} onPress={onClose}>
              <Text style={[styles.buttonText, { color: C.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.muted, { marginTop: 10 }]}>
            The transaction is applied once (idempotent), even if sync retries.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 16 },
  section: { color: C.text, fontSize: 15, fontWeight: '600', marginVertical: 10 },
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
