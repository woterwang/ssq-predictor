/**
 * 预注册口径 v1：全量及每年固定十项检验，一次模拟同时组成各年份和全量。
 * 红球同期负相关；Pearson 型量只是距离，不查标准 chi-square 临界值。
 * 所有零分布都由相同长度、公平不放回模拟校准，包括完整遗漏的端点截断。
 */
import { findDrawSequenceProblems } from '../collector/drawSequenceValidator';
import type { AnalysisDraw } from './analysisTypes';
import { createResearchRandom, fillFairSequence, packAnalysisDraws, validateSimulationCount } from './researchRandom';

export const TEST_DEFINITIONS = [
  { id: 'redFrequency', definition: '33个红球计数的Σ(O−n*6/33)²/(n*6/33)', sequential: false },
  { id: 'blueFrequency', definition: '16个蓝球计数的Σ(O−n/16)²/(n/16)', sequential: false },
  { id: 'redOmission', definition: '汇总红球完整遗漏分箱0/1–2/3–5/6–10/11–20/21+的Pearson距离；期望m*(n−g−1)*p²*(1−p)^g，排除两端截断', sequential: true },
  { id: 'blueOmission', definition: '汇总蓝球完整遗漏，同红球分箱和有限样本期望；m=16,p=1/16', sequential: true },
  { id: 'redSum', definition: '和值分箱≤60/61–80/81–100/101–120/121–140/141–160/≥161；对穷举全部C(33,6)组合期望的Pearson距离', sequential: false },
  { id: 'redOdd', definition: '奇数个数0–6分布对全部红组合精确期望的Pearson距离', sequential: false },
  { id: 'redConsecutive', definition: '相邻连号对数0–5分布对全部红组合精确期望的Pearson距离；1,2,3算2对', sequential: false },
  { id: 'redRepeat', definition: '期内相邻两期红球重号数0–6对超几何C(6,k)C(27,6−k)/C(33,6)期望的Pearson距离；年段不含跨年第一对', sequential: true },
  { id: 'blueLagCovariance', definition: 'lag1固定总体中心协方差平方：[Σ(Bt−8.5)(Bt−1−8.5)/(n−1)/21.25]²；检测数字编码的线性关联', sequential: true },
  { id: 'blueLagRepeat', definition: '蓝球lag1相同计数对(n−1)/16的标准化偏离平方；补充非线性的相等关联', sequential: true },
] as const;

function choose(total: number, count: number): number {
  if (count < 0 || count > total) return 0;
  let result = 1;
  for (let index = 1; index <= count; index++) result = result * (total - index + 1) / index;
  return result;
}
const sumBounds = [60, 80, 100, 120, 140, 160];
function sumBin(sum: number): number { let bin = 0; while (bin < sumBounds.length && sum > sumBounds[bin]) bin++; return bin; }
function gapBin(gap: number): number { return gap === 0 ? 0 : gap <= 2 ? 1 : gap <= 5 ? 2 : gap <= 10 ? 3 : gap <= 20 ? 4 : 5; }

let exactStructure: { redSum: number[]; redOdd: number[]; redConsecutive: number[]; redRepeat: number[] } | undefined;
/** 一次性穷举约110万红组合，获得无拟合参数的理论结构分布。 */
export function getExactStructureProbabilities(): NonNullable<typeof exactStructure> {
  if (exactStructure !== undefined) return exactStructure;
  const redSum = Array<number>(7).fill(0), redOdd = Array<number>(7).fill(0), redConsecutive = Array<number>(6).fill(0);
  const total = choose(33, 6);
  for (let a = 1; a <= 28; a++) for (let b = a + 1; b <= 29; b++) for (let c = b + 1; c <= 30; c++)
    for (let d = c + 1; d <= 31; d++) for (let e = d + 1; e <= 32; e++) for (let f = e + 1; f <= 33; f++) {
      redSum[sumBin(a + b + c + d + e + f)]++;
      redOdd[(a % 2) + (b % 2) + (c % 2) + (d % 2) + (e % 2) + (f % 2)]++;
      redConsecutive[Number(b === a + 1) + Number(c === b + 1) + Number(d === c + 1) + Number(e === d + 1) + Number(f === e + 1)]++;
    }
  exactStructure = {
    redSum: redSum.map((value) => value / total), redOdd: redOdd.map((value) => value / total),
    redConsecutive: redConsecutive.map((value) => value / total),
    redRepeat: Array.from({ length: 7 }, (_, count) => choose(6, count) * choose(27, 6 - count) / total),
  };
  return exactStructure;
}

