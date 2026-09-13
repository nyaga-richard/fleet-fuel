import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Keyboard, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, TABBAR_CONTENT_H } from '../../theme';

// Bottom navigation (spec §9): compact, content-height 56 + the REAL
// safe-area inset — never covered by gesture bar / 3-button nav / home
// indicator. Hides while the keyboard is open (spec §11).
function TabIcon({ glyph, focused }) {
  return <Text style={{ fontSize: 17, color: focused ? C.accent2 : C.muted }}>{glyph}</Text>;
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEv, () => setKbOpen(true));
    const hide = Keyboard.addListener(hideEv, () => setKbOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false, // screens render their own ScreenHeader
        tabBarActiveTintColor: C.accent2,
        tabBarInactiveTintColor: C.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarStyle: {
          display: kbOpen ? 'none' : 'flex',
          backgroundColor: C.panel,
          borderTopColor: C.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: TABBAR_CONTENT_H + insets.bottom, // content + inset, nothing arbitrary
          paddingTop: 6,
          paddingBottom: insets.bottom + 4,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ focused }) => <TabIcon glyph="⛽" focused={focused} /> }} />
      <Tabs.Screen name="requests" options={{ title: 'Requests', tabBarIcon: ({ focused }) => <TabIcon glyph="📝" focused={focused} /> }} />
      <Tabs.Screen name="issue" options={{ title: 'Fueling', tabBarIcon: ({ focused }) => <TabIcon glyph="🚚" focused={focused} /> }} />
      <Tabs.Screen name="sync" options={{ title: 'Sync', tabBarIcon: ({ focused }) => <TabIcon glyph="🔄" focused={focused} /> }} />
    </Tabs>
  );
}
