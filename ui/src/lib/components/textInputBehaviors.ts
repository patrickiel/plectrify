/**
 * Shared behaviours for the app's inline text inputs (renames, save-as
 * fields). Kept as plain functions so each consumer wires them into its own
 * markup.
 */

/** Attachment: focus the input and select its contents as soon as it mounts. */
export function selectOnMount(node: HTMLInputElement) {
  node.focus();
  node.select();
}

/**
 * Keydown handler: Enter commits, Escape cancels.
 *
 * Escape claims the event with `preventDefault()` — Popover's window-level
 * Escape handler checks `defaultPrevented`, so cancelling an inline edit
 * inside a menu doesn't also dismiss the menu around it.
 */
export function onEnterEscape(commit: () => void, cancel: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
}
