/**
 * 开奖记录数据访问
 *
 * 只负责数据库读写与行/对象转换，不包含“是否覆盖”等业务判断（见 drawImportService）。
 * 所有 SQL 均使用参数绑定，杜绝 SQL 注入。
 */
import type { DrawRecord, PrizeGradeDetail, StoredDrawRecord } from '../domain/lottery';
import type { SqliteDatabase } from './connection';

/** draws 表的一行（列名与数据库一致） */
interface DrawRow {
  issue: string;
  draw_date: string;
  red_ball_1: number;
  red_ball_2: number;
  red_ball_3: number;
  red_ball_4: number;
  red_ball_5: number;
  red_ball_6: number;
  blue_ball: number;
  sales_amount_yuan: number | null;
  prize_pool_amount_yuan: number | null;
  first_prize_region_text: string | null;
  prize_grades_json: string | null;
  is_prize_detail_complete: 0 | 1;
  data_source: string;
  fetched_at: string;
  updated_at: string;
  raw_record_json: string | null;
}

/** 查询 draws 全部列时使用的列清单 */
const DRAW_COLUMNS = `
  issue, draw_date,
  red_ball_1, red_ball_2, red_ball_3, red_ball_4, red_ball_5, red_ball_6, blue_ball,
  sales_amount_yuan, prize_pool_amount_yuan, first_prize_region_text,
  prize_grades_json, is_prize_detail_complete, data_source, fetched_at, updated_at, raw_record_json
`;

/**
 * 数据库行 → 领域对象。
 */
function mapDrawRowToRecord(row: DrawRow): StoredDrawRecord {
  return {
    issue: row.issue,
    drawDate: row.draw_date,
    redBalls: [row.red_ball_1, row.red_ball_2, row.red_ball_3, row.red_ball_4, row.red_ball_5, row.red_ball_6],
    blueBall: row.blue_ball,
    salesAmountYuan: row.sales_amount_yuan,
    prizePoolAmountYuan: row.prize_pool_amount_yuan,
    firstPrizeRegionText: row.first_prize_region_text,
    prizeGrades: row.prize_grades_json === null ? [] : (JSON.parse(row.prize_grades_json) as PrizeGradeDetail[]),
    isPrizeDetailComplete: row.is_prize_detail_complete === 1,
    dataSource: row.data_source,
    rawRecordJson: row.raw_record_json ?? '{}',
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 按期号查询开奖记录；不存在时返回 null。
 */
export function findDrawByIssue(database: SqliteDatabase, issue: string): StoredDrawRecord | null {
  const row = database.prepare(`SELECT ${DRAW_COLUMNS} FROM draws WHERE issue = ?`).get(issue) as
    | DrawRow
    | undefined;
  return row === undefined ? null : mapDrawRowToRecord(row);
}

/**
 * 新增一期开奖记录。fetched_at 与 updated_at 都记为当前时间。
 */
export function insertDraw(database: SqliteDatabase, draw: DrawRecord, currentTimestamp: string): void {
  database
    .prepare(
      `INSERT INTO draws (
         issue, draw_date,
         red_ball_1, red_ball_2, red_ball_3, red_ball_4, red_ball_5, red_ball_6, blue_ball,
         sales_amount_yuan, prize_pool_amount_yuan, first_prize_region_text,
         prize_grades_json, is_prize_detail_complete, data_source, fetched_at, updated_at, raw_record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draw.issue,
      draw.drawDate,
      ...draw.redBalls,
      draw.blueBall,
      draw.salesAmountYuan,
      draw.prizePoolAmountYuan,
      draw.firstPrizeRegionText,
      JSON.stringify(draw.prizeGrades),
      draw.isPrizeDetailComplete ? 1 : 0,
      draw.dataSource,
      currentTimestamp,
      currentTimestamp,
      draw.rawRecordJson,
    );
}

/**
 * 更新已有记录的销售、奖池与奖级明细（开奖号码与日期不更新）。
 */
export function updateDrawPrizeDetail(database: SqliteDatabase, draw: DrawRecord, currentTimestamp: string): void {
  database
    .prepare(
      `UPDATE draws SET
         sales_amount_yuan = ?,
         prize_pool_amount_yuan = ?,
         first_prize_region_text = ?,
         prize_grades_json = ?,
         is_prize_detail_complete = ?,
         raw_record_json = ?,
         updated_at = ?
       WHERE issue = ?`,
    )
    .run(
      draw.salesAmountYuan,
      draw.prizePoolAmountYuan,
      draw.firstPrizeRegionText,
      JSON.stringify(draw.prizeGrades),
      draw.isPrizeDetailComplete ? 1 : 0,
      draw.rawRecordJson,
      currentTimestamp,
      draw.issue,
    );
}

/**
 * 查询全部期号与开奖日期（按期号升序），供序列校验使用。
 */
export function listAllDrawIssueAndDates(database: SqliteDatabase): Array<{ issue: string; drawDate: string }> {
  return database
    .prepare(`SELECT issue, draw_date AS drawDate FROM draws ORDER BY issue`)
    .all() as Array<{ issue: string; drawDate: string }>;
}

/**
 * 查询最近若干期开奖记录（按期号倒序）。
 */
export function listLatestDraws(database: SqliteDatabase, limit: number): StoredDrawRecord[] {
  const rows = database
    .prepare(`SELECT ${DRAW_COLUMNS} FROM draws ORDER BY issue DESC LIMIT ?`)
    .all(limit) as DrawRow[];
  return rows.map(mapDrawRowToRecord);
}

/**
 * 查询库内最新一期；库为空时返回 null。
 */
export function findLatestDraw(database: SqliteDatabase): StoredDrawRecord | null {
  return listLatestDraws(database, 1)[0] ?? null;
}

/**
 * 查询奖级明细尚未完整的期号（按期号升序）。
 */
export function listIssuesWithIncompletePrizeDetail(database: SqliteDatabase): string[] {
  const rows = database
    .prepare(`SELECT issue FROM draws WHERE is_prize_detail_complete = 0 ORDER BY issue`)
    .all() as Array<{ issue: string }>;
  return rows.map((row) => row.issue);
}

/**
 * 统计开奖记录总数。
 */
export function countDraws(database: SqliteDatabase): number {
  const row = database.prepare(`SELECT COUNT(*) AS drawCount FROM draws`).get() as { drawCount: number };
  return row.drawCount;
}
