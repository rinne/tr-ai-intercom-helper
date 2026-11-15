/**
 * The URL a request is forwarded to: the intercom's root URL with the
 * request's path and query appended. The root may end in a slash or not, and
 * may carry a path of its own; the result always has exactly one slash where
 * the two meet.
 */
export function upstreamUrl(root: string, requestPath: string): URL {
  const base = new URL(root);
  const prefix = base.pathname.replace(/\/+$/, '');
  const path = `/${requestPath.replace(/^\/+/, '')}`;
  return new URL(`${base.protocol}//${base.host}${prefix}${path}`);
}

/**
 * The wake-up socket's URL from the value of the response header. A full URL
 * is used as it is; a relative one is resolved against the URL of the request
 * the response answered. http becomes ws and https becomes wss. Returns
 * undefined for a value that gives no usable URL.
 */
export function socketUrl(headerValue: string, requestUrl: URL): string | undefined {
  let url: URL;
  try {
    url = new URL(headerValue.trim(), requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
  url.hash = '';
  return url.toString();
}
