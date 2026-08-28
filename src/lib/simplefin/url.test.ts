import { describe, expect, it } from 'vitest';
import { bridgeDashboardUrl, maskBaseUrl, splitAccessUrl } from './url';

describe('splitAccessUrl', () => {
  it('separates credentials from the base URL', () => {
    const { baseUrl, basicAuthSecret } = splitAccessUrl(
      'https://alice:s3cret@bridge.simplefin.org/simplefin',
    );
    expect(baseUrl).toBe('https://bridge.simplefin.org/simplefin');
    expect(basicAuthSecret).toBe(btoa('alice:s3cret'));
  });

  it('strips a trailing slash so path joining is unambiguous', () => {
    const { baseUrl } = splitAccessUrl('https://a:b@bridge.simplefin.org/simplefin/');
    expect(baseUrl).toBe('https://bridge.simplefin.org/simplefin');
  });

  it('preserves percent-encoded credentials', () => {
    const { basicAuthSecret } = splitAccessUrl(
      'https://user%40x.com:p%3Ass@bridge.simplefin.org/simplefin',
    );
    expect(basicAuthSecret).toBe(btoa('user@x.com:p:ss'));
  });

  it('rejects a URL with no credentials', () => {
    expect(() => splitAccessUrl('https://bridge.simplefin.org/simplefin')).toThrow(
      /credentials/i,
    );
  });

  it('rejects a non-https URL', () => {
    expect(() => splitAccessUrl('http://a:b@bridge.simplefin.org/simplefin')).toThrow(
      /https/i,
    );
  });
});

describe('bridgeDashboardUrl', () => {
  it('reduces to scheme and host', () => {
    expect(bridgeDashboardUrl('https://bridge.simplefin.org/simplefin')).toBe(
      'https://bridge.simplefin.org',
    );
  });
});

describe('maskBaseUrl', () => {
  it('keeps the origin but hides the path', () => {
    expect(maskBaseUrl('https://bridge.simplefin.org/simplefin')).toBe(
      'https://bridge.simplefin.org/••••••',
    );
  });
});
