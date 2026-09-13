import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import {
  Screen, Card, SectionHeader, StatusBadge, Btn, KV, EmptyState,
} from '../../src/components';
import { cachedRequests, cachedVehicles, cachedFuelTypes } from '../../src/db';
import { useAuth } from '../../src/auth';
import { C, spacing as SP } from '../../theme';
import { fmtQty, fmtDateTime } from '../../src/fmt';

// Request Details (spec §15/§16) — grouped sections, the ONLY place from
// which fuel can be issued. Shows exactly what the device has cached; the
// full mileage/calculation trail lives on the web console.
export default function RequestDetails() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const [req, setReq] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [fuel, setFuel] = useState(null);
  const [missing, setMissing] = useState(false);

  useFocusEffect(useCallback(() => {
    (async () => {
      const r = (await cachedRequests(500)).find((x) => x.id === id);
      if (!r) { setMissing(true); return; }
      setReq(r);
      setVehicle((await cachedVehicles()).find((v) => v.id === r.vehicle_id) || null);
      setFuel((await cachedFuelTypes()).find((f) => f.id === r.fuel_type_id) || null);
    })();
  }, [id]));

  if (missing) {
    return (
      <Screen>
        <BackHeader onPress={() => router.back()} />
        <EmptyState
          icon="🌫"
          title="Request not found on this device"
          message="It may not be synced yet — pull down on Home to refresh, then reopen."
          action={<Btn label="Back" variant="secondary" onPress={() => router.back()} />}
        />
      </Screen>
    );
  }
  if (!req) return <Screen><Card><Text style={{ color: C.muted }}>Loading…</Text></Card></Screen>;

  const canIssue = ['attendant', 'manager', 'admin'].includes(user?.role);
  const authorized = req.status === 'approved';

  return (
    <Screen scroll>
      <BackHeader onPress={() => router.back()} title={req.request_no || 'Request (pending sync)'} />

      {/* Overview */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>{req.plate || vehicle?.plate || '—'}</Text>
          <StatusBadge status={req.status} />
        </View>
        <Text style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
          {fuel?.name || 'Fuel'} · <Text style={{ fontWeight: '700', color: C.text }}>{fmtQty(req.quantity)}</Text>
        </Text>
      </Card>

      {authorized && canIssue && (
        <Card style={{ borderColor: C.green, borderWidth: 1 }}>
          <Text style={{ color: C.green, fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' }}>Authorized fuel</Text>
          <Text style={{ color: C.text, fontSize: 30, fontWeight: '800', marginVertical: 2, fontVariant: ['tabular-nums'] }}>{fmtQty(req.quantity)}</Text>
          <Text style={{ color: C.muted, fontSize: 12, marginBottom: SP.md }}>
            Pump is selected during fueling. Authorization stays valid until issued or cancelled.
          </Text>
          <Btn label="ISSUE FUEL" variant="success" large onPress={() => router.push(`/issue/${req.id}`)} />
        </Card>
      )}

      <SectionHeader>Request</SectionHeader>
      <Card>
        <KV rows={[
          ['Request no.', req.request_no || 'pending sync'],
          ['Status', String(req.status || '—').replace(/_/g, ' ')],
          ['Created', fmtDateTime(req.created_at)],
          ['Updated', fmtDateTime(req.updated_at)],
        ]} />
      </Card>

      <SectionHeader>Vehicle</SectionHeader>
      <Card>
        <KV rows={[
          ['Registration', req.plate || vehicle?.plate || '—'],
          ['Make / model', vehicle ? [vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—' : '—'],
          ['Type', vehicle?.vehicle_type || '—'],
          ['Driver', req.driver_name || vehicle?.driver_name || '—'],
        ]} />
      </Card>

      <SectionHeader>Fuel</SectionHeader>
      <Card>
        <KV rows={[
          ['Fuel type', fuel?.name || '—'],
          ['Quantity requested', fmtQty(req.quantity)],
          ['Quantity authorized', authorized ? fmtQty(req.quantity) : '—'],
        ]} />
      </Card>

      {req.status === 'pending' && (
        <Card>
          <Text style={{ color: C.amber, fontSize: 13, fontWeight: '600' }}>
            ⏳ Waiting for manager authorization. Fuel can be issued once it is approved.
          </Text>
        </Card>
      )}
      {req.status === 'issued' && (
        <Card>
          <Text style={{ color: C.accent2, fontSize: 13, fontWeight: '600' }}>
            ✓ Fuel issued for this request — see the ledger on the web console or the Sync tab.
          </Text>
        </Card>
      )}
      {['rejected', 'cancelled'].includes(req.status) && (
        <Card>
          <Text style={{ color: C.muted, fontSize: 13 }}>This request was {req.status}. No fuel can be issued against it.</Text>
        </Card>
      )}
    </Screen>
  );
}

function BackHeader({ onPress, title }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 }}>
      <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={{ color: C.accent2, fontSize: 22 }}>←</Text>
      </TouchableOpacity>
      {!!title && <Text style={{ color: C.text, fontSize: 17, fontWeight: '800', flexShrink: 1 }} numberOfLines={1}>{title}</Text>}
    </View>
  );
}
