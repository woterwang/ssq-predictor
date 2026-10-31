/**
 * 数据库结构迁移
 *
 * 设计说明：
 * - 每次修改表结构都新增一条迁移记录（版本号递增），不要修改已发布的迁移，
 *   这样已有数据库只需执行“比当前版本新”的迁移即可升级，数据不丢失。
 * - 当前数据库的结构版本保存在 SQLite 内置的 PRAGMA user_version 中。
 * - 每条迁移在独立事务中执行，失败时整体回滚，不会留下半成品结构。
 *
 * 字段约定：
 * - 时间字段统一存 ISO 8601 字符串（含时区），如 2026-10-29T21:30:00.000+08:00；
 * - 金额字段单位统一为“元”，存整数；
 * - *_json 字段存 JSON 文本，并用 json_valid() 约束格式合法。
 */
import type { SqliteDatabase } from './connection';

/** 一条结构迁移 */
export interface SchemaMigration {
  /** 迁移版本号，从 1 开始连续递增 */
  version: number;
  /** 迁移内容说明 */
  description: string;
  /** 升级用 SQL，可包含多条语句 */
  upgradeSql: string;
}

/** 迁移执行结果 */
export interface MigrationResult {
  /** 执行前的结构版本 */
  previousVersion: number;
  /** 执行后的结构版本 */
  currentVersion: number;
  /** 本次实际执行的迁移 */
  appliedMigrations: SchemaMigration[];
}

