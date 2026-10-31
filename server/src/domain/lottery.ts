/**
 * 双色球规则常量与领域类型
 *
 * 全项目共用：采集、分析、算法、回测都从这里读取规则，避免魔法数字散落各处。
 */

/** 红球号码范围：1–33 */
export const RED_BALL_MIN = 1;
export const RED_BALL_MAX = 33;
/** 每期开出的红球个数 */
export const RED_BALL_COUNT_PER_DRAW = 6;

/** 蓝球号码范围：1–16 */
export const BLUE_BALL_MIN = 1;
export const BLUE_BALL_MAX = 16;
/** 每期开出的蓝球个数 */
export const BLUE_BALL_COUNT_PER_DRAW = 1;

/** 双色球首期期号（2003 年第 001 期） */
export const FIRST_ISSUE = '2003001';
/** 双色球首次开奖年份 */
export const FIRST_DRAW_YEAR = 2003;

/** 本查询接口实际覆盖起点（2026-10-31 实测最早为 2013001），并非双色球创始年份。 */
export const CWL_API_FIRST_AVAILABLE_YEAR = 2013;

/** 每周开奖日：周日、周二、周四（0 = 周日，与 Date.getUTCDay 一致） */
export const DRAW_WEEKDAYS: readonly number[] = [0, 2, 4];

/** 开奖时间（北京时间）21:15 */
export const DRAW_TIME_BEIJING = { hour: 21, minute: 15 } as const;

/**
 * 判定“奖级明细完整”所需的固定奖级编号：一至六等奖。
 * 官方接口 prizegrades[].type 的编号含义待用真实数据核实；
 * 若存在额外奖级（如接口中的 fyjCount / fyjMoney 字段），原样保存在原始记录中，不影响完整性判定。
 */
export const REQUIRED_PRIZE_GRADES: readonly number[] = [1, 2, 3, 4, 5, 6];

/** 单个奖级的中奖明细 */
export interface PrizeGradeDetail {
  /** 奖级编号（官方 type 字段） */
  grade: number;
  /** 中奖注数；官方尚未公布时为 null */
  winningTicketCount: number | null;
  /** 单注奖金（元）；官方尚未公布时为 null */
  prizePerTicketYuan: number | null;
}

/** 一期开奖记录（已解析、已校验） */
export interface DrawRecord {
  /** 期号，7 位数字，如 2026124 */
  issue: string;
  /** 开奖日期，YYYY-MM-DD */
  drawDate: string;
  /** 6 个红球，升序 */
  redBalls: number[];
  /** 蓝球 */
  blueBall: number;
  /** 销售额（元）；未公布为 null */
  salesAmountYuan: number | null;
  /** 奖池金额（元）；未公布为 null */
  prizePoolAmountYuan: number | null;
  /** 一等奖中奖地区说明原文 */
  firstPrizeRegionText: string | null;
  /** 奖级明细，按奖级编号升序 */
  prizeGrades: PrizeGradeDetail[];
  /** 一至六等奖的中奖注数是否都已公布 */
  isPrizeDetailComplete: boolean;
  /** 数据来源标识 */
  dataSource: string;
  /** 接口返回的该期原始记录 JSON，保留全部字段，便于日后重新解析 */
  rawRecordJson: string;
}

/** 数据库中的开奖记录（含入库与更新时间） */
export interface StoredDrawRecord extends DrawRecord {
  fetchedAt: string;
  updatedAt: string;
}
