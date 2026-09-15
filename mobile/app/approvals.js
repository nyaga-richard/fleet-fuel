import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Screen, ScreenHeader, Card, Btn, Field, EmptyState, Icon, KV, Sheet,
  useNetState, useTabBarPad,
} from '../src/components';
import { api } from '../src/api';
import { useAuth } from '../src/auth';
import { C, spacing as SP } from '../theme';
import { fmtDateTime, fmtQty } from '../src/fmt';

const LABELS = {
  inventory_adjustment: 'Inventory Adjustment',
  fuel_excess: 'Excess Fuel',
  fuel_receipt: 'Bulk Receipt Exception',
  pump_variance: 'Pump Variance',
  tank_variance: 'Tank Variance',
};

// Approvals hub (§17–§21) — managers/admins decide EVERYTHING from here:
// pending fuel requests (authorization) AND engine approvals (adjustments,
// excess). Decisions are permission-gated server-side (§20); rejection
// requires a reason (§19, enforced by the API too); online-only by design —
// decisions are legal records and queueing them offline would risk doubles.
export default function ApprovalsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const net = useNetState();
  const [tab, setTab] = useState('requests');
  const [requests, setRequests] = useState(null);
  const [engine, setEngine] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(null); // { kind, id, title }
  const [reason, setReason] = useState('');
  const [review, setReview] = useState(null);       // request under review
  const bottomPad = useTabBarPad();

  const canDecide = user?.role === 'manager' || user?.role === 'admin';

  const load = useCallback(async () => {
    if (!canDecide) return;
    setError('');
    try {
      const [rq, ap] = await Promise.all([api.requests('pending'), api.approvals('PENDING')]);
      setRequests(rq.requests || []);
      setEngine(ap.approvals || []);
    } catch (e) { setError(e.message); setRequests([]); setEngine([]); }
  }, [canDecide]);

  useFocusEffect(useCallback(() => { if (net.isConnected) load(); }, [load, net.isConnected]));

  if (!canDecide) {
    return (
      <Screen>
        <ScreenHeader title="Approvals" subtitle="Manager or administrator required" />
        <EmptyState icon="lock-outline" title="Not available for your role" message="Approval decisions are made by managers and administrators." />
      </Screen>
    );
  }

  async function decide(kind, id, decision, why) {
    setBusy(true); setError('');
    try {
      if (kind === 'request') await api.decideRequest(id, decision, why || undefined);
      else await api.decideApproval(id, decision, decision === 'REJECTED' ? why : undefined);
      setRejecting(null); setReason(''); setReview(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const rows = tab === 'requests' ? requests : engine;
  const pendingCount = (requests?.length || 0) + (engine?.length || 0);

  return (
    <Screen>
      <ScreenHeader
        title="Approvals"
        subtitle={net.isConnected ? `${pendingCount} pending decision${pendingCount === 1 ? '' : 's'}` : 'Offline'}
        right={(
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Close approvals" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="close" size={22} color={C.muted} />
          </TouchableOpacity>
        )}
      />

      {!net.isConnected && (
        <Card style={{ marginBottom: SP.md }}>
          <Text style={{ color: '#fcd34d', fontSize: 12.5 }}>
            You're offline — decisions need a live connection so the same decision can never be made twice.
          </Text>
        </Card>
      )}
      {!!error && (
        <Card style={{ borderColor: C.red, borderWidth: 1, marginBottom: SP.md }}>
          <Text style={{ color: C.red, fontSize: 12.5 }}>{error}</Text>
        </Card>
      )}

      <View style={{ flexDirection: 'row', gap: SP.sm, marginBottom: SP.sm }}>
        <Segment active={tab === 'requests'} onPress={() => setTab('requests')} label={`Requests${requests?.length ? ` (${requests.length})` : ''}`} />
        <Segment active={tab === 'engine'} onPress={() => setTab('engine')} label={`Inventory & excess${engine?.length ? ` (${engine.length})` : ''}`} />
      </View>

      <FlatList
        data={rows || []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (tab === 'requests'
          ? (
            <RequestApprovalCard
              r={item} busy={busy}
              onReview={() => setReview(item)}
              onReject={() => setRejecting({ kind: 'request', id: item.id, title: item.request_no || 'request' })}
              onApprove={() => decide('request', item.id, 'approve')}
            />
          )
          : (
            <EngineApprovalCard
              a={item} busy={busy}
              onReject={() => setRejecting({ kind: 'engine', id: item.id, title: LABELS[item.entity_type] || item.entity_type })}
              onApprove={() => decide('engine', item.id, 'APPROVED')}
            />
          ))}
        ListEmptyComponent={!rows ? (
          <Card><Text style={{ color: C.muted }}>{net.isConnected ? 'Loading…' : 'Offline'}</Text></Card>
        ) : (
          <EmptyState
            icon="check-circle-outline"
            title={tab === 'requests' ? 'No pending requests' : 'Nothing pending'}
            message={tab === 'requests' ? 'Every fuel request has been decided.' : 'No inventory or excess approvals are waiting.'}
          />
        )}
        contentContainerStyle={{ paddingBottom: bottomPad }}
      />

      {review && (
        <Sheet visible onClose={() => setReview(null)} title={review.request_no || 'Request'} subtitle={`${review.plate || ''} · ${fmtQty(review.quantity)}`}>
          <KV rows={[
            ['Vehicle', review.plate || '—'],
            ['Fuel', review.fuel_type_name || '—'],
            ['Calculated qty', fmtQty(review.quantity)],
            ['Odometer', review.odometer != null ? `${fmtQty(review.odometer, 'km')}` : '—'],
            ['Destination', review.destination || '—'],
            ['Driver', review.driver_name || '—'],
            ['Requested by', review.requested_by_name || '—'],
            ['Created', fmtDateTime(review.created_at)],
          ]} />
          {!!review.reason && <Text style={{ color: C.muted, fontSize: 12.5, marginTop: SP.md }}>Reason: {review.reason}</Text>}
          <View style={{ flexDirection: 'row', gap: SP.md, marginTop: SP.lg }}>
            <View style={{ flex: 1 }}><Btn label="Reject…" variant="danger" onPress={() => setRejecting({ kind: 'request', id: review.id, title: review.request_no || 'request' })} /></View>
            <View style={{ flex: 1 }}><Btn label="Approve" variant="success" busy={busy} onPress={() => decide('request', review.id, 'approve')} /></View>
          </View>
        </Sheet>
      )}

      {rejecting && (
        <Sheet visible onClose={() => { setRejecting(null); setReason(''); }} title={`Reject ${rejecting.title}`} subtitle="The requester will see this reason">
          <Field label="Reason (required)">
            <TextInput
              value={reason} onChangeText={setReason} placeholder="Why is this being rejected?"
              multiline numberOfLines={3}
              style={{ color: C.text, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 80, textAlignVertical: 'top', fontSize: 14 }}
            />
          </Field>
          <View style={{ flexDirection: 'row', gap: SP.md, marginTop: SP.md }}>
            <View style={{ flex: 1 }}><Btn label="Cancel" variant="secondary" onPress={() => { setRejecting(null); setReason(''); }} /></View>
            <View style={{ flex: 1 }}><Btn label="Reject" variant="danger" busy={busy} disabled={!reason.trim()} onPress={() => decide(rejecting.kind, rejecting.id, rejecting.kind === 'request' ? 'reject' : 'REJECTED', reason.trim())} /></View>
          </View>
        </Sheet>
      )}
    </Screen>
  );
}

function Segment({ active, onPress, label }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={{
        flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8,
        backgroundColor: active ? C.accent : C.panel, borderWidth: 1, borderColor: active ? C.accent : C.border,
      }}
    >
      <Text style={{ color: active ? '#fff' : C.muted, fontSize: 12, fontWeight: active ? '800' : '600' }} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function RequestApprovalCard({ r, busy, onReview, onApprove, onReject }) {
  return (
    <Card style={{ marginBottom: SP.md }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SP.sm }}>
        <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '800' }}>{r.request_no || 'Request'}</Text>
        <Text style={{ color: C.amber, fontSize: 12, fontWeight: '700' }}>PENDING</Text>
      </View>
      <View style={{ marginTop: SP.sm }}>
        <KV rows={[
          ['Vehicle', r.plate || '—'],
          ['Fuel', r.fuel_type_name || '—'],
          ['Calculated qty', fmtQty(r.quantity)],
          ['Odometer', r.odometer != null ? `${fmtQty(r.odometer, 'km')}` : '—'],
        ]} />
      </View>
      <View style={{ flexDirection: 'row', gap: SP.sm, marginTop: SP.md }}>
        <View style={{ flex: 1 }}><Btn label="Review" variant="secondary" small onPress={onReview} /></View>
        <View style={{ flex: 1 }}><Btn label="Reject…" variant="danger" small disabled={busy} onPress={onReject} /></View>
        <View style={{ flex: 1 }}><Btn label="Approve" variant="success" small disabled={busy} onPress={onApprove} /></View>
      </View>
    </Card>
  );
}

