export function cumeDist(values: readonly number[]): number[] {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("CUME_DIST values must be finite numbers");
  }
  if (values.length === 0) {
    return [];
  }

  const ordered = [...values].sort((left, right) => left - right);
  const percentileByValue = new Map<number, number>();
  ordered.forEach((value, index) => {
    percentileByValue.set(value, (100 * (index + 1)) / ordered.length);
  });

  return values.map((value) => percentileByValue.get(value)!);
}
