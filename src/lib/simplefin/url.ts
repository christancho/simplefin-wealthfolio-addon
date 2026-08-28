/**
 * A SimpleFIN access URL embeds credentials: https://user:pass@host/path
 *
 * The brokered network API never accepts inline credentials — it resolves them
 * host-side from the secret store via `NetworkAuth.secretKey`. So we split the
 * URL once, at claim time: the credential-free base goes to `storage`, and the
 * base64 `user:pass` (the exact form `NetworkAuth` with type 'basic' expects)
 * goes to `secrets`.
 */
export interface SplitAccessUrl {
  baseUrl: string;
  basicAuthSecret: string;
}

export function splitAccessUrl(accessUrl: string): SplitAccessUrl {
  const url = new URL(accessUrl.trim());

  if (url.protocol !== 'https:') {
    throw new Error('SimpleFIN access URL must use https');
  }
  if (!url.username) {
    throw new Error('SimpleFIN access URL is missing credentials');
  }

  // URL getters keep credentials percent-encoded; the Bridge issues them
  // encoded, and basic auth is defined over the decoded bytes.
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);

  url.username = '';
  url.password = '';

  const baseUrl = url.toString().replace(/\/+$/, '');

  return { baseUrl, basicAuthSecret: btoa(`${user}:${pass}`) };
}

/**
 * The Bridge management dashboard. There is no documented per-connection deep
 * link, so the general dashboard is the honest target for a "fix this" link.
 */
export function bridgeDashboardUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}`;
}

/**
 * Shown in Settings instead of the full base URL — the path segment can still
 * act as a semi-identifying token even though it carries no credentials.
 */
export function maskBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/••••••`;
}