function omissionExpectations(length: number, maximum: number, probability: number): number[] {
  const expected = Array<number>(6).fill(0);
  for (let gap = 0; gap <= length - 2; gap++) expected[gapBin(gap)] += maximum * (length - gap - 1) * probability ** 2 * (1 - probability) ** gap;
  return expected;
}
function pearson(observed: ArrayLike<number>, expected: ArrayLike<number>): number {
  let distance = 0;
  for (let index = 0; index < observed.length; index++) {
    if (expected[index] > 0) distance += (observed[index] - expected[index]) ** 2 / expected[index];
    else if (observed[index] !== 0) throw new Error('理论零概率类别出现观测值');
  }
  return distance;
}

export interface ResearchSegment {
  name: string; start: number; end: number; firstIssue: string; lastIssue: string;
  sequenceProblems: ReturnType<typeof findDrawSequenceProblems>;
  expected: number[][];
}
export function defineResearchSegments(draws: readonly AnalysisDraw[]): ResearchSegment[] {
  if (draws.length === 0) return [];
  const ranges = [{ name: 'all', start: 0, end: draws.length }];
  for (let start = 0; start < draws.length;) {
    const year = draws[start].issue.slice(0, 4);
    let end = start + 1;
    while (end < draws.length && draws[end].issue.startsWith(year)) end++;
    ranges.push({ name: year, start, end }); start = end;
  }
  const exact = getExactStructureProbabilities();
  return ranges.map((range) => {
    const count = range.end - range.start;
    // 全量的跨年年末疑似缺期同时传给相关年段，不让单年校验漏掉年末缺口。
    const globalProblems = findDrawSequenceProblems(draws);
    const localProblems = findDrawSequenceProblems(draws.slice(range.start, range.end));
    const relevantGlobal = range.name === 'all' ? globalProblems : globalProblems.filter((problem) => problem.issue?.startsWith(range.name));
    const sequenceProblems = [...new Map([...localProblems, ...relevantGlobal].map((problem) => [problem.message, problem])).values()];
    return { ...range, firstIssue: draws[range.start].issue, lastIssue: draws[range.end - 1].issue, sequenceProblems,
      expected: [Array<number>(33).fill(count * 6 / 33), Array<number>(16).fill(count / 16),
        omissionExpectations(count, 33, 6 / 33), omissionExpectations(count, 16, 1 / 16),
        exact.redSum.map((p) => p * count), exact.redOdd.map((p) => p * count),
        exact.redConsecutive.map((p) => p * count), exact.redRepeat.map((p) => p * (count - 1))],
    };
  });
}

/** 同时计算10项量，只有固定大小计数表；不物化每期大型组合特征对象。 */
export function calculateSequenceStatistics(sequence: Uint8Array, segment: ResearchSegment): { values: number[]; observed: number[][]; blueLagSigned: number } {
  const counts = [new Float64Array(33), new Float64Array(16), new Float64Array(6), new Float64Array(6),
    new Float64Array(7), new Float64Array(7), new Float64Array(6), new Float64Array(7)];
  const lastRed = new Int32Array(34).fill(-1), lastBlue = new Int32Array(17).fill(-1);
  let blueProducts = 0, blueRepeats = 0;
  for (let index = segment.start; index < segment.end; index++) {
    const offset = index * 7;
    let sum = 0, odd = 0, consecutive = 0, repeated = 0;
    for (let position = 0; position < 6; position++) {
      const ball = sequence[offset + position];
      counts[0][ball - 1]++; sum += ball; odd += ball % 2;
      if (position > 0 && ball === sequence[offset + position - 1] + 1) consecutive++;
      if (lastRed[ball] >= segment.start) counts[2][gapBin(index - lastRed[ball] - 1)]++;
      if (lastRed[ball] === index - 1 && index > segment.start) repeated++;
      lastRed[ball] = index;
    }
    counts[4][sumBin(sum)]++; counts[5][odd]++; counts[6][consecutive]++;
    const blue = sequence[offset + 6];
    counts[1][blue - 1]++;
    if (lastBlue[blue] >= segment.start) counts[3][gapBin(index - lastBlue[blue] - 1)]++;
    lastBlue[blue] = index;
    if (index > segment.start) {
      counts[7][repeated]++;
      blueProducts += (blue - 8.5) * (sequence[offset - 1] - 8.5);
      blueRepeats += Number(blue === sequence[offset - 1]);
    }
  }
  const pairs = segment.end - segment.start - 1;
  const blueLagSigned = pairs > 0 ? blueProducts / pairs / 21.25 : 0;
  return { values: [...counts.map((count, index) => pearson(count, segment.expected[index])),
    blueLagSigned ** 2, pairs > 0 ? (blueRepeats - pairs / 16) ** 2 / (pairs * 15 / 256) : 0],
    observed: counts.map((count) => Array.from(count)).concat([[blueLagSigned], [blueRepeats]]), blueLagSigned };
}

