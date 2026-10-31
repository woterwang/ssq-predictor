/** 推荐固化边界：旧行的新增元数据为 null，不把旧记录冒充可审计推荐。 */
import type { DrawPayoutPolicy, LotteryTicket, PrizeGrade } from '../backtest/backtestTypes';

export interface RecommendationContent {
  targetIssue: string;
  targetDrawDate: string | null;
  /** 当期开奖日北京时间20:00：保守推荐生成截止，非已核实的官方销售停售时间。 */
  generationDeadline: string | null;
  sourceLatestIssue: string | null;
  strategyName: string;
  strategyVersion: string;
  strategyParams: Record<string, unknown>;
  seed: number;
  tickets: readonly LotteryTicket[];
  generatedAt: string;
}

export interface RecommendationRecord extends RecommendationContent {
  id: number;
  contentHash: string;
}

export interface RecommendationOptions {
  ticketsPerIssue?: number;
  seed?: number;
}

export interface RecommendationVerificationResult {
  definitionVersion: string;
  recommendationContentHash: string;
  targetIssue: string;
  targetDrawDate: string;
  outcomes: Array<{ redHits: number; blueHit: boolean; grade: PrizeGrade; prizeYuan: number | null }>;
  /** 常规六奖级及已核实窗口的福运奖；活动未核实不等于没有中奖。 */
  prizeCounts: Record<string, number>;
  totalRedHits: number;
  blueHitCount: number;
  costYuan: number;
  payoutAudit: DrawPayoutPolicy;
  /** 仅审计通过时回放公告税前奖金，不模拟浮动奖稀释/税收/实际兑奖。 */
  announcedPrizeReplayYuan: number | null;
  formalRoi: null;
  limitations: string[];
}

export interface RecommendationVerificationRecord {
  id: number;
  recommendationId: number;
  drawFingerprint: string;
  result: RecommendationVerificationResult;
  verifiedAt: string;
}

export interface VerifyPendingRecommendationsResult {
  /** 本次新增核验版本数，不含已有相同指纹版本。 */
  verifiedCount: number;
  pendingCount: number;
  unchangedCount: number;
  skippedCount: number;
  skipped: Array<{ recommendationId: number; reason: string }>;
  verifications: RecommendationVerificationRecord[];
}

export interface RecommendationVerificationView {
  recommendation: RecommendationRecord;
  /** 与当前库中开奖/奖金指纹匹配的核验；修正后尚未核验返回null，不能误展示旧版。 */
  latest: RecommendationVerificationRecord | null;
  /** 最新追加版本在前。 */
  versions: RecommendationVerificationRecord[];
}