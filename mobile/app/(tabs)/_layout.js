import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Keyboard, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../../src/theme';

// Bottom navigation that respects the device:
//   • height includes the SAFE-AREA BOTTOM INSET → never covered by the
//     Android gesture bar / 3-button nav / iPhone home indicator (spec §7–8)
//   • hides completely while the keyboard is open so forms own the screen
//     (spec §11), returns when it closes
// No absolute positioning, no fixed paddings.
function TabIcon({ glyph, label, focused }) {
  return (
    <Text style={{ fontSize: 17, color: focused ? C.accent2 : C.muted }}>
      {glyph}
    </Text>
  );
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
          height: 58 + insets.bottom,          // ← safe-area aware
          paddingBottom: 6 + insets.bottom,    // ← never under system nav
          paddingTop: 6,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: ({ focused }) => <TabIcon glyph="⛽" label="Home" focused={focused} /> }}
      />
      <Tabs.Screen
        name="requests"
        options={{ title: 'Requests', tabBarIcon: ({ focused }) => <TabIcon glyph="📝" label="Requests" focused={focused} /> }}
      />
      <Tabs.Screen
        name="issue"
        options={{ title: 'Fueling', tabBarIcon: ({ focused }) => <TabIcon glyph="🚚" label="Fueling" focused={focused} /> }}
      />
      <Tabs.Screen
        name="sync"
        options={{ title: 'Sync', tabBarIcon: ({ focused }) => <TabIcon glyph="🔄" label="Sync" focused={focused} /> }}
      />
    </Tabs>
  );
}
