/** First "Rig N" (N ≥ 1) not already in `taken`. Duplicate names are harmless
    — a rig is identified by its id — but a list where two rows read the same
    is not, so the suggested default skips every name still in use. Counting
    rigs is not enough once one has been deleted or renamed. */
export function nextRigName(taken: string[]): string {
  const names = new Set(taken);
  let n = 1;
  while (names.has(`Rig ${n}`)) n += 1;
  return `Rig ${n}`;
}
