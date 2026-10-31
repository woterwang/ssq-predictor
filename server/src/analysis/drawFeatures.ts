/** 组合特征纯函数。阈值、连号和 AC 定义显式写在这里，避免图表与回测使用不同口径。 */
import type { AnalysisDraw, DrawFeatures } from './analysisTypes';

export function calculateDrawFeatures(draw: AnalysisDraw, previousDraw: AnalysisDraw | null): DrawFeatures {
  const redBalls = [...draw.redBalls].sort((left, right) => left - right);
  const redZoneCounts = [0, 0, 0];
  const redTailCounts = Array<number>(10).fill(0);
  const positiveDifferences = new Set<number>();
  let consecutiveGroupCount = 0;
  let consecutivePairCount = 0;
  let previousPairWasConsecutive = false;

  redBalls.forEach((number, index) => {
    redZoneCounts[Math.floor((number - 1) / 11)]++;
    redTailCounts[number % 10]++;
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex++) {
      positiveDifferences.add(number - redBalls[earlierIndex]);
    }
    if (index === 0) return;
    const isConsecutive = number - redBalls[index - 1] === 1;
    if (isConsecutive) {
      consecutivePairCount++;
      if (!previousPairWasConsecutive) consecutiveGroupCount++;
    }
    previousPairWasConsecutive = isConsecutive;
  });

  const redOddCount = redBalls.filter((number) => number % 2 === 1).length;
  const redSmallCount = redBalls.filter((number) => number <= 16).length;
  return {
    issue: draw.issue,
    drawDate: draw.drawDate,
    redSum: redBalls.reduce((sum, number) => sum + number, 0),
    redSpan: redBalls[redBalls.length - 1] - redBalls[0],
    redOddCount,
    redEvenCount: redBalls.length - redOddCount,
    redSmallCount,
    redLargeCount: redBalls.length - redSmallCount,
    redZoneCounts,
    consecutiveGroupCount,
    consecutivePairCount,
    repeatedRedCount: previousDraw === null ? null : redBalls.filter((number) => previousDraw.redBalls.includes(number)).length,
    redTailCounts,
    acValue: positiveDifferences.size - (redBalls.length - 1),
    blueBall: draw.blueBall,
    blueIsOdd: draw.blueBall % 2 === 1,
    blueSize: draw.blueBall <= 8 ? 'small' : 'large',
    blueAmplitude: previousDraw === null ? null : Math.abs(draw.blueBall - previousDraw.blueBall),
  };
}

/** 所有分布按“期”计数。前一期相关指标无可比数据时跳过，不能把 null 当成 0。 */
export function calculateFeatureDistributions(features: readonly DrawFeatures[]): Record<string, Record<string, number>> {
  const distributions: Record<string, Record<string, number>> = {};
  const increment = (name: string, value: string | number | null): void => {
    const histogram = distributions[name] ?? (distributions[name] = {});
    if (value === null) return;
    const key = String(value);
    histogram[key] = (histogram[key] ?? 0) + 1;
  };
  for (const feature of features) {
    increment('redSum', feature.redSum);
    increment('redSpan', feature.redSpan);
    increment('redOddEvenRatio', `${feature.redOddCount}:${feature.redEvenCount}`);
    increment('redSmallLargeRatio', `${feature.redSmallCount}:${feature.redLargeCount}`);
    increment('redZoneRatio', feature.redZoneCounts.join(':'));
    increment('consecutiveGroupCount', feature.consecutiveGroupCount);
    increment('consecutivePairCount', feature.consecutivePairCount);
    increment('repeatedRedCount', feature.repeatedRedCount);
    increment('acValue', feature.acValue);
    increment('blueOddEven', feature.blueIsOdd ? 'odd' : 'even');
    increment('blueSize', feature.blueSize);
    increment('blueAmplitude', feature.blueAmplitude);
    feature.redTailCounts.forEach((count, tail) => increment(`redTail${tail}Count`, count));
  }
  return distributions;
}