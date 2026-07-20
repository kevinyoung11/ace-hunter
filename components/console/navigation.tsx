import Link from "next/link";

export function Navigation() {
  return <header className="topbar"><Link className="brand" href="/console">ACE HUNTER</Link><nav><Link href="/console">今日报告</Link><Link href="/analyze">项目分析</Link><Link href="/monitors">我的关注</Link></nav></header>;
}
