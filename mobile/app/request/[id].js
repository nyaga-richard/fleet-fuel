import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { Screen, Card, StatusBadge, Btn, KV, EmptyState } from '../src/components';
import { cachedRequests, cachedVehicles, cachedFuelTypes } from '../src/db';
import { useAuth } from '../src/auth';
import { C } from '../src/theme';
import { fmtQty, fmtDateTime } from '../src/fmt';

// Request Details (spec §16) — the ONLY place from which fuel can be issued.
// Attendants additionally see pump guidance + authorization freshness.
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
        <EmptyState icon="🌫" title="Request not found on this device" message="It may not be synced yet — pull down on Home to refresh, then reopen." action={<Btn label="Sync & retry" variant="secondary" onPress={() => router.back()} />} />
      </Screen>
    );
  }
  if (!req) return <Screen><Card><Text style={{ color: C.muted }}>Loading…</Text></Card></Screen>;

  const canIssue = ['attendant', 'manager', 'admin'].includes(user?.role);
  const authorized = req.status === 'approved';

  return (
    <Screen>
      <BackHeader onPress={() => router.back()} title={req.request_no || 'Request (pending sync)'} />

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={{ color: C.text, fontSize: 18, fontWeight: '800' }}>{req.plate || vehicle?.plate || '—'}</Text>
            <StatusBadge status={req.status} />
          </View>
          <KV rows={[
            ['Request no.', req.request_no || 'pending sync'],
            ['Status', String(req.status || '—').replace(/_/g, ' ')],
            ['Fuel type', fuel?.name || req.fuel_type_id || '—'],
            ['Quantity requested', fmtQty(req.quantity)],
            ['Driver', req.driver_name || vehicle?.driver_name || '—'],
            ['Destination', req.destination || '—'],
            ['Created', fmtDateTime(req.created_at)],
            ['Updated', fmtDateTime(req.updated_at)],
          ]} />
        </Card>

        {authorized && canIssue && (
          <Card style={{ borderColor: C.green, borderWidth: 1 }}>
            <Text style={{ color: C.green, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 }}>Authorized fuel</Text>
            <Text style={{ color: C.text, fontSize: 30, fontWeight: '800', marginVertical: 4 }}>{fmtQty(req.quantity)}</Text>
            <Text style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>
              Pump is selected during fueling. Authorization stays valid until issued or cancelled.
            </Text>
            <Btn label="⛽ ISSUE FUEL" variant="success" onPress={() => router.push(`/issue/${req.id}`)} />
          </Card>
        )}

        {req.status === 'pending' && (
          <Card>
            <Text style={{ color: C.amber, fontSize: 13, fontWeight: '600' }}>
              ⏳ Waiting for manager authorization. You will be able to issue fuel once it is approved.
            </Text>
          </Card>
        )}
        {req.status === 'issued' && (
          <Card>
            <Text style={{ color: C.accent2, fontSize: 13, fontWeight: '600' }}>
              ✓ Fuel issued for this request — see the ledger entry on the web console or the Sync tab.
            </Text>
          </Card>
        )}
        {['rejected', 'cancelled'].includes(req.status) && (
          <Card>
            <Text style={{ color: C.muted, fontSize: 13 }}>This request was {req.status}. No fuel can be issued against it.</Text>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

function BackHeader({ onPress, title }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
      <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={{ color: C.accent2, fontSize: 22 }}>←</Text>
      </TouchableOpacity>
      {!!title && <Text style={{ color: C.text, fontSize: 17, fontWeight: '800', flexShrink: 1 }} numberOfLines={1}>{title}</Text>}
    </View>
  );
}
