function requireValidDate(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid date");
  return milliseconds;
}

export function utcHourBucket(value: Date): Date {
  const date = new Date(requireValidDate(value));
  date.setUTCMinutes(0, 0, 0);
  return date;
}

export function utcDayBucket(value: Date): Date {
  const date = new Date(requireValidDate(value));
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
