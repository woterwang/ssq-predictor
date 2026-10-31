/**
 * M0推荐固化及开奖后追加核验。服务的 now 由服务器/调度器提供，绝不可从客户端参数传入。
 * 本地哈希只证明内容一致，不能提供第三方开奖前可信时间戳；不读取/解锁回测holdout。
 */
import { randomBytes } from 'node:crypto';
import { createResearchRandom, RANDOM_ALGORITHM } from '../analysis/researchRandom';
import { assertLegalTicket, buildDrawPayoutPolicy, countTicketHits, determinePrizeGrade,
  PRIZE_RULE_VERSION, TICKET_PRICE_YUAN } from '../backtest/prizeRules';
import { computeNextDraw, isScheduledDrawDate } from '../calendar/drawCalendar';
import type { SalesSuspensionPeriod } from '../calendar/drawCalendar';
import type { SqliteDatabase } from '../db/connection';
import { findDrawByIssue, findLatestDraw } from '../db/drawRepository';
import { findRecommendationById, findRecommendationByTargetAndStrategy, insertRecommendation,
  insertRecommendationVerification, listRecommendations, listRecommendationVerifications } from '../db/recommendationRepository';
import { uniformRandomStrategy } from '../models/uniformRandomModel';
import { formatBeijingTimestamp, isValidDateText } from '../utils/time';
import { assertRecommendationContentHash, canonicalJson, computeDrawFingerprint,
  computeRecommendationContentHash } from './recommendationHash';
import type { RecommendationContent, RecommendationOptions, RecommendationRecord,
  RecommendationVerificationResult, RecommendationVerificationView, VerifyPendingRecommendationsResult } from './recommendationTypes';

export const DEFAULT_RECOMMENDATION_TICKETS = 5;
/** 防止单次请求耗尽资源，不是算法筛选或参数搜索。 */
const MAX_RECOMMENDATION_TICKETS = 1000;
export const GENERATION_DEADLINE_POLICY = 'conservative-generation-cutoff-20:00+08:00-v1';

function assertNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now 必须为有效的服务器时间');
}

function assertImmediateTransactionBoundary(database: SqliteDatabase): void {
  // better-sqlite3嵌套transaction只建立savepoint，无法把外层deferred升级为immediate。
  if (database.inTransaction) throw new Error('推荐服务必须从事务外调用，以保证 BEGIN IMMEDIATE 读取边界');
}

function validateOptions(options: RecommendationOptions): { ticketsPerIssue: number; seed: number | undefined } {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'ticketsPerIssue' && key !== 'seed')) {
    throw new Error('推荐参数只接受 ticketsPerIssue 和 seed，不接受客户端指定生成时间');
  }
  const ticketsPerIssue = options.ticketsPerIssue ?? DEFAULT_RECOMMENDATION_TICKETS;
  const seed = options.seed;
  if (!Number.isInteger(ticketsPerIssue) || ticketsPerIssue < 1 || ticketsPerIssue > MAX_RECOMMENDATION_TICKETS) {
    throw new Error(`ticketsPerIssue 必须为1–${MAX_RECOMMENDATION_TICKETS}整数`);
  }
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
    throw new Error('seed 必须是0–4294967295整数');
  }
  // null不是“未传参数”，避免运行时非TS调用者绕过校验。
  if (options.ticketsPerIssue === null || options.seed === null) throw new Error('推荐参数不能为null');
  return { ticketsPerIssue, seed };
}

export function getConservativeGenerationDeadline(targetDrawDate: string): string {
  if (!isValidDateText(targetDrawDate)) throw new Error('目标开奖日期非法');
  return `${targetDrawDate}T20:00:00.000+08:00`;
}

function drawTimestamp(dateText: string): number {
  if (!isValidDateText(dateText)) throw new Error('开奖日期非法');
  return Date.parse(`${dateText}T21:15:00.000+08:00`);
}

function parameters(ticketsPerIssue: number): Record<string, unknown> {
  return { ...uniformRandomStrategy.parameters, ticketsPerIssue, randomAlgorithm: RANDOM_ALGORITHM,
    generationDeadlinePolicy: GENERATION_DEADLINE_POLICY };
}

