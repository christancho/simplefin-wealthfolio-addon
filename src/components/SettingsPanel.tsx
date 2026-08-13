import type { HostAPI } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@wealthfolio/ui';
import { useState } from 'react';
import { AUTH_SECRET_KEY } from '../lib/simplefin/client';
import { maskBaseUrl } from '../lib/simplefin/url';
import { emptyConfig, writeConfig } from '../lib/storage/config';

export interface SettingsPanelProps {
  api: HostAPI;
  baseUrl: string;
  lookbackDays: number;
  onLookbackDaysChange: (days: number) => void;
  onDisconnected: () => void;
}

function isValidLookback(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

export function SettingsPanel({
  api,
  baseUrl,
  lookbackDays,
  onLookbackDaysChange,
  onDisconnected,
}: SettingsPanelProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDraft, setLookbackDraft] = useState(String(lookbackDays));

  async function handleDisconnect() {
    setError(null);
    setDisconnecting(true);
    try {
      await api.secrets.delete(AUTH_SECRET_KEY);
      await writeConfig(api, emptyConfig());
      onDisconnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDisconnecting(false);
    }
  }

  function handleSaveLookback() {
    onLookbackDaysChange(Number(lookbackDraft));
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>Manage the SimpleFIN Bridge connection for this addon.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>SimpleFIN Bridge URL</Label>
            <p className="text-muted-foreground text-sm">{maskBaseUrl(baseUrl)}</p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={disconnecting}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect SimpleFIN Bridge?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears the stored SimpleFIN credentials and all account mappings.
                  You&apos;ll need to reconnect with a new setup token to sync again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDisconnect}>Yes, disconnect</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sync</CardTitle>
          <CardDescription>
            Every sync reaches back at least this many days, so a newly mapped account gets its
            history even if your other accounts are already caught up.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lookback-days">Lookback window (days)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="lookback-days"
                type="number"
                min={1}
                step={1}
                className="w-24"
                value={lookbackDraft}
                onChange={(e) => setLookbackDraft(e.target.value)}
              />
              <Button
                onClick={handleSaveLookback}
                disabled={
                  !isValidLookback(lookbackDraft) || Number(lookbackDraft) === lookbackDays
                }
              >
                Save
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
