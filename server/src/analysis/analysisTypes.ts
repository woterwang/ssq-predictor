/** 统计只需要开奖日期和号码，不读取奖金、原始响应等无关大字段。 */
export interface AnalysisDraw {
  issue: string;
  drawDate: string;
  redBalls: readonly number[];
  blueBall: number;
}

export interface AnalysisQuery {
  /** null 或未设置表示当前已存的全部历史；否则取最近 N 期。 */
  window?: number | null;
  /** 包含该期，只读取期号 <= 此值的数据；未设置则截至库内最新一期。 */
  asOfIssue?: string;
}

export interface NumberStatistics {
  number: number;
  appearanceCount: number;
  /** 按期计算，不是该号码占全部红球数量的比例。 */
  appearanceRate: number | null;
  /** 均匀开奖下的单号理论边际概率：红球 6/33，蓝球 1/16。 */
  theoreticalAppearanceRate: number;
  expectedAppearanceCount: number;
  currentOmission: number;
  /** 窗口内未出现过时，真实遗漏可能更长；不把窗口长度当成确切遗漏。 */
  currentOmissionIsLowerBound: boolean;
  /** 包含两端截断区间的“窗口内观测最大遗漏”，不是全历史真实最大值。 */
  maximumObservedOmission: number;
  maximumCompleteOmission: number | null;
  /** 仅使用两次出现之间的完整遗漏；不足两次出现时为 null。 */
  averageCompleteOmission: number | null;
  completeOmissionCount: number;
  /** 完整遗漏长度 -> 次数，不包含窗口两端的截断间隔。 */
  completeOmissionDistribution: Record<string, number>;
  /** 使用同色球频次的 25%/75% 分位点严格划分，并列值不会被强行拆分。 */
  heatLabel: 'cold' | 'normal' | 'hot' | 'unavailable';
  lastAppearanceIssue: string | null;
}

export interface DrawFeatures {
  issue: string;
  drawDate: string;
  redSum: number;
  redSpan: number;
  redOddCount: number;
  redEvenCount: number;
  /** 红球 1–16 为小，17–33 为大，划分不等大须在界面说明。 */
  redSmallCount: number;
  redLargeCount: number;
  /** 1–11、12–22、23–33。 */
  redZoneCounts: readonly number[];
  /** 至少含两个号码的连续段数量，例如 1,2,3 算一组。 */
  consecutiveGroupCount: number;
  /** 相差 1 的相邻对数量，例如 1,2,3 算两对。 */
  consecutivePairCount: number;
  /** 相对库内紧邻上期；没有可比的前一期时为 null。 */
  repeatedRedCount: number | null;
  /** 尾数 0–9 出现次数（号码 % 10），不是个位重复组数。 */
  redTailCounts: readonly number[];
  /** 六球 15 个两两正差的不同值数量减 5。 */
  acValue: number;
  blueBall: number;
  blueIsOdd: boolean;
  /** 蓝球 1–8 为小，9–16 为大。 */
  blueSize: 'small' | 'large';
  /** 与前一期蓝球的绝对差；无前一期时为 null。 */
  blueAmplitude: number | null;
}

export interface BasicAnalysisReport {
  definitionVersion: string;
  requestedWindow: number | null;
  requestedAsOfIssue: string | null;
  sampleDrawCount: number;
  availableDrawCount: number;
  availableFirstIssue: string | null;
  availableLastIssue: string | null;
  firstIssue: string | null;
  lastIssue: string | null;
  generatedAt: string;
  dataFingerprint: string;
  warnings: readonly string[];
  redNumbers: readonly NumberStatistics[];
  blueNumbers: readonly NumberStatistics[];
  /** 按期号升序，直接用于走势图。 */
  features: readonly DrawFeatures[];
  /** 特征值或结构 -> 期数；上期相关的 null 不计入分布。 */
  featureDistributions: Readonly<Record<string, Record<string, number>>>;
}