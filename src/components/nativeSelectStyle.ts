/**
 * A native `<select>` is used in these forms instead of `@wealthfolio/ui`'s
 * Radix-based `Select` because `userEvent.selectOptions` (the tests' way of
 * choosing an option) does not work against Radix's listbox in jsdom. This
 * class string matches the UI kit's input styling so it still looks native.
 */
export const nativeSelectClassName =
  'border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm';
