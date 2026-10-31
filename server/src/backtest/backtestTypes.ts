/** 回测边界类型：模型只能接收号码历史，奖金与目标开奖号不进入预测接口。 */
import type { AnalysisDraw } from '../analysis/analysisTypes';
import type { DrawRecord } from '../domain/lottery';
import type { createResearchRandom } from '../analysis/researchRandom';

export interface LotteryTicket {
  readonly redBalls: readonly number[];
  readonly blueBall: number;
}

export interface ModelPrediction {
  /** 红球逐号“本期开出”的边际概率，共33项，和为6；不是抽样权重。 */
  readonly redProbabilities: readonly number[];
  /** 蓝球分类概率，共16项，和为1。 */
  readonly blueProbabilities: readonly number[];
  readonly tickets: readonly LotteryTicket[];
}

export interface PredictionContext {
  readonly targetIssue: string;
  /** 严格小于目标期；递归冻结，且没有销售/奖金/原始记录字段。 */
  readonly history: readonly AnalysisDraw[];
  readonly ticketsPerIssue: number;
  readonly random: ReturnType<typeof createResearchRandom>;
}

export interface BacktestStrategy {
  name: string;
  version: string;
  parameters: Record<string, unknown>;
  /** 每个重复独立创建模型，防止状态串入另一个重复。模型不应另行访问DB。 */
  createPredictor: () => (context: PredictionContext) => ModelPrediction;
}

export interface BacktestOptions {
  startIssue: string;
  endIssue: string;
  ticketsPerIssue: number;
  repetitions: number;
  seed: number;
  minimumHistory: number;
}

export type PrizeGrade = 1 | 2 | 3 | 4 | 5 | 6 | 'fortune' | 'none';

export interface DrawPayoutPolicy {
  fortuneActive: boolean;
  /** 未核实活动资格/缺失奖金时整期暂停收益，避免按命中结果选择核算样本。 */
  eligible: boolean;
  withheldReasons: string[];
  amounts: Partial<Record<PrizeGrade, number>>;
}

export interface ScoreMetrics {
  redLogLoss: number;
  redBrierScore: number;
  blueLogLoss: number;
  blueBrierScore: number;
}

export interface RepetitionMetrics extends ScoreMetrics {
  repetition: number;
  seed: number;
  evaluatedIssues: number;
  totalTickets: number;
  averageRedHits: number;
  blueHitRate: number;
  /** 全区间规则命中数，与收益是否核算独立。 */
  prizeCounts: Record<PrizeGrade, number>;
  /** 只统计奖金审计通过的期，便于解释已核算收益。 */
  accountedPrizeCounts: Record<PrizeGrade, number>;
  totalCostYuan: number;
  accountedCostYuan: number;
  accountedPrizeYuan: number;
  /** 仅已核算子集的税前、固定公告金额回放，不能冒充全区间正式ROI。 */
  accountedSubsetRoi: number | null;
  /** 浮动奖金按历史公告回放，不模拟新增投注改变奖池；不包含未核实特别奖。 */
  ordinaryReplayRoi: number | null;
  /** 未掌握全部历史活动资格、税收及兑奖情形，正式全收益ROI始终不提供。 */
  formalRoi: null;
  maximumDrawdownYuan: number | null;
}

export interface PeriodDetail extends ScoreMetrics {
  issue: string;
  historyCount: number;
  historyEndIssue: string | null;
  predictionHash: string;
  prediction: ModelPrediction;
  actual: LotteryTicket;
  outcomes: Array<{ redHits: number; blueHit: boolean; grade: PrizeGrade; prizeYuan: number | null }>;
  costYuan: number;
  prizeYuan: number | null;
}

export interface MetricDistribution {
  mean: number;
  median: number;
  minimum: number;
  maximum: number;
  standardDeviation: number;
  /** 跨整段重复的2.5%/97.5%分位点：随机结果区间，不是均值置信区间。 */
  outcomeInterval95: [number, number];
  /** 多次独立随机运行均值的近似正态MC区间；不代表模型优势置信区间。 */
  monteCarloMeanInterval95: [number, number] | null;
}

export interface BacktestReport {
  definitionVersion: string;
  strategy: { name: string; version: string; parameters: Record<string, unknown> };
  options: BacktestOptions;
  randomAlgorithm: string;
  dataFingerprint: string;
  coverage: { trainingFirstIssue: string; evaluationFirstIssue: string; evaluationLastIssue: string; evaluatedIssues: number };
  payoutAudit: { eligibleIssues: number; withheldIssues: Array<{ issue: string; reasons: string[] }> };
  repetitions: RepetitionMetrics[];
  distributions: Record<string, MetricDistribution>;
  calibration: {
    theoreticalAverageRedHits: number;
    theoreticalBlueHitRate: number;
    /** 首次重复相对于其余M0重复的双侧MC尾概率，只检验抽样框架，非策略优越性。 */
    firstRunRedTailP: number | null;
    firstRunBlueTailP: number | null;
  };
  /** 只保留第一重复的逐期审计；所有重复的汇总均保留，禁止择优报告。 */
  firstRepetitionDetails: PeriodDetail[];
  limitations: string[];
}

export type BacktestDraw = Pick<DrawRecord, 'issue' | 'drawDate' | 'redBalls' | 'blueBall' | 'prizeGrades' | 'rawRecordJson'>;