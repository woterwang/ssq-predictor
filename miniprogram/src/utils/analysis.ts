import type { AnalysisReport, NumberStatistics } from '../types/api';

export const HEAT_TEXT: Record<NumberStatistics['heatLabel'], string> = { hot: '热', normal: '常', cold: '冷', unavailable: '—' };
export const WINDOW_TEXT: Record<string, string> = { '30': '近30期', '100': '近100期', '300': '近300期', all: '全部可用' };

export function pad(number: number): string { return String(number).padStart(2, '0'); }
export function fixed(value: number | null, digits: number): string { return value === null ? '—' : value.toFixed(digits); }
export function percent(value: number | null): string { return value === null ? '—' : `${(value * 100).toFixed(2)}%`; }
/** 窗口内未出现时只知道下界，显示“≥N”而非精确N。 */
export function omissionText(item: NumberStatistics): string {
  return item.currentOmissionIsLowerBound ? `≥${item.currentOmission}` : String(item.currentOmission);
}
export function coverageText(report: AnalysisReport): string {
  if (report.sampleDrawCount === 0 || !report.firstIssue || !report.lastIssue) return '实际样本0期，暂无可统计开奖';
  return `实际样本${report.sampleDrawCount}期：第${report.firstIssue}期至第${report.lastIssue}期（2013年起可用数据）`;
}

/** 频次条以同色号码中的最大值（含理论期望）为满格；红蓝分别计算，不跨颜色比较。 */
export function numberRows(items: NumberStatistics[], color: 'red' | 'blue') {
  const maximum = Math.max(1, ...items.map(item => Math.max(item.appearanceCount, item.expectedAppearanceCount)));
  return items.map(item => ({
    number: item.number,
    numberText: pad(item.number),
    count: item.appearanceCount,
    heat: item.heatLabel,
    heatText: HEAT_TEXT[item.heatLabel],
    barPercent: (item.appearanceCount / maximum * 100).toFixed(1),
    expectedPercent: (item.expectedAppearanceCount / maximum * 100).toFixed(1),
    expectedText: item.expectedAppearanceCount.toFixed(1),
    omission: omissionText(item),
    averageOmission: fixed(item.averageCompleteOmission, 1),
    maximumObserved: String(item.maximumObservedOmission),
    accessibleLabel: `${color === 'red' ? '红' : '蓝'}球${item.number}，出现${item.appearanceCount}次，${HEAT_TEXT[item.heatLabel]}，当前遗漏${omissionText(item)}期`,
  }));
}

export function numberDetail(item: NumberStatistics, color: 'red' | 'blue') {
  return {
    title: `${color === 'red' ? '红' : '蓝'}球 ${pad(item.number)}`,
    color,
    number: item.number,
    heatText: HEAT_TEXT[item.heatLabel],
    count: String(item.appearanceCount),
    expected: item.expectedAppearanceCount.toFixed(1),
    rate: percent(item.appearanceRate),
    theoreticalRate: percent(item.theoreticalAppearanceRate),
    omission: omissionText(item),
    lowerBound: item.currentOmissionIsLowerBound,
    maximumObserved: String(item.maximumObservedOmission),
    maximumComplete: item.maximumCompleteOmission === null ? '—' : String(item.maximumCompleteOmission),
    averageComplete: fixed(item.averageCompleteOmission, 2),
    lastIssue: item.lastAppearanceIssue ?? '窗口内未出现',
  };
}
