import type { ResultLimit as PotentialResultLimit } from "../../reports/potential-list.js";

export function signalLimit(value: string): PotentialResultLimit {
  if (value === "all") return null;
  if (!/^(?:[1-9]|[1-9][0-9]{1,2}|1000)$/u.test(value)) throw validationError();
  return Number(value);
}

export function exactChoice<const T extends string>(value: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw validationError();
  return value as T;
}

function validationError(): Error {
  return Object.assign(new Error("invalid signal option"), { code: "validation_error" });
}