/** 校验持久化记录：旧元数据/未知模型版本/非法票/越过截止的记录不参与真实核验。 */
function assertRecommendationMetadata(database: SqliteDatabase, record: RecommendationRecord): void {
  assertRecommendationContentHash(record);
  if (record.strategyName !== uniformRandomStrategy.name || record.strategyVersion !== uniformRandomStrategy.version) {
    throw new Error('推荐不是受支持的唯一M0版本');
  }
  if (!/^\d{7}$/.test(record.targetIssue) || record.targetIssue.endsWith('000')
    || record.sourceLatestIssue === null || !/^\d{7}$/.test(record.sourceLatestIssue)
    || record.sourceLatestIssue.endsWith('000') || record.sourceLatestIssue >= record.targetIssue
    || record.targetDrawDate === null || !isValidDateText(record.targetDrawDate)
    || !isScheduledDrawDate(record.targetDrawDate, [])
    || record.targetDrawDate.slice(0, 4) !== record.targetIssue.slice(0, 4)
    || record.generationDeadline !== getConservativeGenerationDeadline(record.targetDrawDate)) {
    throw new Error('推荐元数据非法或旧行缺少目标日期/截止/源期号');
  }
  validateOptions({ ticketsPerIssue: record.tickets.length, seed: record.seed });
  if (canonicalJson(record.strategyParams) !== canonicalJson(parameters(record.tickets.length))) {
    throw new Error('推荐策略参数与固化M0定义不一致');
  }
  const ticketKeys = new Set<string>();
  for (const ticket of record.tickets) {
    assertLegalTicket(ticket);
    if (ticket.redBalls.some((ball, index) => index > 0 && ball <= ticket.redBalls[index - 1])) {
      throw new Error('推荐红球必须严格升序');
    }
    ticketKeys.add(canonicalJson(ticket));
  }
  if (ticketKeys.size !== record.tickets.length) throw new Error('推荐含重复整票');
  const source = findDrawByIssue(database, record.sourceLatestIssue);
  if (!source || !isValidDateText(source.drawDate) || source.drawDate >= record.targetDrawDate
    || source.issue.slice(0, 4) !== source.drawDate.slice(0, 4)) throw new Error('推荐源期开奖缺失或日期非法');
  const expectedIssue = source.issue.slice(0, 4) === record.targetDrawDate.slice(0, 4)
    ? `${source.issue.slice(0, 4)}${String(Number(source.issue.slice(4)) + 1).padStart(3, '0')}`
    : `${record.targetDrawDate.slice(0, 4)}001`;
  if (expectedIssue !== record.targetIssue) throw new Error('推荐目标不是源开奖的下一期期号');
  const generatedTime = Date.parse(record.generatedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|\+08:00)$/.test(record.generatedAt)
    || !isValidDateText(record.generatedAt.slice(0, 10)) || !Number.isFinite(generatedTime)
    || record.generatedAt !== (record.generatedAt.endsWith('Z')
      ? new Date(generatedTime).toISOString() : formatBeijingTimestamp(new Date(generatedTime)))
    || !(generatedTime > drawTimestamp(source.drawDate))
    || !(generatedTime < Date.parse(record.generationDeadline))) {
    throw new Error('推荐生成时间非法，必须晚于源开奖21:15且早于保守生成截止');
  }
}

export function generateNextRecommendation(
  database: SqliteDatabase,
  suspensionPeriods: readonly SalesSuspensionPeriod[],
  now: Date,
  options: RecommendationOptions = {},
): RecommendationRecord {
  const validated = validateOptions(options); // 参数错误在读取/写入数据库之前拒绝。
  assertNow(now);
  const generationTime = now.getTime();
  for (const period of suspensionPeriods) {
    if (!isValidDateText(period.startDate) || !isValidDateText(period.endDate) || period.startDate > period.endDate
      || typeof period.reason !== 'string' || !period.reason.trim()) throw new Error('停售期日历参数非法');
  }
  assertImmediateTransactionBoundary(database);
  return database.transaction(() => {
    const latest = findLatestDraw(database);
    if (latest === null) throw new Error('开奖库为空，无法确定下一期；请先同步真实开奖');
    if (!/^\d{7}$/.test(latest.issue) || latest.issue.endsWith('000') || !isValidDateText(latest.drawDate)
      || latest.issue.slice(0, 4) !== latest.drawDate.slice(0, 4)) throw new Error('源期开奖元数据非法');
    const target = computeNextDraw(latest, suspensionPeriods);
    const deadline = getConservativeGenerationDeadline(target.drawDate);
    const existing = findRecommendationByTargetAndStrategy(database, target.issue, uniformRandomStrategy.name);
    if (existing !== null) {
      assertRecommendationMetadata(database, existing);
      if (existing.targetDrawDate !== target.drawDate || existing.generationDeadline !== deadline
        || existing.sourceLatestIssue !== latest.issue) throw new Error('日历变化与已有推荐目标日期不符，禁止重写');
    }
    if (findDrawByIssue(database, target.issue) !== null
      || database.prepare('SELECT issue FROM draws WHERE draw_date = ?').get(target.drawDate)) {
      throw new Error('目标开奖已入库，禁止事后生成推荐');
    }
    if (!(generationTime > drawTimestamp(latest.drawDate))) throw new Error('必须晚于源期开奖21:15才可生成推荐');
    if (!(generationTime < Date.parse(deadline))) {
      throw new Error('已到保守生成截止20:00或源数据过旧；请同步，不跳到未来补造历史推荐');
    }
    if (existing !== null) return existing; // 忽略合法但不同的新参数/种子，返回原件。
    const seed = validated.seed ?? randomBytes(4).readUInt32LE(0);
    // M0不使用历史；显式空历史，绝不把库内全部历史/未来信息传入模型。
    const prediction = uniformRandomStrategy.createPredictor()({ targetIssue: target.issue, history: [],
      ticketsPerIssue: validated.ticketsPerIssue, random: createResearchRandom(seed) });
    const content: RecommendationContent = {
      targetIssue: target.issue, targetDrawDate: target.drawDate, generationDeadline: deadline,
      sourceLatestIssue: latest.issue, strategyName: uniformRandomStrategy.name,
      strategyVersion: uniformRandomStrategy.version, strategyParams: parameters(validated.ticketsPerIssue),
      seed, tickets: prediction.tickets, generatedAt: new Date(generationTime).toISOString(),
    };
    const record = { ...content, contentHash: computeRecommendationContentHash(content) };
    // 在写入前用同一完整校验，保证生成/核验的规则一致。
    assertRecommendationMetadata(database, { ...record, id: 0 });
    return insertRecommendation(database, record);
  }).immediate();
}

