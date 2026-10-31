/** 公共 API 仓储：仅 SELECT 与白名单序列化，不加载连接配置，不读取报告文件。 */
import type { SqliteDatabase } from './connection';
import type { DrawRecord, PrizeGradeDetail } from '../domain/lottery';
import type { RecommendationRecord } from '../recommend/recommendationTypes';
import type { BacktestReport } from '../backtest/backtestTypes';
import { findRecommendationById } from './recommendationRepository';
import { assertRecommendationContentHash } from '../recommend/recommendationHash';

export type PublicDraw = Pick<DrawRecord, 'issue' | 'drawDate' | 'redBalls' | 'blueBall'
  | 'salesAmountYuan' | 'prizePoolAmountYuan' | 'prizeGrades' | 'isPrizeDetailComplete'>;

interface PublicDrawRow {
  issue: string; drawDate: string; red_ball_1: number; red_ball_2: number; red_ball_3: number;
  red_ball_4: number; red_ball_5: number; red_ball_6: number; blueBall: number;
  salesAmountYuan: number | null; prizePoolAmountYuan: number | null;
  prizeGradesJson: string | null; isPrizeDetailComplete: number;
}

// 连原始 HTML/JSON、抓取时间及来源字符串都不读，避免内部字段混入公共响应。
const PUBLIC_DRAW_COLUMNS = `issue, draw_date AS drawDate,
  red_ball_1, red_ball_2, red_ball_3, red_ball_4, red_ball_5, red_ball_6, blue_ball AS blueBall,
  sales_amount_yuan AS salesAmountYuan, prize_pool_amount_yuan AS prizePoolAmountYuan,
  prize_grades_json AS prizeGradesJson, is_prize_detail_complete AS isPrizeDetailComplete`;

function publicDraw(row: PublicDrawRow): PublicDraw {
  const grades = JSON.parse(row.prizeGradesJson ?? '[]') as PrizeGradeDetail[];
  return {
    issue: row.issue, drawDate: row.drawDate,
    redBalls: [row.red_ball_1, row.red_ball_2, row.red_ball_3, row.red_ball_4, row.red_ball_5, row.red_ball_6],
    blueBall: row.blueBall, salesAmountYuan: row.salesAmountYuan, prizePoolAmountYuan: row.prizePoolAmountYuan,
    prizeGrades: grades.map(grade => ({ grade: grade.grade, winningTicketCount: grade.winningTicketCount,
      prizePerTicketYuan: grade.prizePerTicketYuan })),
    isPrizeDetailComplete: row.isPrizeDetailComplete === 1,
  };
}

export function listPublicDraws(database: SqliteDatabase, limit: number, beforeIssue: string | null): PublicDraw[] {
  const rows = database.prepare(`SELECT ${PUBLIC_DRAW_COLUMNS} FROM draws
    WHERE (? IS NULL OR issue < ?) ORDER BY issue DESC LIMIT ?`).all(beforeIssue, beforeIssue, limit) as PublicDrawRow[];
  return rows.map(publicDraw);
}

export function findPublicDraw(database: SqliteDatabase, issue: string): PublicDraw | null {
  const row = database.prepare(`SELECT ${PUBLIC_DRAW_COLUMNS} FROM draws WHERE issue = ?`).get(issue) as
    PublicDrawRow | undefined;
  return row === undefined ? null : publicDraw(row);
}

/** 在全部已收录开奖中查六红全中的期：蓝球也中为一等奖，否则二等奖；同一读快照给出覆盖范围。 */
export function findHistoryTopPrizeMatches(database: SqliteDatabase, ticket: { redBalls: readonly number[]; blueBall: number }) {
  return database.transaction(() => {
    const coverage = database.prepare(`SELECT COUNT(*) AS drawCount, MIN(issue) AS firstIssue, MAX(issue) AS lastIssue
      FROM draws`).get() as { drawCount: number; firstIssue: string | null; lastIssue: string | null };
    // 表约束保证红球升序入库，入参已排序，按列精确匹配。
    const rows = database.prepare(`SELECT ${PUBLIC_DRAW_COLUMNS} FROM draws WHERE red_ball_1 = ? AND red_ball_2 = ?
      AND red_ball_3 = ? AND red_ball_4 = ? AND red_ball_5 = ? AND red_ball_6 = ? ORDER BY issue DESC`)
      .all(...ticket.redBalls) as PublicDrawRow[];
    const matches = rows.map(publicDraw).map(draw => ({ issue: draw.issue, drawDate: draw.drawDate,
      redBalls: draw.redBalls, blueBall: draw.blueBall, grade: draw.blueBall === ticket.blueBall ? 1 : 2 }));
    return { coverage, matches };
  })();
}

