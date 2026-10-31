/** 推荐成绩汇总：只读；每条推荐只采用与当前开奖指纹匹配的核验版本，空样本返回 null 而不是 0。 */
import type { PrizeGrade } from '../backtest/backtestTypes';
import type { SqliteDatabase } from '../db/connection';
import { listRecommendations } from '../db/recommendationRepository';
import { getRecommendationVerification } from './recommendationService';

const GRADES: readonly PrizeGrade[] = [1, 2, 3, 4, 5, 6, 'fortune', 'none'];

export interface RecommendationPerformanceSummary {
  definitionVersion: 'recommendation-summary-v1';
  recommendationCount: number;
  /** 已核验 / 目标开奖未入库 / 开奖已入库但当前指纹尚无核验（含修正后待重核与未通过核验条件）。 */
  issues: { verified: number; awaitingDraw: number; awaitingVerification: number };
  tickets: {
    verifiedTicketCount: number;
    totalRedHits: number;
    averageRedHits: number | null;
    blueHitCount: number;
    blueHitRate: number | null;
    /** 下标为红球命中数0–6。 */
    redHitDistribution: number[];
    prizeCounts: Record<string, number>;
  };
  /** 单注随机理论值：红球期望命中 6×6/33，蓝球命中率 1/16。 */
  theoretical: { averageRedHits: number; blueHitRate: number };
  /** 仅奖金审计通过期的公告税前回放；其他期整期暂停核算，不按命中挑样本。 */
  payout: { accountedIssueCount: number; withheldIssueCount: number;
    accountedCostYuan: number; announcedPrizeReplayYuan: number; formalRoi: null };
  limitations: string[];
}

export function summarizeRecommendationPerformance(database: SqliteDatabase): RecommendationPerformanceSummary {
  // 延迟读事务保证一次快照，不写库。
  return database.transaction(() => {
    const issues = { verified: 0, awaitingDraw: 0, awaitingVerification: 0 };
    const redHitDistribution = [0, 0, 0, 0, 0, 0, 0];
    const prizeCounts: Record<string, number> = Object.fromEntries(GRADES.map(grade => [String(grade), 0]));
    const payout = { accountedIssueCount: 0, withheldIssueCount: 0, accountedCostYuan: 0, announcedPrizeReplayYuan: 0 };
    let ticketCount = 0, totalRedHits = 0, blueHitCount = 0;
    const records = listRecommendations(database);
    for (const record of records) {
      const view = getRecommendationVerification(database, record.id)!;
      if (view.latest === null) {
        const hasDraw = database.prepare('SELECT 1 FROM draws WHERE issue = ?').get(record.targetIssue) !== undefined;
        if (hasDraw) issues.awaitingVerification++;
        else issues.awaitingDraw++;
        continue;
      }
      issues.verified++;
      const result = view.latest.result;
      for (const outcome of result.outcomes) {
        ticketCount++;
        totalRedHits += outcome.redHits;
        if (outcome.blueHit) blueHitCount++;
        redHitDistribution[outcome.redHits]++;
        prizeCounts[String(outcome.grade)]++;
      }
      if (result.payoutAudit.eligible && result.announcedPrizeReplayYuan !== null) {
        payout.accountedIssueCount++;
        payout.accountedCostYuan += result.costYuan;
        payout.announcedPrizeReplayYuan += result.announcedPrizeReplayYuan;
      } else {
        payout.withheldIssueCount++;
      }
    }
    return {
      definitionVersion: 'recommendation-summary-v1' as const,
      recommendationCount: records.length,
      issues,
      tickets: { verifiedTicketCount: ticketCount, totalRedHits,
        averageRedHits: ticketCount === 0 ? null : totalRedHits / ticketCount,
        blueHitCount, blueHitRate: ticketCount === 0 ? null : blueHitCount / ticketCount,
        redHitDistribution, prizeCounts },
      theoretical: { averageRedHits: 36 / 33, blueHitRate: 1 / 16 },
      payout: { ...payout, formalRoi: null },
      limitations: ['M0为均匀随机基线，样本内偏离理论值属随机波动，不代表预测能力',
        '公告奖金仅税前回放，未模拟奖池稀释、税收及实际兑奖；正式ROI不提供',
        '开奖修正后需重新核验，期间该期计入待核验而非沿用旧结果'],
    };
  })();
}
