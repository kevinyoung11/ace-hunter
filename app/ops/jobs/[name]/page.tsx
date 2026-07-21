import { OpsJobDetail } from "../../../../components/ops/ops-console";
export const dynamic = "force-dynamic";
export default async function OpsJobPage({ params }: { params: Promise<{ name: string }> }) { return <OpsJobDetail name={(await params).name} />; }
