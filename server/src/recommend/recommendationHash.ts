/** 纯哈希帮助函数；不导入连接/config，也不查询库内历史。 */
import { createHash } from 'node:crypto';
import type { DrawRecord } from '../domain/lottery';
import type { RecommendationContent } from './recommendationTypes';

/** JSON 对象键递归排序、数组顺序保留；拒绝会被 JSON 静默丢失的值。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, item => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('canonical JSON 仅支持有限数值、字符串、布尔、null、数组和普通对象');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** 显式选择全部内容字段，不包含数据库id；版本、时间、目标和源期号都参与哈希。 */
export function computeRecommendationContentHash(content: RecommendationContent): string {
  return hashJson({
    hashDefinition: 'recommendation-canonical-v1',
    targetIssue: content.targetIssue, targetDrawDate: content.targetDrawDate,
    generationDeadline: content.generationDeadline, sourceLatestIssue: content.sourceLatestIssue,
    strategyName: content.strategyName, strategyVersion: content.strategyVersion,
    strategyParams: content.strategyParams, seed: content.seed,
    tickets: content.tickets, generatedAt: content.generatedAt,
  });
}

/** 原始JSON按原文纳入：补奖字段/原始公告修正也会产生新版本，抓取时间不参与。 */
export function computeDrawFingerprint(draw: DrawRecord): string {
  return hashJson({
    fingerprintDefinition: 'recommendation-draw-v1', issue: draw.issue, drawDate: draw.drawDate,
    redBalls: draw.redBalls, blueBall: draw.blueBall, prizeGrades: draw.prizeGrades,
    rawRecordJson: draw.rawRecordJson, isPrizeDetailComplete: draw.isPrizeDetailComplete,
  });
}

export function assertRecommendationContentHash(content: RecommendationContent & { contentHash: string }): void {
  if (!/^[a-f0-9]{64}$/.test(content.contentHash)
    || computeRecommendationContentHash(content) !== content.contentHash) {
    throw new Error('推荐内容哈希不一致，拒绝返回或核验');
  }
}