/** 读推荐同样校验固化哈希；种子、时间、参数和号码均为公开审计内容，不是管理密钥。 */
export function publicRecommendation(record: RecommendationRecord): RecommendationRecord {
  assertRecommendationContentHash(record);
  return {
    id: record.id, targetIssue: record.targetIssue, targetDrawDate: record.targetDrawDate,
    generationDeadline: record.generationDeadline, sourceLatestIssue: record.sourceLatestIssue,
    strategyName: record.strategyName, strategyVersion: record.strategyVersion,
    strategyParams: record.strategyParams, seed: record.seed,
    tickets: record.tickets.map(ticket => ({ redBalls: [...ticket.redBalls], blueBall: ticket.blueBall })),
    contentHash: record.contentHash, generatedAt: record.generatedAt,
  };
}

export function listPublicRecommendations(database: SqliteDatabase, limit: number, beforeId: number | null): RecommendationRecord[] {
  const ids = database.prepare(`SELECT id FROM recommendations
    WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`).all(beforeId, beforeId, limit) as Array<{ id: number }>;
  return ids.map(({ id }) => {
    const record = findRecommendationById(database, id);
    if (record === null) throw new Error('推荐读取期间记录缺失');
    return publicRecommendation(record);
  });
}

interface PublicBacktestRow {
  id: number; strategyName: string; strategyVersion: string; seed: string; ticketsPerIssue: number;
  evaluationStartIssue: string; evaluationEndIssue: string; usesFinalHoldout: number;
  status: 'running' | 'succeeded' | 'failed'; summaryJson: string | null;
  startedAt: string; finishedAt: string | null;
}

/** 只公开已保存的聚合字段，既不展开逐期/逐重复明细，也不把失败信息或路径透传出去。 */
function publicBacktestSummary(summaryJson: string | null) {
  if (summaryJson === null) return null;
  const saved = JSON.parse(summaryJson) as Partial<BacktestReport>;
  return {
    definitionVersion: saved.definitionVersion ?? null, dataFingerprint: saved.dataFingerprint ?? null,
    coverage: saved.coverage ?? null, payoutAudit: saved.payoutAudit ?? null,
    distributions: saved.distributions ?? null, calibration: saved.calibration ?? null,
    formalRoiAvailable: false,
  };
}

export function listPublicBacktests(database: SqliteDatabase, limit: number, beforeId: number | null) {
  const rows = database.prepare(`SELECT id, strategy_name AS strategyName, strategy_version AS strategyVersion,
    random_seed AS seed, tickets_per_issue AS ticketsPerIssue, evaluation_start_issue AS evaluationStartIssue,
    evaluation_end_issue AS evaluationEndIssue, uses_final_holdout AS usesFinalHoldout,
    run_status AS status, metrics_summary_json AS summaryJson, started_at AS startedAt, finished_at AS finishedAt
    FROM backtest_runs WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`).all(beforeId, beforeId, limit) as PublicBacktestRow[];
  return rows.map(row => ({
    id: row.id, strategyName: row.strategyName, strategyVersion: row.strategyVersion, seed: row.seed,
    ticketsPerIssue: row.ticketsPerIssue, evaluationStartIssue: row.evaluationStartIssue,
    evaluationEndIssue: row.evaluationEndIssue, usesFinalHoldout: row.usesFinalHoldout === 1,
    status: row.status, summary: publicBacktestSummary(row.summaryJson), startedAt: row.startedAt, finishedAt: row.finishedAt,
  }));
}