function EngineApprovalCard({ a, busy, onApprove, onReject }) {
  return (
    <Card style={{ marginBottom: SP.md }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SP.sm }}>
        <Text style={{ color: C.text, fontSize: 14.5, fontWeight: '800' }}>{LABELS[a.entity_type] || a.entity_type}</Text>
        <Text style={{ color: C.amber, fontSize: 12, fontWeight: '700' }}>PENDING</Text>
      </View>
      <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{a.requested_by_name || '—'} · {fmtDateTime(a.created_at)}</Text>
      {a.quantity != null && (
        <View style={{ marginTop: SP.sm }}>
          <KV rows={[['Quantity', fmtQty(a.quantity)]]} />
        </View>
      )}
      {!!a.payload?.excess && (
        <View style={{ marginTop: SP.sm }}>
          <KV rows={[
            ['Authorized', fmtQty(a.payload.authorized)],
            ['Actual', fmtQty(a.payload.actual)],
            ['Excess', fmtQty(a.payload.excess)],
          ]} />
        </View>
      )}
      {!!a.payload?.reason && <Text style={{ color: C.muted, fontSize: 12, marginTop: SP.sm }}>Reason: {a.payload.reason}</Text>}
      <View style={{ flexDirection: 'row', gap: SP.sm, marginTop: SP.md }}>
        <View style={{ flex: 1 }}><Btn label="Reject…" variant="danger" small disabled={busy} onPress={onReject} /></View>
        <View style={{ flex: 1 }}><Btn label="Approve" variant="success" small disabled={busy} onPress={onApprove} /></View>
      </View>
    </Card>
  );
}
