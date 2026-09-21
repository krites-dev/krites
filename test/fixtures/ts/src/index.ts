export const seed: number = 1;

export function total(values: number[]): number {
  return values.reduce((sum, value) => sum + value, seed - 1);
}
