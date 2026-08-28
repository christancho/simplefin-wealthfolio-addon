# Development

Requires **Node.js 18+** and **pnpm**.

```bash
pnpm install
pnpm test          # Vitest unit tests
pnpm type-check    # tsc --noEmit
pnpm build         # -> dist/addon.js
pnpm dev:server    # hot-reload dev server for a live Wealthfolio instance
pnpm bundle        # clean + build + zip for distribution
```

To test against a real instance, run `pnpm dev:server` and load the addon into
a self-hosted Wealthfolio via its addon developer settings.

## Architecture notes

Worth knowing before changing anything:

- **Never call `createRoot`.** The host owns a single React root per addon and
  mounts the route `component` itself. Calling `createRoot` leaves orphaned
  trees whose re-renders never reach the DOM — the 3.6 "buttons do nothing"
  bug. Register routes with `component:`, not `render:`.
  *(The published `@wealthfolio/addon-sdk` README still shows the old
  `createRoot` pattern. It is stale — follow the SDK's own type definitions.)*
- **No react-router hooks.** The sandbox has no router provider; the host
  passes the current location to the route component as a `location` prop.
- **Host dependencies are never bundled.** React, react-dom, react-query,
  `@wealthfolio/ui`, date-fns, lucide-react and recharts are provided by the
  host, externalized in `vite.config.ts` and declared in `manifest.json`.
- **Cash sync is stateful, and has to be.** `ActivityImport` carries no
  `sourceSystem`/`sourceRecordId`, so Wealthfolio cannot dedupe our pushes.
  The addon owns idempotency via a per-account watermark plus a bounded
  recent-id window in `storage`. Holdings need none of this —
  `snapshots.checkImport()` returns `existingDates`.
- **`storage` has limits:** keys ≤128 chars from `[A-Za-z0-9_.:-]`, values
  ~250 KB. Use many small keys. `localStorage` is unavailable in the sandbox.
