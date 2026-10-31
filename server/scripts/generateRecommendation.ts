/** 手动生成下一期固化M0推荐。仅使用真实服务器时间，不支持指定历史时间或模拟开奖。 */
import { loadSalesSuspensionPeriods } from '../src/calendar/salesSuspensionConfig';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { generateNextRecommendation } from '../src/recommend/recommendationService';

try {
  // 不接受CLI时间/模型参数，默认5注及crypto随机UInt32种子。
  if (process.argv.length > 2) throw new Error('本命令不接受参数，生成时间必须来自服务器真实时钟');
  const database = getDatabase();
  const suspensionPeriods = loadSalesSuspensionPeriods();
  const recommendation = generateNextRecommendation(database, suspensionPeriods, new Date());
  console.log(JSON.stringify(recommendation, null, 2));
  console.log('20:00仅为保守推荐生成截止，非已核实官方销售停售时间。');
  console.log('内容哈希仅证明内容一致，不提供第三方开奖前可信时间戳；正式ROI不提供。');
} catch (error) {
  console.error(`推荐生成失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
}