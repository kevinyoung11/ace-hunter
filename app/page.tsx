import { SkillHomepage, type DailyTopSignal } from "../components/home/skill-homepage";
import { TrendingBoard } from "../components/home/trending-board";
import { webService } from "../lib/web/service";

export const dynamic = "force-dynamic";

export default async function Page() {
  try {
    const trending = await webService().trending("daily");
    const initialTrending = trending.kind === "trending" ? trending.items.map(toTrendingSkill) : [];
    const dailyTopSignal = initialTrending[0];

    return dailyTopSignal
      ? <SkillHomepage dailyTopSignal={dailyTopSignal} initialTrending={initialTrending} />
      : <UnavailableSkillHomepage />;
  } catch {
    return <UnavailableSkillHomepage error />;
  }
}

function toTrendingSkill(item: { rank: number; fullName: string; repoUrl: string; language: string; starsInPeriod: number | null; stars: number | null; capturedAt: string }): DailyTopSignal {
  return {
    id: item.fullName,
    name: item.fullName,
    description: item.language,
    href: item.repoUrl,
    rank: item.rank,
    language: item.language,
    starsInPeriod: item.starsInPeriod,
    stars: item.stars,
    capturedAt: item.capturedAt,
  };
}

function UnavailableSkillHomepage({ error = false }: { error?: boolean }) {
  return (
    <main className="home-shell">
      <header className="home-masthead">
        <a className="home-brand" href="/">ACE HUNTER</a>
        <p>Open-source research index</p>
      </header>
      <section className="home-hero" aria-labelledby="homepage-heading">
        <p className="home-eyebrow">Signal-led software research</p>
        <h1 id="homepage-heading">找到值得安装的 Skill</h1>
        <p className="home-dek">从真实信号中发现工具能力，安装后立即用于研究、创作和自动化。</p>
        <p className="home-actions">
          <a href="#install">安装 Skill</a>{" "}
          <a href="#trending">查看趋势榜</a>
        </p>
      </section>

      {error ? <p className="home-unavailable" aria-live="polite">趋势榜暂时无法加载，请稍后重试。</p> : null}

      <section id="install" className="capabilities" aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading">Skill 能做什么</h2>
        <ul>
          <li>发现项目：从趋势信号中找到适合当前任务的项目。</li>
          <li>分析指定仓库：输入 owner/repo 获取当前项目观察。</li>
          <li>持续关注：持续跟踪已关注项目的变化。</li>
        </ul>
      </section>

      <TrendingBoard initialItems={[]} initialUnavailable />

      <footer className="home-footer"><a href="/console">打开控制台</a></footer>
    </main>
  );
}
