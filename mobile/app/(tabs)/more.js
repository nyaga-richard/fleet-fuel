import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Screen, ScreenHeader, Icon, useNetState, useTabBarPad } from '../../src/components';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { localUnreadCount } from '../../src/db';
import { C, spacing as SP } from '../../theme';

// Consolidated navigation (§23/§24/§25): everything that isn't a daily
// primary action lives here, grouped by purpose and filtered by role.
// The badge on pending work is the ONLY badge — no noise.
export default function MoreScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const net = useNetState();
  const [unread, setUnread] = useState(0);
  const [pending, setPending] = useState(0);
  const bottomPad = useTabBarPad();

  const isMgr = user?.role === 'manager' || user?.role === 'admin';

  useFocusEffect(useCallback(() => {
    localUnreadCount().then(setUnread).catch(() => {});
    if (isMgr && net.isConnected) {
      Promise.all([api.requests('pending').catch(() => ({})), api.approvals('PENDING').catch(() => ({}))])
        .then(([rq, ap]) => setPending((rq.requests?.length || 0) + (ap.approvals?.length || 0)))
        .catch(() => {});
    }
  }, [isMgr, net.isConnected]));

  const sections = [
    ...(isMgr ? [{
      title: 'Control',
      items: [
        { icon: 'clipboard-check-outline', label: 'Approvals', sub: 'Requests, adjustments, excess', badge: pending, onPress: () => router.push('/approvals') },
        { icon: 'shield-check-outline', label: 'Push diagnostics', sub: 'Token, permission, test notification', onPress: () => router.push('/push-diagnostics') },
      ],
    }] : []),
    {
      title: 'Notifications',
      items: [
        { icon: 'bell-outline', label: 'Notifications', sub: 'Alerts, decisions and sync updates', badge: unread, onPress: () => router.push('/(tabs)/alerts') },
      ],
    },
    {
      title: 'System',
      items: [
        ...(!isMgr ? [{ icon: 'sync', label: 'Sync', sub: 'Queue, status and manual sync', onPress: () => router.push('/(tabs)/sync') }] : []),
        { icon: 'account-outline', label: 'Profile', sub: 'Your account and sign-out', onPress: () => router.push('/profile') },
      ],
    },
  ].filter((sec) => sec.items.length > 0);

  return (
    <Screen>
      <ScreenHeader title="More" subtitle={`${user?.name || ''} · ${user?.role || ''}`} />
      <FlatList
        data={sections}
        keyExtractor={(s) => s.title}
        renderItem={({ item: sec }) => (
          <View style={{ marginBottom: SP.lg }}>
            <Text style={{ color: C.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: SP.sm, marginTop: SP.xs }}>{sec.title}</Text>
            {sec.items.map((it) => (
              <TouchableOpacity
                key={it.label}
                onPress={it.onPress}
                accessibilityRole="button"
                accessibilityLabel={it.label}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: SP.md, minHeight: 56,
                  backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
                  borderRadius: 14, paddingHorizontal: 16, paddingVertical: 10, marginBottom: SP.sm,
                }}
              >
                <Icon name={it.icon} size={22} color={C.accent2} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: C.text, fontSize: 14, fontWeight: '700' }}>{it.label}</Text>
                  {!!it.sub && <Text style={{ color: C.muted, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>{it.sub}</Text>}
                </View>
                {!!it.badge && it.badge > 0 && (
                  <View style={{ backgroundColor: C.amber, borderRadius: 10, minWidth: 20, height: 20, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#1a1030', fontSize: 11, fontWeight: '800' }}>{it.badge > 99 ? '99+' : it.badge}</Text>
                  </View>
                )}
                <Text style={{ color: C.muted, fontSize: 18 }}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        contentContainerStyle={{ paddingBottom: bottomPad }}
      />
    </Screen>
  );
}
