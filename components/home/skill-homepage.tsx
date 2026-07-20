import { TrendingBoard, type TrendingSkill } from "./trending-board";
import { formatCapturedAt, formatNumber, formatPeriodStars } from "./trending-format";

export type DailyTopSignal = Required<TrendingSkill>;

type SkillHomepageProps = {
  dailyTopSignal: DailyTopSignal;
  initialTrending?: readonly TrendingSkill[];
};

export function SkillHomepage({ dailyTopSignal, initialTrending = [] }: SkillHomepageProps) {
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

      <section className="daily-signal" aria-labelledby="daily-signal-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Daily observation</p>
            <h2 id="daily-signal-heading">今日 Top Signal</h2>
          </div>
          <p className="section-note">最新已捕获快照</p>
        </div>
        <article className="top-signal">
          <span className="signal-rank">#{dailyTopSignal.rank}</span>
          <div className="signal-repository">
            <h3><a href={dailyTopSignal.href}>{dailyTopSignal.name}</a></h3>
            <p>{dailyTopSignal.language ?? dailyTopSignal.description}</p>
            {dailyTopSignal.language && dailyTopSignal.description !== dailyTopSignal.language ? <p className="signal-description">{dailyTopSignal.description}</p> : null}
          </div>
          <dl className="signal-facts">
            <div><dt>Period stars</dt><dd>{formatPeriodStars(dailyTopSignal.starsInPeriod)} stars</dd></div>
            <div><dt>Total stars</dt><dd>{formatNumber(dailyTopSignal.stars)}</dd></div>
            <div><dt>Captured</dt><dd>Captured {formatCapturedAt(dailyTopSignal.capturedAt)}</dd></div>
          </dl>
        </article>
      </section>

      <section id="install" className="capabilities" aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading">Skill 能做什么</h2>
        <ul>
          <li>发现项目：从趋势信号中找到适合当前任务的项目。</li>
          <li>分析指定仓库：输入 owner/repo 获取当前项目观察。</li>
          <li>持续关注：持续跟踪已关注项目的变化。</li>
        </ul>
      </section>

      <TrendingBoard initialItems={initialTrending} />

      <footer className="home-footer"><a href="/console">打开控制台</a></footer>
    </main>
  );
}
