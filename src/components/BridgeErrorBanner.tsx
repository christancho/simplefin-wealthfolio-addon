import { Alert, AlertDescription, AlertTitle } from '@wealthfolio/ui';
import type { SfBridgeError } from '../lib/simplefin/parse';

export interface BridgeErrorBannerProps {
  errors: SfBridgeError[];
  dashboardUrl: string;
}

export function BridgeErrorBanner({ errors, dashboardUrl }: BridgeErrorBannerProps) {
  if (errors.length === 0) return null;

  return (
    <div className="space-y-2">
      {errors.map((error) => (
        <Alert key={error.key} variant="warning" role="alert">
          <AlertTitle>SimpleFIN Bridge error</AlertTitle>
          <AlertDescription>
            {error.msg}{' '}
            <a href={dashboardUrl} target="_blank" rel="noreferrer">
              Open SimpleFIN Bridge
            </a>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
