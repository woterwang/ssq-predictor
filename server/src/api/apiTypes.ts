/** API 只接收服务器依赖，不读取环境、配置文件，也不创建数据库连接。 */
import type { SqliteDatabase } from '../db/connection';
import type { SalesSuspensionPeriod } from '../calendar/drawCalendar';

export interface ApiDependencies {
  database: SqliteDatabase;
  adminApiKey: string | null;
  now: () => Date;
  loadSuspensionPeriods: () => SalesSuspensionPeriod[];
  /** 由入口接入统一同步锁与推荐生命周期；API 不自行 fetch 或解析采集日志。 */
  synchronize: () => Promise<unknown>;
  rateLimit?: { windowMs: number; publicMax: number; adminMax: number };
}

export const API_DISCLAIMERS: readonly string[] = Object.freeze([
  '彩票开奖结果不可可靠预测；M0 是透明随机基线，不承诺中奖或收益，请理性投注。',
  '20:00（北京时间）仅为保守推荐生成截止，非已核实的官方销售停售时间。',
  '内容哈希只证明内容一致，本地生成时间不提供第三方开奖前可信时间戳。',
  '历史冷热、遗漏及组合结构不代表单注优越性；正式 ROI 不提供。',
]);