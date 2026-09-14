import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Screen, ScreenHeader, Card, Btn, EmptyState, Icon, useNetState, useTabBarPad,
} from '../../src/components';
import { cachedNotifications, markLocalRead, markAllLocalRead } from '../../src/db';
import { fullSync } from '../../src/sync';
import { api } from '../../src/api';
import { C, spacing as SP, ICON } from '../../theme';
import { fmtDateTime } from '../../src/fmt';

const SEV_COLOR = { INFO: C.accent2, SUCCESS: C.green, WARNING: C.amber, ERROR: C.red, CRITICAL: C.red };

// Notification center (§32/§33/§36) — cached for offline (§39); server is
// authority on next sync. Tapping marks read and navigates to the entity.
export default function NotificationsScreen() {
  const router = useRouter();
  const net = useNetState();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const bottomPad = useTabBarPad();

  const load = useCallback(async () => {
    const rows = await cachedNotifications(100);
    setItems(rows);
    setUnread(rows.filter((r) => !r.is_read).length);
  }, []);

  useFocusEffect(useCallback(() => {
    load();
    fullSync().then(load).catch(() => {}); // online → pull fresh + mark states
  }, [load]));

  function open(n) {
    if (!n.is_read) markLocalRead(n.id).then(load);
    if (n.entity_type === 'fuel_request' && n.entity_id) router.push(`/request/${n.entity_id}`);
    else if (n.entity_type === 'fuel_transaction') router.push('/(tabs)/issue');
    else if (n.entity_type === 'approval') router.push('/approvals');
  }

  return (
    <Screen>
      <ScreenHeader
        title="Notifications"
        subtitle={unread > 0 ? `${unread} unread` : 'All caught up'}
        right={(
          <TouchableOpacity
            onPress={async () => { await markAllLocalRead(); if (net.isConnected) { try { await api.markAllNotificationsRead(); } catch { /* offline */ } } load(); }}
            accessibilityRole="button"
            accessibilityLabel="Mark all as read"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ color: C.accent2, fontSize: 12.5, fontWeight: '600' }}>Mark all read</Text>
          </TouchableOpacity>
        )}
      />

      {!net.isConnected && (
        <Card style={{ marginBottom: SP.md }}>
          <Text style={{ color: '#fcd34d', fontSize: 12 }}>
            Offline — showing cached notifications. Sync when online to refresh read states.
          </Text>
        </Card>
      )}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: SP.md }}>
            <TouchableOpacity onPress={() => open(item)} accessibilityRole="button" style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ width: 4, borderRadius: 2, backgroundColor: SEV_COLOR[item.severity] || C.muted }} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ color: C.text, fontSize: 13.5, fontWeight: item.is_read ? '600' : '800', flex: 1 }}>{item.title}</Text>
                  {!item.is_read && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent, marginTop: 5 }} />}
                </View>
                {!!item.message && <Text style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>{item.message}</Text>}
                <Text style={{ color: C.muted, fontSize: 11, marginTop: 5 }}>{fmtDateTime(item.created_at)}</Text>
              </View>
            </TouchableOpacity>
          </Card>
        )}
        ListEmptyComponent={(
          <EmptyState icon="bell-off-outline" title="No notifications" message="Approvals, requests and stock alerts will appear here. Pull down on Home to sync." />
        )}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={async () => { setBusy(true); await fullSync().catch(() => {}); await load(); setBusy(false); }} tintColor={C.muted} />}
        contentContainerStyle={{ paddingBottom: bottomPad }}
      />
    </Screen>
  );
}
