import { TrendingBoard, type TrendingSkill } from "./trending-board";

export type DailyTopSignal = Required<TrendingSkill>;

type SkillHomepageProps = {
  dailyTopSignal: DailyTopSignal;
  initialTrending?: readonly TrendingSkill[];
};

export function SkillHomepage({ dailyTopSignal, initialTrending = [] }: SkillHomepageProps) {
  return (
    <main>
      <section aria-labelledby="homepage-heading">
        <p>为你的工作流发现可安装、可复用的能力。</p>
        <h1 id="homepage-heading">找到值得安装的 Skill</h1>
        <p>从真实信号中发现工具能力，安装后立即用于研究、创作和自动化。</p>
        <p>
          <a href="#install">安装 Skill</a>{" "}
          <a href="#trending">查看趋势榜</a>
        </p>
      </section>

      <section aria-labelledby="daily-signal-heading">
        <h2 id="daily-signal-heading">今日 Top Signal</h2>
        <article>
          <h3><a href={dailyTopSignal.href}>{dailyTopSignal.name}</a></h3>
          <p>{dailyTopSignal.description}</p>
        </article>
      </section>

      <section id="install" aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading">Skill 能做什么</h2>
        <ul>
          <li>发现：从趋势信号中找到适合当前任务的能力。</li>
          <li>安装：把选中的 Skill 接入自己的工作流。</li>
          <li>持续更新：跟踪能力变化，及时获得新的可用方案。</li>
        </ul>
      </section>

      <TrendingBoard initialItems={initialTrending} />

      <p><a href="/console">打开控制台</a></p>
    </main>
  );
}
