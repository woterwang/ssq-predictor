/** 下一期只读视图：以已存开奖为锚点，绝不因数据过旧而跳期补造推荐。 */
import { computeNextDraw } from '../calendar/drawCalendar';
import { listPublicDraws, publicRecommendation } from '../db/apiRepository';
import { findRecommendationByTargetAndStrategy } from '../db/recommendationRepository';
import { getConservativeGenerationDeadline } from '../recommend/recommendationService';
import { isValidDateText } from '../utils/time';
import type { ApiDependencies } from './apiTypes';
import { API_DISCLAIMERS } from './apiTypes';

export function nextRecommendationView(dependencies: ApiDependencies) {
  const latest = listPublicDraws(dependencies.database, 1, null)[0] ?? null;
  const now = dependencies.now();
  const suspensionPeriods = dependencies.loadSuspensionPeriods();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('服务器时钟非法');
  for (const period of suspensionPeriods) {
    if (!isValidDateText(period.startDate) || !isValidDateText(period.endDate) || period.startDate > period.endDate
      || typeof period.reason !== 'string' || !period.reason.trim()) throw new Error('服务器日历非法');
  }
  if (latest === null) return {
    status: 'not_generated' as const, reason: 'no_draws', nextDraw: null, generationDeadline: null,
    sourceLatestIssue: null, recommendation: null, disclaimers: API_DISCLAIMERS,
  };
  if (!isValidDateText(latest.drawDate) || latest.issue.slice(0, 4) !== latest.drawDate.slice(0, 4)
    || !/^[1-9]\d{6}$/.test(latest.issue) || latest.issue.endsWith('000')) throw new Error('源开奖元数据非法');
  const nextDraw = computeNextDraw(latest, suspensionPeriods);
  const generationDeadline = getConservativeGenerationDeadline(nextDraw.drawDate);
  const stored = findRecommendationByTargetAndStrategy(dependencies.database, nextDraw.issue, 'M0_uniform_random');
  const recommendation = stored === null ? null : publicRecommendation(stored);
  if (recommendation !== null && (recommendation.targetDrawDate !== nextDraw.drawDate
    || recommendation.generationDeadline !== generationDeadline || recommendation.sourceLatestIssue !== latest.issue)) {
    throw new Error('日历与固化推荐不一致');
  }
  const sourceDrawAt = Date.parse(`${latest.drawDate}T21:15:00.000+08:00`);
  const targetDrawAt = Date.parse(`${nextDraw.drawDate}T${nextDraw.drawTimeBeijing}:00.000+08:00`);
  // closed/awaiting_draw 优先于 available；截止后原推荐仍返回，但不再暗示可以生成。
  const status = now.getTime() <= sourceDrawAt || now.getTime() >= targetDrawAt ? 'awaiting_draw'
    : now.getTime() >= Date.parse(generationDeadline) ? 'closed'
      : recommendation === null ? 'not_generated' : 'available';
  const reason = now.getTime() <= sourceDrawAt ? 'source_draw_not_finished'
    : now.getTime() >= targetDrawAt ? 'target_draw_not_synchronized'
      : status === 'closed' ? 'generation_cutoff_reached' : null;
  return {
    status, reason, nextDraw, generationDeadline, sourceLatestIssue: latest.issue,
    recommendation, disclaimers: API_DISCLAIMERS,
  };
}