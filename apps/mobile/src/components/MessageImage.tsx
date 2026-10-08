import React, { useMemo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { api } from '../api/client';
import { useMedia } from '../media/MediaProvider';
import { imageSource } from '../media/urls';
import { colors } from '../theme';

export default function MessageImage({
  url,
  label = '查看大图',
}: {
  url: string;
  label?: string;
}) {
  const { openImage } = useMedia();
  const [ratio, setRatio] = useState(16 / 9);
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => imageSource(url, api.baseUrl, api.bearerToken),
    [url],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}，点击放大`}
      onPress={() => openImage(url)}
      style={{ width: '100%', marginVertical: 8 }}
    >
      <Image
        source={source}
        style={{ width: '100%', aspectRatio: ratio, borderRadius: 8 }}
        resizeMode="contain"
        onLoad={(event) => {
          const { width, height } = event.nativeEvent.source;
          if (width && height) setRatio(width / height);
        }}
        onError={() => setFailed(true)}
      />
      {failed ? (
        <Text style={{ color: colors.textMuted }}>
          图片加载失败，点击重试查看大图
        </Text>
      ) : null}
    </Pressable>
  );
}
