export function applyPercentDiscount(cents: number, percent: number): number {
  return Math.round(cents * (1 - percent));
}
