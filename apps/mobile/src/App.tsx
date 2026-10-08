import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MediaProvider } from './media/MediaProvider';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { colors } from './theme';
import ChatScreen from './screens/ChatScreen';
import LoginScreen from './screens/LoginScreen';
import SessionsScreen from './screens/SessionsScreen';
import { AuthProvider, useAuth } from './store/auth';

export type RootStackParamList = {
  Login: undefined;
  Sessions: undefined;
  Chat: { sessionId: string; title: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.surface,
    border: colors.border,
    text: colors.textPrimary,
    primary: colors.accent,
  },
};

function RootNavigator() {
  const { restoring, restoreError, retryRestore, user, lastChat } = useAuth();
  if (restoring) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }
  if (restoreError)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          padding: 24,
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <Text style={{ color: colors.textPrimary }}>{restoreError}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={retryRestore}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.accent }}>重新连接</Text>
        </Pressable>
      </View>
    );
  return (
    <NavigationContainer
      theme={navigationTheme}
      initialState={
        user && lastChat
          ? {
              index: 1,
              routes: [
                { name: 'Sessions' },
                { name: 'Chat', params: lastChat },
              ],
            }
          : undefined
      }
    >
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.textPrimary,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {user ? (
          <>
            <Stack.Screen
              name="Sessions"
              component={SessionsScreen}
              options={{ title: 'Keen AI' }}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={({ route }) => ({ title: route.params.title })}
            />
          </>
        ) : (
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <MediaProvider>
          <StatusBar style="light" />
          <RootNavigator />
        </MediaProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
