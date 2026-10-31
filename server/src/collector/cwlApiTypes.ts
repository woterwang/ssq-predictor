/**
 * 中国福彩网开奖查询接口的请求与响应类型
 *
 * 接口地址：https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice
 *
 * 注意：响应来自外部系统，字段类型不可完全信任，
 * 因此单条记录的字段一律声明为 unknown，由解析器逐项校验后再使用。
 */

/** 查询参数（不含固定参数 name=ssq、systemType=PC） */
export interface CwlDrawNoticeQuery {
  /** 最近 N 期 */
  issueCount?: number;
  /** 起始期号（含），如 2026001 */
  issueStart?: string;
  /** 结束期号（含），如 2026999 */
  issueEnd?: string;
  /** 起始日期（含），YYYY-MM-DD */
  dayStart?: string;
  /** 结束日期（含），YYYY-MM-DD */
  dayEnd?: string;
  /** 页码，从 1 开始 */
  pageNo: number;
  /** 每页条数 */
  pageSize: number;
}

/**
 * 单期开奖原始记录。
 * 已知字段示例：
 *   code: "2026124"                     期号
 *   date: "2026-10-29(四)"              开奖日期（带星期）
 *   red: "03,11,17,22,23,29"            红球
 *   blue: "09"                          蓝球
 *   sales: "346568144"                  销售额（元）
 *   poolmoney: "1075698427"             奖池（元）
 *   content: "江苏1注，……共8注。"         一等奖地区分布
 *   prizegrades: [{ type: 1, typenum: "8", typemoney: "..." }, ...]  奖级明细
 * 其余字段（detailsLink、fyjCount、fyjMoney 等）原样保留在原始记录中。
 */
export interface CwlDrawNoticeItemRaw {
  code?: unknown;
  date?: unknown;
  red?: unknown;
  blue?: unknown;
  sales?: unknown;
  poolmoney?: unknown;
  content?: unknown;
  prizegrades?: unknown;
  [otherField: string]: unknown;
}

/** 接口响应（已通过基本结构校验） */
export interface CwlDrawNoticeResponse {
  /** 状态码，0 表示成功 */
  state: number;
  /** 状态说明 */
  message: string;
  /** 符合条件的总记录数 */
  total: number;
  /** 总页数 */
  pageNum: number;
  /** 当前页码 */
  pageNo: number;
  /** 每页条数 */
  pageSize: number;
  /** 当前页的开奖记录（按期号倒序） */
  result: CwlDrawNoticeItemRaw[];
}

/** 按页获取开奖数据的函数签名；采集流程依赖此签名，便于替换数据源或使用本地样本测试 */
export type DrawNoticePageFetcher = (query: CwlDrawNoticeQuery) => Promise<CwlDrawNoticeResponse>;
