export interface MonitorDependencies {
  upsert(input: { userId: string; productId: string; status: "active" | "inactive" }): Promise<string>;
}

export async function setProductMonitor(
  dependencies: MonitorDependencies,
  input: { userId: string; productId: string; active: boolean },
): Promise<{ monitorId: string; status: "active" | "inactive" }> {
  if (!validId(input.userId) || !validId(input.productId) || typeof input.active !== "boolean") throw new Error("invalid_monitor_input");
  const status = input.active ? "active" as const : "inactive" as const;
  const monitorId = await dependencies.upsert({ userId: input.userId, productId: input.productId, status });
  if (!validId(monitorId)) throw new Error("invalid_monitor_id");
  return { monitorId, status };
}

function validId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}
