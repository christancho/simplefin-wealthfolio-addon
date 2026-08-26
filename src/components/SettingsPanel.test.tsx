import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { AUTH_SECRET_KEY } from '../lib/simplefin/client';
import { DEFAULT_LOOKBACK_DAYS, DEFAULT_PAYMENT_KEYWORDS, DEFAULT_TRANSFER_KEYWORDS } from '../lib/storage/config';
import { SettingsPanel } from './SettingsPanel';

const BASE_URL = 'https://bridge.simplefin.org/simplefin';

function renderPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const host = createMockHost();
  const onDisconnected = vi.fn();
  const onLookbackDaysChange = vi.fn();
  const onPaymentKeywordsChange = vi.fn();
  const onTransferKeywordsChange = vi.fn();
  render(
    <SettingsPanel
      api={host.api}
      baseUrl={BASE_URL}
      lookbackDays={DEFAULT_LOOKBACK_DAYS}
      onLookbackDaysChange={onLookbackDaysChange}
      paymentKeywords={DEFAULT_PAYMENT_KEYWORDS}
      onPaymentKeywordsChange={onPaymentKeywordsChange}
      transferKeywords={DEFAULT_TRANSFER_KEYWORDS}
      onTransferKeywordsChange={onTransferKeywordsChange}
      onDisconnected={onDisconnected}
      {...overrides}
    />,
  );
  return { host, onDisconnected, onLookbackDaysChange, onPaymentKeywordsChange, onTransferKeywordsChange };
}

describe('SettingsPanel', () => {
  it('shows the connected Bridge URL with the path masked', () => {
    renderPanel();

    expect(screen.getByText('https://bridge.simplefin.org/••••••')).toBeInTheDocument();
  });

  it('requires confirmation before disconnecting', async () => {
    const { host, onDisconnected } = renderPanel();
    host.secrets.set(AUTH_SECRET_KEY, 'secret');

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(host.secrets.get(AUTH_SECRET_KEY)).toBe('secret');
  });

  it('clears the stored credential and config, then notifies the parent on confirm', async () => {
    const { host, onDisconnected } = renderPanel();
    host.secrets.set(AUTH_SECRET_KEY, 'secret');
    host.storage.set('simplefin.config', JSON.stringify({ baseUrl: BASE_URL, mappings: [] }));

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, disconnect/i }));

    expect(host.secrets.get(AUTH_SECRET_KEY)).toBeUndefined();
    expect(JSON.parse(host.storage.get('simplefin.config') as string)).toEqual({
      baseUrl: null,
      mappings: [],
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      paymentKeywords: DEFAULT_PAYMENT_KEYWORDS,
      transferKeywords: DEFAULT_TRANSFER_KEYWORDS,
    });
    expect(onDisconnected).toHaveBeenCalled();
  });

  it('surfaces a disconnect failure instead of silently notifying the parent', async () => {
    const { host, onDisconnected } = renderPanel();
    host.api.secrets.delete = vi.fn(async () => {
      throw new Error('keyring unavailable');
    });

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, disconnect/i }));

    expect(await screen.findByText(/keyring unavailable/i)).toBeInTheDocument();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('disables Save until the lookback window actually changes to a valid value', async () => {
    renderPanel({ lookbackDays: 30 });
    const input = screen.getByLabelText(/lookback window/i);
    const save = screen.getByRole('button', { name: /^save$/i });

    expect(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '60');
    expect(save).toBeEnabled();
  });

  it('saves the parsed lookback window as a number', async () => {
    const { onLookbackDaysChange } = renderPanel({ lookbackDays: 30 });
    const input = screen.getByLabelText(/lookback window/i);

    await userEvent.clear(input);
    await userEvent.type(input, '90');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onLookbackDaysChange).toHaveBeenCalledWith(90);
  });

  it('shows the current payment keywords as a comma-separated list', () => {
    renderPanel({ paymentKeywords: ['PAYMENT', 'AUTOPAY'] });
    expect(screen.getByLabelText(/payment keywords/i)).toHaveValue('PAYMENT, AUTOPAY');
  });

  it('disables the payment Save button until the keyword list actually changes', async () => {
    renderPanel({ paymentKeywords: ['PAYMENT'] });
    const input = screen.getByLabelText(/payment keywords/i);
    const save = screen.getByRole('button', { name: /^save keywords$/i });

    expect(save).toBeDisabled();
    await userEvent.type(input, ', AUTOPAY');
    expect(save).toBeEnabled();
  });

  it('saves the payment comma-separated input as a trimmed keyword array', async () => {
    const { onPaymentKeywordsChange } = renderPanel({ paymentKeywords: ['PAYMENT'] });
    const input = screen.getByLabelText(/payment keywords/i);

    await userEvent.clear(input);
    await userEvent.type(input, ' payment ,  autopay ,thank you ');
    await userEvent.click(screen.getByRole('button', { name: /^save keywords$/i }));

    expect(onPaymentKeywordsChange).toHaveBeenCalledWith(['payment', 'autopay', 'thank you']);
  });

  it('shows the current transfer keywords as a comma-separated list', () => {
    renderPanel({ transferKeywords: ['TRANSFER', 'XFER'] });
    expect(screen.getByLabelText(/transfer keywords/i)).toHaveValue('TRANSFER, XFER');
  });

  it('disables the transfer Save button until the keyword list actually changes', async () => {
    renderPanel({ transferKeywords: ['TRANSFER'] });
    const input = screen.getByLabelText(/transfer keywords/i);
    const save = screen.getByRole('button', { name: /^save transfer keywords$/i });

    expect(save).toBeDisabled();
    await userEvent.type(input, ', XFER');
    expect(save).toBeEnabled();
  });

  it('saves the transfer comma-separated input as a trimmed keyword array', async () => {
    const { onTransferKeywordsChange } = renderPanel({ transferKeywords: ['TRANSFER'] });
    const input = screen.getByLabelText(/transfer keywords/i);

    await userEvent.clear(input);
    await userEvent.type(input, ' transfer ,  xfer ');
    await userEvent.click(screen.getByRole('button', { name: /^save transfer keywords$/i }));

    expect(onTransferKeywordsChange).toHaveBeenCalledWith(['transfer', 'xfer']);
  });
});
