import type { BacktestRun, MetricDistribution } from '../../types/api';
import { formatBeijingTime } from '../../utils/presentation';

const STATUS = {
  succeeded: { text: '已完成', theme: 'success' },
  running: { text: '进行中', theme: 'primary' },
  failed: { text: '失败', theme: 'danger' },
} as const;

export function runListItem(run: BacktestRun) {
  return {
    id: run.id,
    title: `#${run.id} ${run.strategyName} · ${run.strategyVersion}`,
    range: `${run.evaluationStartIssue}–${run.evaluationEndIssue} · 每期${run.ticketsPerIssue}注`,
    statusText: STATUS[run.status].text,
    statusTheme: STATUS[run.status].theme,
  };
}

function interval(value: [number, number] | null, format: (value: number) => string): string {
  return value === null ? '未提供' : `[${format(value[0])}, ${format(value[1])}]`;
}
const decimal = (digits: number) => (value: number) => value.toFixed(digits);
const percent = (value: number) => `${(value * 100).toFixed(3)}%`;
const optional = (value: number | null, format: (value: number) => string) => value === null ? '未提供' : format(value);

interface MetricDefinition { key: string; label: string; format: (value: number) => string; definition: string }
const HIT_METRICS: MetricDefinition[] = [
  { key: 'averageRedHits', label: '平均红命中（每注）', format: decimal(4), definition: '每注6红与开奖6红的平均重合个数。' },
  { key: 'blueHitRate', label: '蓝球命中率', format: percent, definition: '蓝球与开奖蓝球相同的注数比例。' },
];
const SCORE_METRICS: MetricDefinition[] = [
  { key: 'redLogLoss', label: '红球 log loss', format: decimal(6), definition: '33个号码边际二元log loss的平均；越低越好。' },
  { key: 'redBrierScore', label: '红球 Brier', format: decimal(6), definition: '33个号码边际Brier的平均；越低越好。' },
  { key: 'blueLogLoss', label: '蓝球 log loss', format: decimal(6), definition: '16类分类log loss；越低越好。' },
  { key: 'blueBrierScore', label: '蓝球 Brier', format: decimal(6), definition: '16类Brier求和；越低越好。' },
];

function metricRows(distributions: Record<string, MetricDistribution> | null, definitions: MetricDefinition[]) {
  return definitions.map(item => {
    const metric = distributions?.[item.key];
    return {
      key: item.key, label: item.label, definition: item.definition,
      mean: metric ? item.format(metric.mean) : '未提供',
      range: metric && metric.minimum !== undefined && metric.maximum !== undefined
        ? `${item.format(metric.minimum)} – ${item.format(metric.maximum)}` : '未提供',
      outcomeInterval: metric ? interval(metric.outcomeInterval95, item.format) : '未提供',
      meanInterval: metric ? interval(metric.monteCarloMeanInterval95, item.format) : '未提供',
    };
  });
}

/** 单个已保存运行的展示；summary=null或非成功状态不画任何指标。 */
export function runDetail(run: BacktestRun) {
  const summary = run.status === 'succeeded' ? run.summary : null;
  const coverage = summary?.coverage ?? null;
  const audit = summary?.payoutAudit ?? null;
  const calibration = summary?.calibration ?? null;
  return {
    ...runListItem(run),
    seed: run.seed,
    holdout: run.usesFinalHoldout ? '是（前瞻保留段）' : '否',
    startedAt: formatBeijingTime(run.startedAt),
    finishedAt: formatBeijingTime(run.finishedAt),
    hasSummary: summary !== null,
    definitionVersion: summary?.definitionVersion ?? '未提供',
    dataFingerprint: summary?.dataFingerprint ?? '未提供',
    trainingFirstIssue: coverage?.trainingFirstIssue ?? '未提供',
    evaluatedIssues: coverage ? `${coverage.evaluatedIssues}期（${coverage.evaluationFirstIssue}–${coverage.evaluationLastIssue}）` : '未提供',
    hitRows: metricRows(summary?.distributions ?? null, HIT_METRICS),
    scoreRows: metricRows(summary?.distributions ?? null, SCORE_METRICS),
    theoreticalRedHits: calibration ? calibration.theoreticalAverageRedHits.toFixed(4) : '未提供',
    theoreticalBlueRate: calibration ? percent(calibration.theoreticalBlueHitRate) : '未提供',
    redTailP: optional(calibration?.firstRunRedTailP ?? null, decimal(4)),
    blueTailP: optional(calibration?.firstRunBlueTailP ?? null, decimal(4)),
    eligibleIssues: audit ? String(audit.eligibleIssues) : '未提供',
    withheldIssues: audit ? String(audit.withheldIssues.length) : '未提供',
  };
}
