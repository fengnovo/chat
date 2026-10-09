export function resolveLink(
  url: string,
  baseUrl: string,
  sessionId: string,
): string | null {
  if (url === 'preview://open')
    return `${baseUrl.replace(/\/+$/, '')}/api/agent/sessions/${encodeURIComponent(sessionId)}/preview/`;
  try {
    const resolved = new URL(url, `${baseUrl}/`);
    return ['http:', 'https:'].includes(resolved.protocol)
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

/** 凭据只会发送给我们的 API，绝不会发送给文章或图片所在的主机。 */
export function imageSource(
  url: string,
  baseUrl: string,
  token: string | null,
) {
  const uri = url.startsWith('data:image/')
    ? url
    : new URL(url, `${baseUrl}/`).href;
  const privateApi =
    !uri.startsWith('data:') &&
    new URL(uri).origin === new URL(baseUrl).origin &&
    new URL(uri).pathname.startsWith('/api/');
  return {
    uri,
    ...(privateApi && token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : {}),
  };
}