/** 加一校准，包含相等值；从不返回0，也不把模拟均值当作临界值。 */
export function monteCarloP(exceedances: number, simulations: number): number {
  validateSimulationCount(simulations);
  if (!Number.isInteger(exceedances) || exceedances < 0 || exceedances > simulations) throw new Error('exceedances 超出模拟范围');
  return (exceedances + 1) / (simulations + 1);
}
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  if (pValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('BH输入必须为[0,1]概率');
  const ranked = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const corrected = Array<number>(pValues.length);
  let minimum = 1;
  for (let index = ranked.length - 1; index >= 0; index--) {
    minimum = Math.min(minimum, ranked[index].p * ranked.length / (index + 1));
    corrected[ranked[index].index] = minimum;
  }
  return corrected;
}

export function runRandomnessResearch(draws: readonly AnalysisDraw[], simulations: number, seed: number,
  onProgress?: (completed: number) => void) {
  validateSimulationCount(simulations);
  if (draws.length === 0) throw new Error('空数据不能进行随机性研究');
  const sequence = packAnalysisDraws(draws);
  const segments = defineResearchSegments(draws);
  const findings = segments.flatMap((segment) => {
    const statistics = calculateSequenceStatistics(sequence, segment);
    return TEST_DEFINITIONS.map((definition, index) => {
      const skippedReason = definition.sequential && (segment.sequenceProblems.length > 0 || segment.end - segment.start < 2)
        ? '有缺期/疑似年末缺期或少于两期，跳过依赖连续序列的检验' : null;
      return { segment: segment.name, sampleCount: segment.end - segment.start, firstIssue: segment.firstIssue,
        lastIssue: segment.lastIssue, test: definition.id, definition: definition.definition,
        direction: 'upper-tail：距离/平方越大越偏离；p为模拟量≥观测量的概率',
        skippedReason, observedStatistic: skippedReason ? null : statistics.values[index],
        observedCounts: skippedReason ? null : statistics.observed[index],
        expectedCounts: segment.expected[index] ?? (index === 8 ? [0] : [(segment.end - segment.start - 1) / 16]),
        exceedances: 0, nullMean: 0, nullM2: 0, nullMinimum: Infinity, nullMaximum: -Infinity,
        nullStandardDeviation: null as number | null, standardizedEffect: null as number | null,
        effectDefinition: '(observedStatistic−MC零均值)/MC零标准差；描述偏离程度，不是预测收益',
        monteCarloP: null as number | null, monteCarloStandardError: null as number | null,
        adjustedP: null as number | null, rejectedAtFdr05: false,
      };
    });
  });
  const random = createResearchRandom(seed);
  for (let run = 1; run <= simulations; run++) {
    fillFairSequence(sequence, random);
    segments.forEach((segment, segmentIndex) => {
      const statistics = calculateSequenceStatistics(sequence, segment);
      statistics.values.forEach((value, index) => {
        const finding = findings[segmentIndex * TEST_DEFINITIONS.length + index];
        if (finding.skippedReason !== null) return;
        if (value >= finding.observedStatistic!) finding.exceedances++;
        const difference = value - finding.nullMean;
        finding.nullMean += difference / run;
        finding.nullM2 += difference * (value - finding.nullMean);
        finding.nullMinimum = Math.min(finding.nullMinimum, value); finding.nullMaximum = Math.max(finding.nullMaximum, value);
      });
    });
    if (run % 1000 === 0 || run === simulations) onProgress?.(run);
  }
  const active = findings.filter((finding) => finding.skippedReason === null);
  const corrected = benjaminiHochberg(active.map((finding) => monteCarloP(finding.exceedances, simulations)));
  active.forEach((finding, index) => {
    finding.monteCarloP = monteCarloP(finding.exceedances, simulations);
    finding.monteCarloStandardError = Math.sqrt(finding.monteCarloP * (1 - finding.monteCarloP) / simulations);
    finding.adjustedP = corrected[index]; finding.rejectedAtFdr05 = corrected[index] <= 0.05;
    finding.nullStandardDeviation = simulations > 1 ? Math.sqrt(finding.nullM2 / (simulations - 1)) : null;
    finding.standardizedEffect = finding.nullStandardDeviation ? (finding.observedStatistic! - finding.nullMean) / finding.nullStandardDeviation : null;
  });
  return { simulations, seed, familySize: active.length, predefinedCount: findings.length, fdr: 0.05,
    monteCarloStandardErrorDefinition: 'sqrt(pPlusOne*(1−pPlusOne)/runs)，近似二项MC标准误；不涵盖数据偏差或多重校正不确定性',
    segments: segments.map(({ expected: _expected, ...segment }) => segment),
    // 跳过项保留在报告但不伪造p；其非有限零分布边界改为null。
    findings: findings.map(({ nullM2: _m2, ...finding }) => ({ ...finding,
      nullMinimum: Number.isFinite(finding.nullMinimum) ? finding.nullMinimum : null,
      nullMaximum: Number.isFinite(finding.nullMaximum) ? finding.nullMaximum : null })),
    rejectionCount: active.filter((finding) => finding.rejectedAtFdr05).length,
  };
}