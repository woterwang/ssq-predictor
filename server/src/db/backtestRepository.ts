/** 回测登记与锁定边界。每次尝试（含失败）保留，不以成功结果选择性登记。 */
import type { SqliteDatabase } from './connection';
import type { BacktestDraw, BacktestOptions, BacktestReport, BacktestStrategy } from '../backtest/backtestTypes';
import { FINAL_HOLDOUT_START_ISSUE, HOLDOUT_POLICY_VERSION } from '../backtest/holdoutPolicy';

export function ensureHoldoutRegistered(database: SqliteDatabase): void {
  database.transaction(() => {
    const existing = database.prepare('SELECT start_issue, policy_version FROM backtest_holdout_policy WHERE id=1').get() as
      { start_issue: string; policy_version: string } | undefined;
    if (existing) {
      if (existing.start_issue !== FINAL_HOLDOUT_START_ISSUE || existing.policy_version !== HOLDOUT_POLICY_VERSION) throw new Error('代码与已登记前瞻政策不一致');
      return;
    }
    const future = database.prepare('SELECT issue FROM draws WHERE issue >= ? LIMIT 1').get(FINAL_HOLDOUT_START_ISSUE);
    if (future) throw new Error('前瞻段数据已入库，不能事后登记为未触碰留出集');
    database.prepare('INSERT INTO backtest_holdout_policy VALUES (1, ?, ?, ?, ?)').run(
      HOLDOUT_POLICY_VERSION, FINAL_HOLDOUT_START_ISSUE, new Date().toISOString(),
      '20261031已查看截至2026124的历史，2026125起尚未开奖；本批锁定不评估，最终策略与评估长度另行预登记',
    );
  }).immediate();
}

/** 单SELECT形成一致快照，SQL排除锁定区间；不经listLatestDraws把未来数据先读进来。 */
export function readBacktestDraws(database: SqliteDatabase, endIssue: string): BacktestDraw[] {
  if (endIssue >= FINAL_HOLDOUT_START_ISSUE) throw new Error('禁止读取最终前瞻段用于回测');
  const rows = database.prepare(`SELECT issue, draw_date, red_ball_1, red_ball_2, red_ball_3,
    red_ball_4, red_ball_5, red_ball_6, blue_ball, prize_grades_json, raw_record_json
    FROM draws WHERE issue <= ? ORDER BY issue`).all(endIssue) as Array<{
      issue: string; draw_date: string; red_ball_1: number; red_ball_2: number; red_ball_3: number;
      red_ball_4: number; red_ball_5: number; red_ball_6: number; blue_ball: number;
      prize_grades_json: string | null; raw_record_json: string | null;
    }>;
  return rows.map(row => ({ issue: row.issue, drawDate: row.draw_date,
    redBalls: [row.red_ball_1, row.red_ball_2, row.red_ball_3, row.red_ball_4, row.red_ball_5, row.red_ball_6],
    blueBall: row.blue_ball, prizeGrades: JSON.parse(row.prize_grades_json ?? '[]') as BacktestDraw['prizeGrades'],
    rawRecordJson: row.raw_record_json ?? '{}',
  }));
}

export function startBacktestRun(database: SqliteDatabase, strategy: BacktestStrategy, options: BacktestOptions): number {
  const result = database.prepare(`INSERT INTO backtest_runs (strategy_name, strategy_version,
    strategy_params_json, random_seed, tickets_per_issue, evaluation_start_issue, evaluation_end_issue,
    uses_final_holdout, run_status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(
      strategy.name, strategy.version, JSON.stringify({ ...strategy.parameters, backtestOptions: options, holdoutPolicyVersion: HOLDOUT_POLICY_VERSION }),
      String(options.seed), options.ticketsPerIssue, options.startIssue, options.endIssue,
      Number(options.endIssue >= FINAL_HOLDOUT_START_ISSUE), new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

export function finishBacktestRun(database: SqliteDatabase, id: number, report: BacktestReport | null, detailPath: string | null, error: string | null): void {
  const summary = report ? { definitionVersion: report.definitionVersion, dataFingerprint: report.dataFingerprint,
    coverage: report.coverage, payoutAudit: report.payoutAudit, distributions: report.distributions, calibration: report.calibration,
    repetitions: report.repetitions, formalRoiAvailable: false } : null;
  const result = database.prepare(`UPDATE backtest_runs SET run_status=?, metrics_summary_json=?, detail_file_path=?,
    error_message=?, finished_at=? WHERE id=? AND run_status='running'`).run(
      error === null ? 'succeeded' : 'failed', summary === null ? null : JSON.stringify(summary), detailPath, error, new Date().toISOString(), id,
    );
  if (result.changes !== 1) throw new Error('回测登记已结束或不存在，禁止覆盖历史结果');
}