import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Screen, ScreenHeader, Card, Btn, Field, EmptyState, Icon, KV } from '../src/components';
import { api } from '../src/api';
import { useAuth } from '../src/auth';
import { useNetState } from '../src/components';
import { C, spacing as SP, ICON } from '../theme';
import { fmtDateTime, fmtQty } from '../src/fmt';

const LABELS = {
  inventory_adjustment: 'Inventory Adjustment',
  fuel_excess: 'Excess Fuel',
  fuel_receipt: 'Bulk Receipt Exception',
  pump_variance: 'Pump Variance',
  tank_variance: 'Tank Variance',
};

// Approvals (§49) — manager/admin, ONLINE-only by design (decisions are
// legal records; queueing them offline would risk double decisions).
export default function ApprovalsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const net = useNetState();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const canApprove = user?.role === 'manager' || user?.role === 'admin';

  const load = useCallback(async () => {
    if (!canApprove) return;
    setError('');
    try { setRows((await api.approvals('PENDING')).approvals || []); }
    catch (e) { setError(e.message); setRows([]); }
  }, [canApprove]);

  useFocusEffect(useCallback(() => { if (net.isConnected) load(); }, [load, net.isConnected]));

  async function decide(id, decision) {
    setBusy(true); setError('');
    try {
      await api.decideApproval(id, decision, decision === 'REJECTED' ? reason : undefined);
      setRejecting(null); setReason('');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!canApprove) {
    return (
      <Screen>
        <ScreenHeader title="Approvals" subtitle="Manager or administrator required" />
        <EmptyState icon="lock-outline" title="Not available for your role" message="Approval decisions are made by managers and administrators." />
      </Screen>
    );
  }

  return (
    <Screen scroll keyboard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 }}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="arrow-left" size={ICON.xl} color={C.accent2} />
        </TouchableOpacity>
        <Text style={{ color: C.text, fontSize: 17, fontWeight: '800', flex: 1 }}>Approvals</Text>
      </View>

      {!net.isConnected && (
        <Card style={{ marginBottom: SP.md }}>
          <Text style={{ color: '#fcd34d', fontSize: 12.5 }}>
            You're offline — approval decisions need a live connection so the same decision can never be made twice.
          </Text>
        </Card>
      )}
      {!!error && (
        <Card style={{ borderColor: C.red, borderWidth: 1, marginBottom: SP.md }}>
          <Text style={{ color: C.red, fontSize: 12.5 }}>{error}</Text>
        </Card>
      )}

      {rows === null ? (
        <Card><Text style={{ color: C.muted }}>{net.isConnected ? 'Loading…' : 'Offline'}</Text></Card>
      ) : rows.length === 0 ? (
        <EmptyState icon="check-circle-outline" title="Nothing pending" message="No approvals are waiting for a decision." />
      ) : (
        rows.map((a) => (
          <Card key={a.id} style={{ marginBottom: SP.md }}>
            <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '800' }}>{LABELS[a.entity_type] || a.entity_type}</Text>
            <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
              {a.requested_by_name || '—'} · {fmtDateTime(a.created_at)}
            </Text>
            {a.quantity != null && (
              <View style={{ marginTop: 8 }}>
                <KV rows={[['Quantity', fmtQty(a.quantity)]]} />
              </View>
            )}
            {!!a.payload?.excess && (
              <View style={{ marginTop: 8 }}>
                <KV rows={[
                  ['Authorized', fmtQty(a.payload.authorized)],
                  ['Actual', fmtQty(a.payload.actual)],
                  ['Excess', fmtQty(a.payload.excess)],
                ]} />
              </View>
            )}
            {!!a.payload?.reason && (
              <Text style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>Reason: {a.payload.reason}</Text>
            )}
            <View style={{ flexDirection: 'row', gap: SP.md, marginTop: SP.md }}>
              <View style={{ flex: 1 }}>
                <Btn label={busy ? 'Working…' : 'Reject…'} variant="danger" disabled={busy} onPress={() => setRejecting(a)} />
              </View>
              <View style={{ flex: 1 }}>
                <Btn label={busy ? 'Working…' : 'Approve'} variant="success" disabled={busy} onPress={() => decide(a.id, 'APPROVED')} />
              </View>
            </View>
          </Card>
        ))
      )}

      {rejecting && (
        <Card style={{ borderColor: C.red, borderWidth: 1 }}>
          <Text style={{ color: C.text, fontSize: 14, fontWeight: '800' }}>Reject {LABELS[rejecting.entity_type] || rejecting.entity_type}</Text>
          <Field label="Reason (required)" hint="The requester will see this reason.">
            <TextInput
              value={reason} onChangeText={setReason} placeholder="Why is this being rejected?"
              multiline numberOfLines={2}
              style={{ color: C.text, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 10, minHeight: 60, textAlignVertical: 'top' }}
            />
          </Field>
          <View style={{ flexDirection: 'row', gap: SP.md }}>
            <View style={{ flex: 1 }}><Btn label="Cancel" variant="secondary" onPress={() => { setRejecting(null); setReason(''); }} /></View>
            <View style={{ flex: 1 }}><Btn label="Reject" variant="danger" busy={busy} disabled={!reason.trim()} onPress={() => decide(rejecting.id, 'REJECTED')} /></View>
          </View>
        </Card>
      )}
    </Screen>
  );
}
