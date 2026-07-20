import { AnalyzeForm } from "../../components/console/analyze-form";
import { Navigation } from "../../components/console/navigation";
export default function AnalyzePage() { return <main><Navigation /><section className="page-intro"><p>已采集事实</p><h1>项目分析</h1><p className="summary">分析不会触发实时采集；数据不完整时会明确标示。</p></section><AnalyzeForm /></main>; }