export function verifyPendingRecommendations(database: SqliteDatabase, now: Date): VerifyPendingRecommendationsResult {
  assertNow(now);
  const verificationTime = now.getTime();
  assertImmediateTransactionBoundary(database);
  return database.transaction(() => {
    const summary: VerifyPendingRecommendationsResult = { verifiedCount: 0, pendingCount: 0,
      unchangedCount: 0, skippedCount: 0, skipped: [], verifications: [] };
    for (const record of listRecommendations(database)) {
      // 逐条验证并报告原因；单条损坏不阻止其他合法推荐核验。
      let draw;
      try {
        assertRecommendationMetadata(database, record);
        draw = findDrawByIssue(database, record.targetIssue);
        if (draw !== null && draw.drawDate !== record.targetDrawDate) throw new Error('目标开奖日期与推荐固化日期不一致');
      } catch (error) {
        summary.skippedCount++;
        summary.skipped.push({ recommendationId: record.id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (draw === null || verificationTime < drawTimestamp(draw.drawDate)) {
        summary.pendingCount++;
        continue;
      }
      const fingerprint = computeDrawFingerprint(draw);
      if (listRecommendationVerifications(database, record.id).some(version => version.drawFingerprint === fingerprint)) {
        summary.unchangedCount++;
        continue;
      }
      assertLegalTicket(draw);
      const payoutAudit = buildDrawPayoutPolicy(draw);
      const prizeCounts: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, fortune: 0, none: 0 };
      const outcomes = record.tickets.map(ticket => {
        const hits = countTicketHits(ticket, draw);
        const grade = determinePrizeGrade(hits.redHits, hits.blueHit, payoutAudit.fortuneActive);
        prizeCounts[grade]++;
        return { ...hits, grade, prizeYuan: payoutAudit.eligible ? (payoutAudit.amounts[grade] ?? null) : null };
      });
      const result: RecommendationVerificationResult = {
        definitionVersion: `recommendation-verification-v1/${PRIZE_RULE_VERSION}`,
        recommendationContentHash: record.contentHash, targetIssue: record.targetIssue,
        targetDrawDate: draw.drawDate, outcomes, prizeCounts,
        totalRedHits: outcomes.reduce((sum, outcome) => sum + outcome.redHits, 0),
        blueHitCount: outcomes.filter(outcome => outcome.blueHit).length,
        costYuan: record.tickets.length * TICKET_PRICE_YUAN, payoutAudit,
        announcedPrizeReplayYuan: payoutAudit.eligible && outcomes.every(outcome => outcome.prizeYuan !== null)
          ? outcomes.reduce((sum, outcome) => sum + (outcome.prizeYuan ?? 0), 0) : null,
        formalRoi: null,
        limitations: ['20:00为保守推荐生成截止，非已核实官方销售停售时间',
          '本地哈希及生成时间不提供第三方开奖前可信时间戳', '公告奖金仅税前回放，未模拟奖池稀释、税收及实际兑奖'],
      };
      summary.verifications.push(insertRecommendationVerification(database, { recommendationId: record.id,
        drawFingerprint: fingerprint, result, verifiedAt: new Date(verificationTime).toISOString() }));
      summary.verifiedCount++;
    }
    return summary;
  }).immediate();
}

export function getRecommendationVerification(database: SqliteDatabase, id: number): RecommendationVerificationView | null {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('推荐id必须为安全正整数');
  const recommendation = findRecommendationById(database, id);
  if (recommendation === null) return null;
  assertRecommendationContentHash(recommendation);
  const versions = listRecommendationVerifications(database, id);
  const draw = findDrawByIssue(database, recommendation.targetIssue);
  const fingerprint = draw === null ? null : computeDrawFingerprint(draw);
  // A→B→A修正无需复制A核验，但当前结果必须匹配A，而不是最后插入的B。
  return { recommendation, latest: versions.find(version => version.drawFingerprint === fingerprint) ?? null, versions };
}