import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Image,
  Modal,
  PanResponder,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { colors, spacing } from '../theme';
import { imageSource, resolveLink } from './urls';

type MediaActions = {
  openLink: (url: string, sessionId: string) => void;
  openImage: (url: string) => void;
};
const Context = createContext<MediaActions | null>(null);
export function useMedia() {
  const value = useContext(Context);
  if (!value) throw new Error('MediaProvider missing');
  return value;
}
const button = {
  minHeight: 44,
  paddingHorizontal: spacing.md,
  justifyContent: 'center' as const,
};

function ImageViewer({ url, onClose }: { url: string; onClose: () => void }) {
  const size = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const zoom = useRef(1);
  const translation = useRef({ x: 0, y: 0 });
  const scale = useRef(new Animated.Value(1)).current;
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const [percentage, setPercentage] = useState(100);
  const source = useMemo(
    () => imageSource(url, api.baseUrl, api.bearerToken),
    [url],
  );
  const setZoom = useCallback(
    (value: number) => {
      zoom.current = Math.max(1, Math.min(5, value));
      scale.setValue(zoom.current);
      setPercentage(Math.round(zoom.current * 100));
      if (zoom.current === 1) {
        translation.current = { x: 0, y: 0 };
        x.setValue(0);
        y.setValue(0);
      }
    },
    [scale, x, y],
  );
  const gesture = useRef({ distance: 0, zoom: 1, x: 0, y: 0, lastTap: 0 });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          gesture.current = {
            ...gesture.current,
            distance:
              touches.length > 1
                ? Math.hypot(
                    touches[0].pageX - touches[1].pageX,
                    touches[0].pageY - touches[1].pageY,
                  )
                : 0,
            zoom: zoom.current,
            x: translation.current.x,
            y: translation.current.y,
          };
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          if (touches.length > 1) {
            const distance = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY,
            );
            if (!gesture.current.distance) {
              gesture.current.distance = distance;
              gesture.current.zoom = zoom.current;
            }
            if (gesture.current.distance)
              setZoom(
                (gesture.current.zoom * distance) / gesture.current.distance,
              );
          } else if (zoom.current > 1) {
            translation.current = {
              x: gesture.current.x + state.dx,
              y: gesture.current.y + state.dy,
            };
            x.setValue(translation.current.x);
            y.setValue(translation.current.y);
          }
        },
        onPanResponderRelease: (_, state) => {
          if (
            Math.abs(state.dx) + Math.abs(state.dy) < 10 &&
            !gesture.current.distance
          ) {
            const now = Date.now();
            if (now - gesture.current.lastTap < 300) {
              setZoom(zoom.current > 1 ? 1 : 2.5);
              gesture.current.lastTap = 0;
            } else gesture.current.lastTap = now;
          }
        },
      }),
    [setZoom, x, y],
  );
  return (
    <Modal visible onRequestClose={onClose} animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ color: colors.textPrimary, padding: spacing.md }}>
            图片预览 · {percentage}%
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭图片"
            onPress={onClose}
            style={button}
          >
            <Text style={{ color: colors.accent }}>关闭</Text>
          </Pressable>
        </View>
        <View
          style={{ flex: 1, overflow: 'hidden' }}
          {...responder.panHandlers}
        >
          <Animated.View
            style={{
              flex: 1,
              transform: [{ translateX: x }, { translateY: y }, { scale }],
            }}
          >
            <Image
              source={source}
              resizeMode="contain"
              style={{
                width: size.width,
                height: size.height - insets.top - insets.bottom - 130,
              }}
            />
          </Animated.View>
        </View>
        <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
          双指缩放 · 双击放大 · 拖动查看
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
          {[
            { label: '缩小', value: zoom.current / 1.5 },
            { label: '还原', value: 1 },
            { label: '放大', value: zoom.current * 1.5 },
          ].map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              onPress={() => setZoom(item.value)}
              style={button}
            >
              <Text style={{ color: colors.accent }}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

/** A single mounted WebView survives closing and reopening its overlay. */
// Visibility changes must not update the native WebView's source/props.
const RetainedWebView = React.memo(function RetainedWebView({
  source,
  web,
  setLoading,
  setError,
}: {
  source: { uri: string; headers: { Referer: string } };
  web: React.RefObject<WebView | null>;
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
}) {
  return (
    <WebView
      ref={web}
      source={source}
      style={{ flex: 1 }}
      onLoadStart={() => {
        setLoading(true);
        setError(null);
      }}
      onLoadEnd={() => setLoading(false)}
      onError={(event) => setError(event.nativeEvent.description)}
      onHttpError={(event) =>
        setError(`页面加载失败（${event.nativeEvent.statusCode}）`)
      }
      originWhitelist={['http://*', 'https://*']}
      onShouldStartLoadWithRequest={(request) =>
        request.url === 'about:blank' || /^https?:\/\//i.test(request.url)
      }
      onContentProcessDidTerminate={() => web.current?.reload()}
    />
  );
});

export function MediaProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [browser, setBrowser] = useState<{
    url: string;
    visible: boolean;
  } | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const web = useRef<WebView>(null);
  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setBrowser(null);
    setImage(null);
    return () => { requestGeneration.current += 1; };
  }, [user?.id]);
  const openLink = useCallback((url: string, sessionId: string) => {
    const resolved = resolveLink(url, api.baseUrl, sessionId);
    if (!resolved) return;
    const target = new URL(resolved);
    const isPreview = target.origin === new URL(api.baseUrl).origin && /^\/api\/agent\/sessions\/[^/]+\/preview\/?$/.test(target.pathname);
    const generation = ++requestGeneration.current;
    if (isPreview) {
      void api.previewUrl(sessionId).then((previewUrl) => {
        if (generation !== requestGeneration.current) return;
        setBrowser({url: previewUrl, visible: true});
        setError(null);
      }).catch(() => {
        if (generation === requestGeneration.current) Alert.alert('页面预览', '无法打开预览，请确认会话仍可访问。');
      });
    } else {
      setBrowser({ url: resolved, visible: true });
      setError(null);
    }
  }, []);
  const actions = useMemo(
    () => ({ openLink, openImage: setImage }),
    [openLink],
  );
  const source = useMemo(
    () =>
      browser
        ? { uri: browser.url, headers: { Referer: `${api.baseUrl}/` } }
        : undefined,
    [browser?.url],
  );
  useEffect(() => {
    if (!browser?.visible) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        setBrowser((current) =>
          current ? { ...current, visible: false } : null,
        );
        return true;
      },
    );
    return () => subscription.remove();
  }, [browser?.visible]);
  return (
    <Context.Provider value={actions}>
      <View style={{ flex: 1 }}>
        {children}
        {browser && source ? (
          <View
            collapsable={false}
            pointerEvents={browser.visible ? 'auto' : 'none'}
            accessibilityElementsHidden={!browser.visible}
            importantForAccessibility={
              browser.visible ? 'auto' : 'no-hide-descendants'
            }
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              backgroundColor: colors.background,
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              // Keep WKWebView attached and laid out: display:none reloads it on iOS.
              opacity: browser.visible ? 1 : 0,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭页面预览"
                onPress={() =>
                  setBrowser((current) =>
                    current ? { ...current, visible: false } : null,
                  )
                }
                style={button}
              >
                <Text style={{ color: colors.accent }}>关闭</Text>
              </Pressable>
              <Text style={{ color: colors.textPrimary }}>页面预览</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => web.current?.reload()}
                style={button}
              >
                <Text style={{ color: colors.accent }}>刷新</Text>
              </Pressable>
            </View>
            {loading ? <ActivityIndicator color={colors.accent} /> : null}
            {error ? (
              <Text style={{ color: colors.danger, padding: spacing.md }}>
                {error}
              </Text>
            ) : null}
            <RetainedWebView
              source={source}
              web={web}
              setLoading={setLoading}
              setError={setError}
            />
          </View>
        ) : null}
        {image ? (
          <ImageViewer key={image} url={image} onClose={() => setImage(null)} />
        ) : null}
      </View>
    </Context.Provider>
  );
}
