import Link from "next/link";
export const dynamic = "force-dynamic";
export default function OpsLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <>{children}<footer className="ops-footer"><Link href="/">返回产品控制台</Link><span>运维数据仅通过同源服务端代理读取，浏览器不会接触 OPS token。</span></footer></>; }