/**
 * 全部迁移，按版本号升序排列。
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: '初始结构：开奖记录、推荐记录、回测记录、采集日志',
    upgradeSql: `
      -- =====================================================================
      -- 开奖记录表：每期一行，期号为主键
      -- =====================================================================
      CREATE TABLE draws (
        -- 期号，7 位数字：4 位年份 + 3 位年内序号，如 2026124
        issue                     TEXT    PRIMARY KEY,
        -- 开奖日期，格式 YYYY-MM-DD
        draw_date                 TEXT    NOT NULL UNIQUE,
        -- 6 个红球，入库前已按升序排列
        red_ball_1                INTEGER NOT NULL,
        red_ball_2                INTEGER NOT NULL,
        red_ball_3                INTEGER NOT NULL,
        red_ball_4                INTEGER NOT NULL,
        red_ball_5                INTEGER NOT NULL,
        red_ball_6                INTEGER NOT NULL,
        -- 蓝球
        blue_ball                 INTEGER NOT NULL,
        -- 本期销售额（元）；官方未公布时为 NULL
        sales_amount_yuan         INTEGER,
        -- 开奖后奖池金额（元）；官方未公布时为 NULL
        prize_pool_amount_yuan    INTEGER,
        -- 一等奖中奖地区说明，保存官方 content 字段原文
        first_prize_region_text   TEXT,
        -- 奖级明细 JSON 数组，每项含奖级、中奖注数、单注奖金
        prize_grades_json         TEXT,
        -- 奖级明细是否完整：0 = 待补全（官方可能晚于号码公布），1 = 已完整
        is_prize_detail_complete  INTEGER NOT NULL DEFAULT 0,
        -- 数据来源标识，如 cwl_official
        data_source               TEXT    NOT NULL,
        -- 首次采集入库时间
        fetched_at                TEXT    NOT NULL,
        -- 最近一次更新时间（如补全奖级明细）
        updated_at                TEXT    NOT NULL,

        -- 数据库层兜底校验：即使程序校验遗漏，非法数据也无法写入
        CHECK (issue GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
        CHECK (draw_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        -- 红球范围 1–33，且严格升序（同时保证 6 个号码互不重复）
        CHECK (red_ball_1 >= 1 AND red_ball_6 <= 33),
        CHECK (red_ball_1 < red_ball_2 AND red_ball_2 < red_ball_3 AND red_ball_3 < red_ball_4
               AND red_ball_4 < red_ball_5 AND red_ball_5 < red_ball_6),
        -- 蓝球范围 1–16
        CHECK (blue_ball BETWEEN 1 AND 16),
        CHECK (sales_amount_yuan IS NULL OR sales_amount_yuan >= 0),
        CHECK (prize_pool_amount_yuan IS NULL OR prize_pool_amount_yuan >= 0),
        CHECK (is_prize_detail_complete IN (0, 1)),
        CHECK (prize_grades_json IS NULL OR json_valid(prize_grades_json))
      );

      -- =====================================================================
      -- 推荐记录表：每期开奖前生成的推荐号码
      -- 写入后只读（见下方触发器），用于开奖后真实核验，保证推荐不能事后修改
      -- =====================================================================
      CREATE TABLE recommendations (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        -- 推荐针对的期号（生成时尚未开奖）
        target_issue              TEXT    NOT NULL,
        -- 策略名称，如 M0_uniform_random
        strategy_name             TEXT    NOT NULL,
        -- 策略版本，算法或默认参数变化时递增
        strategy_version          TEXT    NOT NULL,
        -- 本次使用的策略参数 JSON
        strategy_params_json      TEXT    NOT NULL,
        -- 随机种子，用于复现推荐结果
        random_seed               TEXT    NOT NULL,
        -- 推荐的多注号码 JSON 数组
        tickets_json              TEXT    NOT NULL,
        -- 推荐内容的 SHA-256 哈希，可公开用于证明推荐生成于开奖前
        content_hash              TEXT    NOT NULL,
        -- 生成时间
        generated_at              TEXT    NOT NULL,

        -- 同一期同一策略只允许生成一次，杜绝多次生成后挑选
        UNIQUE (target_issue, strategy_name),
        CHECK (target_issue GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
        CHECK (json_valid(strategy_params_json)),
        CHECK (json_valid(tickets_json)),
        CHECK (length(content_hash) = 64)
      );

      -- 禁止修改推荐记录
      CREATE TRIGGER recommendations_forbid_update
      BEFORE UPDATE ON recommendations
      BEGIN
        SELECT RAISE(ABORT, '推荐记录写入后只读，禁止修改');
      END;

      -- 禁止删除推荐记录
      CREATE TRIGGER recommendations_forbid_delete
      BEFORE DELETE ON recommendations
      BEGIN
        SELECT RAISE(ABORT, '推荐记录写入后只读，禁止删除');
      END;

      -- =====================================================================
      -- 回测记录表：登记每一次回测
      -- 同时作为“尝试过多少种策略与参数”的登记簿，用于评估过拟合风险
      -- =====================================================================
      CREATE TABLE backtest_runs (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_name             TEXT    NOT NULL,
        strategy_version          TEXT    NOT NULL,
        strategy_params_json      TEXT    NOT NULL,
        random_seed               TEXT    NOT NULL,
        -- 每期推荐的注数
        tickets_per_issue         INTEGER NOT NULL,
        -- 回测评估区间（含首尾期号）
        evaluation_start_issue    TEXT    NOT NULL,
        evaluation_end_issue      TEXT    NOT NULL,
        -- 是否使用了最终评估段：1 = 使用了（该段数据定稿前只允许使用一次）
        uses_final_holdout        INTEGER NOT NULL DEFAULT 0,
        -- 运行状态：running / succeeded / failed
        run_status                TEXT    NOT NULL,
        -- 指标汇总 JSON（对数损失、平均命中数、收益等）
        metrics_summary_json      TEXT,
        -- 逐期明细文件路径（明细数据量大，存文件不存库）
        detail_file_path          TEXT,
        -- 失败时的错误信息
        error_message             TEXT,
        started_at                TEXT    NOT NULL,
        finished_at               TEXT,

        CHECK (tickets_per_issue >= 1),
        CHECK (evaluation_start_issue <= evaluation_end_issue),
        CHECK (uses_final_holdout IN (0, 1)),
        CHECK (run_status IN ('running', 'succeeded', 'failed')),
        CHECK (json_valid(strategy_params_json)),
        CHECK (metrics_summary_json IS NULL OR json_valid(metrics_summary_json))
      );

      CREATE INDEX idx_backtest_runs_strategy ON backtest_runs (strategy_name, strategy_version);

      -- =====================================================================
      -- 采集日志表：记录每一次从官方接口拉取数据的过程与结果
      -- =====================================================================
      CREATE TABLE fetch_logs (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        -- 采集方式：full_import = 全量导入，incremental = 增量更新，
        --          prize_detail_refresh = 补全奖级明细
        fetch_mode                TEXT    NOT NULL,
        -- 请求参数 JSON（期号区间、分页等）
        request_params_json       TEXT,
        -- 运行状态：running / succeeded / failed
        run_status                TEXT    NOT NULL,
        -- 从接口取得的记录数
        fetched_record_count      INTEGER NOT NULL DEFAULT 0,
        -- 新增入库的记录数
        inserted_record_count     INTEGER NOT NULL DEFAULT 0,
        -- 更新的已有记录数
        updated_record_count      INTEGER NOT NULL DEFAULT 0,
        -- 失败时的错误信息
        error_message             TEXT,
        started_at                TEXT    NOT NULL,
        finished_at               TEXT,

        CHECK (fetch_mode IN ('full_import', 'incremental', 'prize_detail_refresh')),
        CHECK (run_status IN ('running', 'succeeded', 'failed')),
        CHECK (request_params_json IS NULL OR json_valid(request_params_json))
      );

      CREATE INDEX idx_fetch_logs_started_at ON fetch_logs (started_at);
    `,
  },
  {
    version: 2,
    description: '开奖记录增加原始记录 JSON 列，保留接口全部字段（如 fyjCount、fyjMoney）',
    upgradeSql: `
      -- 接口返回的该期原始记录，便于日后核实字段含义或重新解析
      ALTER TABLE draws ADD COLUMN raw_record_json TEXT
        CHECK (raw_record_json IS NULL OR json_valid(raw_record_json));
    `,
  },
];

/**
 * 检查迁移列表本身是否规范：版本号必须从 1 开始连续递增。
 * 这是对代码的自检，防止新增迁移时写错版本号。
 */
