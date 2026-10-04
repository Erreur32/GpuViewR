/** Callback ref that focuses its element once, when it mounts. Used instead
 *  of the `autoFocus` attribute (Sonar S9379) where landing in the field is
 *  the expected first action: login username, new host label. Module-level
 *  so React only calls it on mount and unmount, not on every render. */
export function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}
