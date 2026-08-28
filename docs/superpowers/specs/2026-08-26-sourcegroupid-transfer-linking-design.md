# Link Reclassified Transfers via sourceGroupId — Design

Implements [#69](https://github.com/christancho/simplefin-wealthfolio-addon/issues/69).

## Problem

Wealthfolio's built-in "Data Consistency" checker flags every transfer this
addon reclassifies as an "incomplete transfer" — 28 flagged in production as
of 2026-08-26 — even when both legs are correctly typed `TRANSFER_IN`/
`TRANSFER_OUT` and match exactly on amount/date/account. The checker appears
to require an explicit link between the two legs rather than matching on
type+amount+date heuristically: a same-day, same-amount $3000 CAD pair was
still shown as unpaired.

`reclassifyPair()` (`src/lib/sync/reconciliation.ts:218`) reclassifies both
legs via `activities.saveMany({ updates: [...] })` and deliberately never
sets `sourceGroupId`, per a 2026-08-14 finding
(`docs/superpowers/specs/2026-08-14-reclassify-credit-card-payments-design.md:39`)
that `activities.update()` silently drops that field.

## Verified against a live host (2026-08-26)

That 2026-08-14 finding only tested `activities.update()`. A fresh probe —
built as a temporary auto-running tab on the Sync page, removed before this
plan — ran against a live `wealthfolio-e2e` container (host v3.6.3) and
tested every mutation path this addon has permission to call:

- **`saveMany({ creates: [...] })` with `sourceGroupId` set persists it.**
  Both the mutation's own response and a fresh, independent `search()` call
  afterward showed the value.
- **`activities.update()` with `sourceGroupId` set does not.** Re-confirms
  the 2026-08-14 finding: the field in both the response and the later
  `search()` read stayed at whatever it was before the update, ignoring the
  new value entirely.
- **Raw `activities.create()` was not tested** — this addon's manifest only
  declares `checkImport`, `import`, `search`, `update`, `saveMany` for the
  `activities` category, and a live call confirmed the host rejects
  `create()` outright ("Addon 'simplefin-sync' is not allowed to call
  activities.create"). Not needed anyway: `saveMany({ creates })` already
  covers the create path and needs no manifest change, confirmed by the
  probe running under the existing permission set.
- **`saveMany({ deleteIds: [...] })` also needs no extra permission** — the
  probe's cleanup step deleted its own test activities this way without any
  permission error, and a follow-up search confirmed they were gone.

**Conclusion:** linking the pair is possible. It requires creating new
`TRANSFER_IN`/`TRANSFER_OUT` activities with `sourceGroupId` set, not
updating the existing `CREDIT`/`DEPOSIT`/`WITHDRAWAL` activities in place.

## Design

### `reclassifyPair()` switches from update to delete+recreate

Currently:

```ts
async function reclassifyPair(api, inflowRow, withdrawalRow, sfTransactionId) {
  const result = await api.activities.saveMany({
    updates: [toUpdate(inflowRow, 'TRANSFER_IN'), toUpdate(withdrawalRow, 'TRANSFER_OUT')],
  });
  ...
}
```

Becomes:

```ts
function toCreate(row: ActivityDetails, activityType: string, sourceGroupId: string): ActivityCreate {
  return {
    accountId: row.accountId,
    activityType,
    activityDate: row.date,
    amount: row.amount,
    currency: row.currency,
    comment: row.comment,
    sourceGroupId,
  };
}

async function reclassifyPair(api, inflowRow, withdrawalRow, sfTransactionId) {
  const result = await api.activities.saveMany({
    creates: [
      toCreate(inflowRow, 'TRANSFER_IN', sfTransactionId),
      toCreate(withdrawalRow, 'TRANSFER_OUT', sfTransactionId),
    ],
    deleteIds: [inflowRow.id, withdrawalRow.id],
  });
  if (result.errors.length > 0) {
    throw new Error(`saveMany reported per-item errors for candidate ${sfTransactionId}: ${JSON.stringify(result.errors)}`);
  }
}
```

Both legs are still linked and deleted in a single `saveMany` call, for the
same reason the existing code already does one call instead of two: if the
host applied one leg and then failed the other, a split write would leave
the pair half-reclassified with no way to recover it on the next run (the
existing comment on this function explains why — that reasoning doesn't
change, only the payload shape does).

### `sourceGroupId` value: the candidate's `sfTransactionId`

No new id generation is needed. `StagedCandidate.sfTransactionId` (the
SimpleFIN transaction id of the inflow leg) is already unique per
reconciled pair and stable for the lifetime of the candidate — it's the
natural grouping key and avoids pulling in a UUID dependency for something
that already has one.

### `resolveAmbiguous()` needs no change

It already delegates to `reclassifyPair()` for the actual reclassification,
so the delete+recreate happens automatically once that function changes.

### New activity ids

Reclassification always happens as the terminal step for a candidate — once
`reclassifyPair()` succeeds, the candidate is dropped from staging (never
pushed back into `remaining` in `runReconciliation`, per the existing
control flow) and its old `inflowActivityId`/withdrawal id are never looked
up again. The new ids `saveMany` returns are not needed by anything
downstream and are not captured.

### Accepted risk: delete+recreate loses anything keyed to the old activity id

Deleting the original `CREDIT`/`DEPOSIT`/`WITHDRAWAL` activity and creating
a new `TRANSFER_IN`/`TRANSFER_OUT` one means anything Wealthfolio keeps
keyed to the old activity id — a manual category assignment, for example —
does not carry over. In practice this window is small: reconciliation runs
on every sync and a candidate expires after `EXPIRY_DAYS` (7 days) if never
matched, so a reclassified activity has usually existed for at most a few
days before this happens. This is accepted as-is; not solved by this plan.

## Testing

`src/test/mockHost.ts`'s default `saveMany` mock only echoes back
`updates`. It needs to also echo `creates` into `created` (assigning each a
synthetic id, the same way `checkImport`/`import` already do for other
flows) and to report `deleteIds` in `deleted`, since the reconciliation
tests assert on `saveMany`'s exact call shape and some assert on `created`
ids implicitly via `resolveAmbiguous`/`runReconciliation`'s return values.

Existing assertions of the form:

```ts
expect(host.api.activities.saveMany).toHaveBeenCalledWith({
  updates: [
    expect.objectContaining({ id: 'CARD-ACT-1', activityType: 'TRANSFER_IN' }),
    expect.objectContaining({ id: 'CASH-ACT-1', activityType: 'TRANSFER_OUT' }),
  ],
});
```

become:

```ts
expect(host.api.activities.saveMany).toHaveBeenCalledWith({
  creates: [
    expect.objectContaining({ accountId: 'WF-CARD', activityType: 'TRANSFER_IN', sourceGroupId: 'TXN-1' }),
    expect.objectContaining({ accountId: 'WF-CASH', activityType: 'TRANSFER_OUT', sourceGroupId: 'TXN-1' }),
  ],
  deleteIds: ['CARD-ACT-1', 'CASH-ACT-1'],
});
```
