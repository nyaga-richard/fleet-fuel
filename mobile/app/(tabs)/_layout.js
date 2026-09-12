import { Tabs } from 'expo-router';
import { Text } from 'react-native';

const C = {
  bg: '#0b1220', panel: '#14203a', border: '#24344f', text: '#e6ecf5',
  muted: '#8fa0b8', accent: '#3b82f6',
};

function TabIcon({ glyph, label }) {
  return <Text style={{ fontSize: 16 }}>{`${glyph} ${label}`}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: C.panel },
        headerTintColor: C.text,
        tabBarStyle: { backgroundColor: C.panel, borderColor: C.border, height: 58, paddingBottom: 6 },
        tabBarActiveTintColor: C.accent,
        tabBarInactiveTintColor: C.muted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <Text style={{ fontSize: 18 }}>{focused ? '⛽' : '⛽'}</Text>,
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: 'Requests',
          tabBarIcon: () => <Text style={{ fontSize: 18 }}>📝</Text>,
        }}
      />
      <Tabs.Screen
        name="issue"
        options={{
          title: 'Issue',
          tabBarIcon: () => <Text style={{ fontSize: 18 }}>🚚</Text>,
        }}
      />
      <Tabs.Screen
        name="sync"
        options={{
          title: 'Sync',
          tabBarIcon: () => <Text style={{ fontSize: 18 }}>🔄</Text>,
        }}
      />
    </Tabs>
  );
}
