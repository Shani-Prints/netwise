/**
 * Finds the gross amount g (>= 0) such that netAt(g) - netAt(0) === target, with netAt increasing in g.
 * Pure bisection, fixed 80 iterations, no rounding: deterministic and exact to floating point.
 */
export function solveGrossUp(netAt: (g: number) => number, target: number): number {
  if (target <= 0) return 0;
  const base = netAt(0);
  let lo = 0;
  let hi = target;
  // Marginal take-home is > 0 (max marginal rate 50% + 7% + 5.17% < 100%), so doubling terminates quickly.
  for (let i = 0; netAt(hi) - base < target; i++) {
    lo = hi;
    hi *= 2;
    if (i > 60) throw new Error('gross-up did not converge: net is not increasing in gross');
  }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (netAt(mid) - base < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
