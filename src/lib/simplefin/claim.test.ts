import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { claimSetupToken } from './claim';

const CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/DEMO';
const ACCESS_URL = 'https://alice:s3cret@bridge.simplefin.org/simplefin';

describe('claimSetupToken', () => {
  it('base64-decodes the token and POSTs to the claim URL', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { body: ACCESS_URL });

    const result = await claimSetupToken(host.api.network, btoa(CLAIM_URL));

    expect(host.requests[0].url).toBe(CLAIM_URL);
    expect(host.requests[0].method).toBe('POST');
    expect(result).toBe(ACCESS_URL);
  });

  it('tolerates surrounding whitespace in the pasted token', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { body: `  ${ACCESS_URL}\n` });

    const result = await claimSetupToken(host.api.network, `\n ${btoa(CLAIM_URL)} \n`);
    expect(result).toBe(ACCESS_URL);
  });

  it('rejects a token that is not valid base64', async () => {
    const host = createMockHost();
    await expect(claimSetupToken(host.api.network, '!!!not base64!!!')).rejects.toThrow(
      /setup token/i,
    );
  });

  it('reports that a token is single-use when the claim is refused', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { status: 403, body: 'Forbidden' });

    await expect(claimSetupToken(host.api.network, btoa(CLAIM_URL))).rejects.toThrow(
      /already been used|HTTP 403/i,
    );
  });
});
