/**
 * 统计服务：窗口切分、缺期提示、组合特征计算和按数据库隔离的有界缓存。
 * 每次读取轻量号码快照并计算 SHA-256，任何号码新增/删除/修正均使缓存失效，
 * 即使数据由另一进程更新也能发现；不依赖时间戳精度，也无需采集层调用失效钩子。
 * 缓存命中时不重算统计。指纹只是数据标识，不是外部可信时间戳。
 */
import { createHash } from 'node:crypto';
import { readAnalysisSnapshot } from '../db/analysisRepository';
import type { SqliteDatabase } from '../db/connection';
import { formatBeijingTimestamp } from '../utils/time';
import type { AnalysisDraw, AnalysisQuery, BasicAnalysisReport } from './analysisTypes';
import { calculateDrawFeatures, calculateFeatureDistributions } from './drawFeatures';
import { calculateNumberStatistics } from './numberStatistics';

/** 定义变化时更新版本，防止后续回测混用统计口径。 */
const DEFINITION_VERSION = 'basic-analysis-v1';
const MAX_CACHED_QUERIES_PER_DATABASE = 16;
const cacheByDatabase = new WeakMap<SqliteDatabase, Map<string, BasicAnalysisReport>>();

/** 对象递归只读，防止调用方改动数组或分布污染共享缓存。 */
function freezeDeep<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 是否可作为紧邻上期：同年序号 +1，或跨一年且新年序号为 001。
 * 跨年上一年年末的完整性需另外检查，本函数不能从期号推断年末应有多少期。
 */
function isAdjacentIssue(previous: AnalysisDraw, current: AnalysisDraw): boolean {
  const previousYear = Number(previous.issue.slice(0, 4));
  const currentYear = Number(current.issue.slice(0, 4));
  return currentYear === previousYear
    ? Number(current.issue.slice(4)) === Number(previous.issue.slice(4)) + 1
    : currentYear === previousYear + 1 && current.issue.endsWith('001');
}

/** 默认全量，或 window=30/100/300 等正整数；asOfIssue 是包含式截止期号。 */
export function getBasicAnalysis(database: SqliteDatabase, query: AnalysisQuery = {}): BasicAnalysisReport {
  const window = query.window ?? null;
  const asOfIssue = query.asOfIssue ?? null;
  if (window !== null && (!Number.isSafeInteger(window) || window < 1)) {
    throw new Error('统计窗口必须是正整数，或 null（全部可用历史）');
  }
  if (asOfIssue !== null && (!/^\d{7}$/.test(asOfIssue) || asOfIssue.endsWith('000'))) {
    throw new Error('统计截止期号必须是有效的 7 位期号');
  }
  const snapshot = readAnalysisSnapshot(database, asOfIssue);
  const dataFingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const cacheKey = `${DEFINITION_VERSION}:${window ?? 'all'}:${asOfIssue ?? 'latest'}:${dataFingerprint}`;
  const databaseCache = cacheByDatabase.get(database) ?? new Map<string, BasicAnalysisReport>();
  cacheByDatabase.set(database, databaseCache);
  const cachedReport = databaseCache.get(cacheKey);
  if (cachedReport !== undefined) {
    // 命中提升到末尾，用插入顺序实现最简单的 LRU 淘汰。
    databaseCache.delete(cacheKey);
    databaseCache.set(cacheKey, cachedReport);
    return cachedReport;
  }

  const startIndex = window === null ? 0 : Math.max(0, snapshot.length - window);
  const sampleDraws = snapshot.slice(startIndex);
  const warnings = ['历史冷热与遗漏不是下期中奖概率；全量指当前已取得的数据，不保证覆盖双色球创始年至今。'];
  if (snapshot.length === 0) warnings.push('截止范围内没有开奖数据，频率与平均遗漏返回 null。');
  if (snapshot[0] !== undefined && Number(snapshot[0].issue.slice(0, 4)) > 2003) {
    warnings.push(`当前可用数据从 ${snapshot[0].issue} 起，更早历史未纳入统计。`);
  }
  if (window !== null && snapshot.length < window) {
    warnings.push(`请求最近 ${window} 期，实际只有 ${snapshot.length} 期可用，不补造数据。`);
  }
  if (asOfIssue !== null && snapshot[snapshot.length - 1]?.issue !== asOfIssue) {
    warnings.push(`截止期号 ${asOfIssue} 未入库，实际截至 ${snapshot[snapshot.length - 1]?.issue ?? '无数据'}。`);
  }
  const gapCount = sampleDraws.slice(1).filter((draw, index) => !isAdjacentIssue(sampleDraws[index], draw)).length;
  if (gapCount > 0) {
    warnings.push(`样本存在 ${gapCount} 处期号不相邻；遗漏按已存记录计数，不能当作真实完整期数，跨缺口重号/振幅返回 null。`);
  }
  const features = sampleDraws.map((draw, index) => {
    // 即使窗口是 30 期，第一期仍与窗口外紧邻的上一期比较，而不是丢失前一期信息。
    const previousDraw = snapshot[startIndex + index - 1] ?? null;
    return calculateDrawFeatures(draw, previousDraw !== null && isAdjacentIssue(previousDraw, draw) ? previousDraw : null);
  });
  const report = freezeDeep<BasicAnalysisReport>({
    definitionVersion: DEFINITION_VERSION,
    requestedWindow: window,
    requestedAsOfIssue: asOfIssue,
    sampleDrawCount: sampleDraws.length,
    availableDrawCount: snapshot.length,
    availableFirstIssue: snapshot[0]?.issue ?? null,
    availableLastIssue: snapshot[snapshot.length - 1]?.issue ?? null,
    firstIssue: sampleDraws[0]?.issue ?? null,
    lastIssue: sampleDraws[sampleDraws.length - 1]?.issue ?? null,
    generatedAt: formatBeijingTimestamp(),
    dataFingerprint,
    warnings,
    redNumbers: calculateNumberStatistics(sampleDraws, 'red'),
    blueNumbers: calculateNumberStatistics(sampleDraws, 'blue'),
    features,
    featureDistributions: calculateFeatureDistributions(features),
  });
  databaseCache.set(cacheKey, report);
  while (databaseCache.size > MAX_CACHED_QUERIES_PER_DATABASE) {
    databaseCache.delete(databaseCache.keys().next().value as string);
  }
  return report;
}