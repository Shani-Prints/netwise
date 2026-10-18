/** Display-only rounding. The engine itself never rounds; call these at the presentation edge. */
export const roundShekel = (v: number): number => {
  const r = Math.round(v);
  return r === 0 ? 0 : r; // avoid "-0"
};

/**
 * Difference as shown to the user: displayed alternative net minus displayed current net, so the numbers on
 * screen always add up (the reference workbook uses the same convention).
 */
export const displayDifference = (todayNet: number, alternativeNet: number): number =>
  roundShekel(alternativeNet) - roundShekel(todayNet);