function assertMigrationVersionsAreSequential(migrations: readonly SchemaMigration[]): void {
  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(`迁移版本号不连续：第 ${index + 1} 条迁移的版本应为 ${expectedVersion}，实际为 ${migration.version}`);
    }
  });
}

/**
 * 读取数据库当前的结构版本。新建的空数据库版本为 0。
 */
export function readSchemaVersion(database: SqliteDatabase): number {
  return database.pragma('user_version', { simple: true }) as number;
}

/**
 * 执行所有尚未执行的迁移，把数据库升级到最新结构。
 * 可重复调用：已是最新版本时不做任何修改。
 */
export function applyPendingMigrations(database: SqliteDatabase): MigrationResult {
  assertMigrationVersionsAreSequential(SCHEMA_MIGRATIONS);

  const previousVersion = readSchemaVersion(database);
  const latestVersion = SCHEMA_MIGRATIONS.length;

  // 数据库版本比代码还新，说明在用旧代码打开新数据库，继续运行可能损坏数据
  if (previousVersion > latestVersion) {
    throw new Error(
      `数据库结构版本（${previousVersion}）高于当前代码支持的最新版本（${latestVersion}），请升级代码后再运行`,
    );
  }

  const pendingMigrations = SCHEMA_MIGRATIONS.filter((migration) => migration.version > previousVersion);

  for (const migration of pendingMigrations) {
    // 每条迁移与版本号更新放在同一事务中：要么全部成功，要么全部回滚
    const runMigrationInTransaction = database.transaction(() => {
      database.exec(migration.upgradeSql);
      // 版本号来自代码中的常量整数，不存在注入风险
      database.pragma(`user_version = ${migration.version}`);
    });
    runMigrationInTransaction();
  }

  return {
    previousVersion,
    currentVersion: readSchemaVersion(database),
    appliedMigrations: pendingMigrations,
  };
}
