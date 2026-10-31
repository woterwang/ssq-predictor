/**
 * 纯函数号码统计：传入已按期号升序的窗口，不依赖数据库和系统时间。
 * 冷热、遗漏仅描述历史，不代表号码下期更容易出现。
 */
import { BLUE_BALL_MAX, RED_BALL_COUNT_PER_DRAW, RED_BALL_MAX } from '../domain/lottery';
import type { AnalysisDraw, NumberStatistics } from './analysisTypes';

/** 线性插值分位数，与常用 R-7 定义一致；调用者保证数组非空且已升序。 */
function quantile(sortedValues: readonly number[], probability: number): number {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * (position - lowerIndex);
}

/** 按同色球计算频次与遗漏；输出固定 33 个红球或 16 个蓝球，包括从未出现的号码。 */
export function calculateNumberStatistics(
  draws: readonly AnalysisDraw[],
  ballColor: 'red' | 'blue',
): NumberStatistics[] {
  const maximumNumber = ballColor === 'red' ? RED_BALL_MAX : BLUE_BALL_MAX;
  const theoreticalAppearanceRate = ballColor === 'red' ? RED_BALL_COUNT_PER_DRAW / RED_BALL_MAX : 1 / BLUE_BALL_MAX;
  const appearanceIndexes = Array.from({ length: maximumNumber }, () => [] as number[]);

  draws.forEach((draw, drawIndex) => {
    const numbers = ballColor === 'red' ? draw.redBalls : [draw.blueBall];
    for (const number of numbers) appearanceIndexes[number - 1].push(drawIndex);
  });
  const sortedCounts = appearanceIndexes.map((indexes) => indexes.length).sort((left, right) => left - right);
  const coldThreshold = quantile(sortedCounts, 0.25);
  const hotThreshold = quantile(sortedCounts, 0.75);

  return appearanceIndexes.map((indexes, numberIndex) => {
    const completeGaps: number[] = [];
    for (let index = 1; index < indexes.length; index++) {
      // 相邻两期都出现时遗漏为 0，而非 1。
      completeGaps.push(indexes[index] - indexes[index - 1] - 1);
    }
    const firstIndex = indexes[0];
    const lastIndex = indexes[indexes.length - 1];
    const currentOmission = lastIndex === undefined ? draws.length : draws.length - lastIndex - 1;
    const leadingObservedGap = firstIndex === undefined ? draws.length : firstIndex;
    const completeOmissionDistribution: Record<string, number> = {};
    for (const gap of completeGaps) {
      completeOmissionDistribution[String(gap)] = (completeOmissionDistribution[String(gap)] ?? 0) + 1;
    }
    const appearanceCount = indexes.length;
    return {
      number: numberIndex + 1,
      appearanceCount,
      appearanceRate: draws.length === 0 ? null : appearanceCount / draws.length,
      theoreticalAppearanceRate,
      expectedAppearanceCount: draws.length * theoreticalAppearanceRate,
      currentOmission,
      currentOmissionIsLowerBound: lastIndex === undefined,
      maximumObservedOmission: Math.max(leadingObservedGap, currentOmission, ...completeGaps),
      maximumCompleteOmission: completeGaps.length === 0 ? null : Math.max(...completeGaps),
      averageCompleteOmission: completeGaps.length === 0 ? null : completeGaps.reduce((sum, gap) => sum + gap, 0) / completeGaps.length,
      completeOmissionCount: completeGaps.length,
      completeOmissionDistribution,
      heatLabel: draws.length === 0 ? 'unavailable' : appearanceCount < coldThreshold ? 'cold' : appearanceCount > hotThreshold ? 'hot' : 'normal',
      lastAppearanceIssue: lastIndex === undefined ? null : draws[lastIndex].issue,
    };
  });
}