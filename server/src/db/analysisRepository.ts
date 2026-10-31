/** 统计快照查询：一次 SELECT 读取截止期号之前的轻量字段，保证本次计算使用同一份数据。 */
import type { AnalysisDraw } from '../analysis/analysisTypes';
import type { SqliteDatabase } from './connection';
import type { PrizeGradeDetail } from '../domain/lottery';

/** 热度研究额外读取销售与奖级，但不加载原始响应和奖金地区等巨大文本。 */
export interface ResearchDraw extends AnalysisDraw {
  salesAmountYuan: number | null;
  prizeGrades: PrizeGradeDetail[];
}

export function readResearchSnapshot(database: SqliteDatabase): ResearchDraw[] {
  const rows = database.prepare(`
    SELECT issue, draw_date AS drawDate,
      red_ball_1, red_ball_2, red_ball_3, red_ball_4, red_ball_5, red_ball_6,
      blue_ball AS blueBall, sales_amount_yuan AS salesAmountYuan, prize_grades_json AS prizeGradesJson
    FROM draws ORDER BY issue
  `).all() as Array<AnalysisDrawRow & { salesAmountYuan: number | null; prizeGradesJson: string | null }>;
  return rows.map((row) => ({
    issue: row.issue, drawDate: row.drawDate,
    redBalls: [row.red_ball_1, row.red_ball_2, row.red_ball_3, row.red_ball_4, row.red_ball_5, row.red_ball_6],
    blueBall: row.blueBall, salesAmountYuan: row.salesAmountYuan,
    prizeGrades: row.prizeGradesJson === null ? [] : JSON.parse(row.prizeGradesJson) as PrizeGradeDetail[],
  }));
}

interface AnalysisDrawRow {
  issue: string;
  drawDate: string;
  red_ball_1: number;
  red_ball_2: number;
  red_ball_3: number;
  red_ball_4: number;
  red_ball_5: number;
  red_ball_6: number;
  blueBall: number;
}

export function readAnalysisSnapshot(database: SqliteDatabase, asOfIssue: string | null): AnalysisDraw[] {
  const rows = database.prepare(`
    SELECT issue, draw_date AS drawDate,
      red_ball_1, red_ball_2, red_ball_3, red_ball_4, red_ball_5, red_ball_6,
      blue_ball AS blueBall
    FROM draws WHERE (? IS NULL OR issue <= ?) ORDER BY issue
  `).all(asOfIssue, asOfIssue) as AnalysisDrawRow[];
  return rows.map((row) => ({
    issue: row.issue,
    drawDate: row.drawDate,
    redBalls: [row.red_ball_1, row.red_ball_2, row.red_ball_3, row.red_ball_4, row.red_ball_5, row.red_ball_6],
    blueBall: row.blueBall,
  }));
}