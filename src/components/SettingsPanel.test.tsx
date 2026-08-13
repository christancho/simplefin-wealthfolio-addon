import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { AUTH_SECRET_KEY } from '../lib/simplefin/client';
import { DEFAULT_LOOKBACK_DAYS } from '../lib/storage/config';
import { SettingsPanel } from './SettingsPanel';

const BASE_URL = 'https://bridge.simplefin.org/simplefin';

function renderPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const host = createMockHost();
  const onDisconnected = vi.fn();
  const onLookbackDaysChange = vi.fn();
  render(
    <SettingsPanel
      api={host.api}
      baseUrl={BASE_URL}
      lookbackDays={DEFAULT_LOOKBACK_DAYS}
      onLookbackDaysChange={onLookbackDaysChange}
      onDisconnected={onDisconnected}
      {...overrides}
    />,
  );
  return { host, onDisconnected, onLookbackDaysChange };
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
});
