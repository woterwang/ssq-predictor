/** 白名单公众响应类型，与服务端API对齐；不引用服务端数据库/Node模块。 */
export interface Ticket { redBalls: number[]; blueBall: number }
export interface PublicDraw extends Ticket {
  issue: string;
  drawDate: string;
  salesAmountYuan: number | null;
  prizePoolAmountYuan: number | null;
  prizeGrades: Array<{ grade: number; winningTicketCount: number | null; prizePerTicketYuan: number | null }>;
  isPrizeDetailComplete: boolean;
}
export interface Recommendation {
  id: number;
  targetIssue: string;
  targetDrawDate: string | null;
  generationDeadline: string | null;
  sourceLatestIssue: string | null;
  strategyName: string;
  strategyVersion: string;
  strategyParams: Record<string, unknown>;
  seed: number;
  tickets: Ticket[];
  contentHash: string;
  generatedAt: string;
}
export interface NextRecommendation {
  status: 'not_generated' | 'available' | 'closed' | 'awaiting_draw';
  reason: string | null;
  nextDraw: { issue: string; drawDate: string; drawTimeBeijing: string } | null;
  generationDeadline: string | null;
  sourceLatestIssue: string | null;
  recommendation: Recommendation | null;
}
export type PrizeGrade = 1 | 2 | 3 | 4 | 5 | 6 | 'fortune' | 'none';
export interface VerificationRecord {
  id: number;
  recommendationId: number;
  drawFingerprint: string;
  verifiedAt: string;
  result: {
    definitionVersion: string;
    recommendationContentHash: string;
    targetIssue: string;
    targetDrawDate: string;
    outcomes: Array<{ redHits: number; blueHit: boolean; grade: PrizeGrade; prizeYuan: number | null }>;
    payoutAudit: { fortuneActive: boolean; eligible: boolean; withheldReasons: string[] };
    announcedPrizeReplayYuan: number | null;
    formalRoi: null;
    limitations: string[];
  };
}
export interface VerificationView {
  recommendation: Recommendation;
  latest: VerificationRecord | null;
  versions: VerificationRecord[];
}
export interface Envelope<T> {
  data: T;
  pagination?: { nextBeforeIssue?: string | null; nextBeforeId?: number | null; limit: number };
}

export type AnalysisWindow = 'all' | '30' | '100' | '300';
export type HeatLabel = 'cold' | 'normal' | 'hot' | 'unavailable';
export interface NumberStatistics {
  number: number;
  appearanceCount: number;
  appearanceRate: number | null;
  theoreticalAppearanceRate: number;
  expectedAppearanceCount: number;
  currentOmission: number;
  currentOmissionIsLowerBound: boolean;
  maximumObservedOmission: number;
  maximumCompleteOmission: number | null;
  averageCompleteOmission: number | null;
  heatLabel: HeatLabel;
  lastAppearanceIssue: string | null;
}
/** 走势只用到的组合特征；不读取featureDistributions等页面未展示字段。 */
export interface DrawFeatures {
  issue: string;
  drawDate: string;
  redSum: number;
  redSpan: number;
  redOddCount: number;
  acValue: number;
  repeatedRedCount: number | null;
  blueBall: number;
  blueAmplitude: number | null;
}
export interface AnalysisReport {
  definitionVersion: string;
  requestedWindow: number | null;
  requestedAsOfIssue: string | null;
  sampleDrawCount: number;
  firstIssue: string | null;
  lastIssue: string | null;
  generatedAt: string;
  dataFingerprint: string;
  warnings: string[];
  redNumbers: NumberStatistics[];
  blueNumbers: NumberStatistics[];
  features: DrawFeatures[];
}

export interface MetricDistribution {
  mean: number;
  median?: number;
  minimum?: number;
  maximum?: number;
  standardDeviation: number;
  outcomeInterval95: [number, number];
  monteCarloMeanInterval95: [number, number] | null;
}
export interface BacktestRun {
  id: number;
  strategyName: string;
  strategyVersion: string;
  seed: string;
  ticketsPerIssue: number;
  evaluationStartIssue: string;
  evaluationEndIssue: string;
  usesFinalHoldout: boolean;
  status: 'running' | 'succeeded' | 'failed';
  summary: {
    definitionVersion: string | null;
    dataFingerprint: string | null;
    coverage: { trainingFirstIssue: string; evaluationFirstIssue: string; evaluationLastIssue: string; evaluatedIssues: number } | null;
    payoutAudit: { eligibleIssues: number; withheldIssues: unknown[] } | null;
    distributions: Record<string, MetricDistribution> | null;
    calibration: { theoreticalAverageRedHits: number; theoreticalBlueHitRate: number; firstRunRedTailP: number | null; firstRunBlueTailP: number | null } | null;
    formalRoiAvailable: false;
  } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TicketFeatures {
  redSum: number;
  redSpan: number;
  redOddCount: number;
  redEvenCount: number;
  redSmallCount: number;
  redLargeCount: number;
  redZoneCounts: number[];
  consecutiveGroupCount: number;
  consecutivePairCount: number;
  redTailCounts: number[];
  acValue: number;
  blueBall: number;
  blueIsOdd: boolean;
  blueSize: 'small' | 'large';
}
export interface TicketCheckResult {
  ticket: Ticket;
  features: TicketFeatures;
  theoretical: { jackpotProbability: number; jackpotOdds: string; totalSingleTickets: number };
  disclaimers: string[];
}