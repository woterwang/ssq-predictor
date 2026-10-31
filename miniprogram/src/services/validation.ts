import type { PublicDraw, Ticket, Recommendation, NextRecommendation, VerificationView, VerificationRecord,
  AnalysisReport, DrawFeatures, HeatLabel, NumberStatistics, BacktestRun, TicketCheckResult, RecommendationSummary } from '../types/api';

/** 在网络边界检查展示所依赖的字段，拒绝缺字段/假零，不把TS断言当运行时验证。 */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对象无效');
  return value as Record<string, unknown>;
}
function ensure(condition: boolean): asserts condition { if (!condition) throw new Error('公众响应字段无效'); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function issue(value: unknown): boolean { return text(value) && /^[1-9]\d{6}$/.test(value) && !value.endsWith('000'); }
function positiveId(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function timestamp(value: unknown): boolean {
  return text(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function date(value: unknown): boolean {
  return text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function nullableMoney(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
function hash(value: unknown): boolean { return text(value) && /^[a-f0-9]{64}$/.test(value); }
function texts(value: unknown): boolean { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function ticket(value: unknown): Ticket {
  const record = object(value);
  const reds = record.redBalls;
  ensure(Array.isArray(reds) && reds.length === 6 && new Set(reds).size === 6
    && reds.every(n => Number.isInteger(n) && n >= 1 && n <= 33));
  ensure(typeof record.blueBall === 'number' && Number.isInteger(record.blueBall) && record.blueBall >= 1 && record.blueBall <= 16);
  return { redBalls: [...reds].sort((a, b) => a - b), blueBall: record.blueBall };
}
export function validateDraw(value: unknown): PublicDraw {
  const record = object(value);
  ticket(value);
  ensure(issue(record.issue) && date(record.drawDate) && String(record.issue).slice(0, 4) === String(record.drawDate).slice(0, 4));
  ensure(nullableMoney(record.salesAmountYuan) && nullableMoney(record.prizePoolAmountYuan));
  ensure(typeof record.isPrizeDetailComplete === 'boolean' && Array.isArray(record.prizeGrades));
  const seen = new Set<number>();
  for (const item of record.prizeGrades) {
    const grade = object(item);
    ensure(typeof grade.grade === 'number' && Number.isInteger(grade.grade) && grade.grade >= 1 && grade.grade <= 7 && !seen.has(grade.grade));
    seen.add(grade.grade);
    ensure(grade.winningTicketCount === null || (typeof grade.winningTicketCount === 'number'
      && Number.isSafeInteger(grade.winningTicketCount) && grade.winningTicketCount >= 0));
    ensure(nullableMoney(grade.prizePerTicketYuan));
  }
  return { ...(value as PublicDraw), ...ticket(value) };
}
export function validateRecommendation(value: unknown): Recommendation {
  const record = object(value);
  ensure(positiveId(record.id) && issue(record.targetIssue) && hash(record.contentHash));
  ensure(record.targetDrawDate === null || date(record.targetDrawDate));
  ensure(record.generationDeadline === null || timestamp(record.generationDeadline));
  ensure(record.sourceLatestIssue === null || issue(record.sourceLatestIssue));
  ensure(text(record.strategyName) && text(record.strategyVersion) && timestamp(record.generatedAt));
  object(record.strategyParams);
  ensure(typeof record.seed === 'number' && Number.isSafeInteger(record.seed) && record.seed >= 0 && record.seed <= 0xffffffff);
  ensure(Array.isArray(record.tickets) && record.tickets.length > 0 && record.tickets.length <= 100);
  record.tickets.forEach(ticket);
  // 原件号码与顺序原样保留，不重排原件字段或在客户端宣称SHA-256校验已完成。
  return value as Recommendation;
}
export function validateNext(value: unknown): NextRecommendation {
  const record = object(value);
  ensure(['not_generated', 'available', 'closed', 'awaiting_draw'].includes(String(record.status)));
  ensure(record.reason === null || typeof record.reason === 'string');
  ensure(record.sourceLatestIssue === null || issue(record.sourceLatestIssue));
  ensure(record.generationDeadline === null || timestamp(record.generationDeadline));
  if (record.nextDraw !== null) {
    const next = object(record.nextDraw);
    ensure(issue(next.issue) && date(next.drawDate) && next.drawTimeBeijing === '21:15');
    if (record.recommendation !== null) {
      const recommendation = validateRecommendation(record.recommendation);
      ensure(recommendation.targetIssue === next.issue && recommendation.targetDrawDate === next.drawDate
        && recommendation.generationDeadline === record.generationDeadline && recommendation.sourceLatestIssue === record.sourceLatestIssue);
    }
  } else ensure(record.recommendation === null);
  if (record.status === 'available') ensure(record.recommendation !== null);
  return value as NextRecommendation;
}
function verificationRecord(value: unknown, recommendation: Recommendation): VerificationRecord {
  const record = object(value);
  ensure(positiveId(record.id) && record.recommendationId === recommendation.id && hash(record.drawFingerprint) && timestamp(record.verifiedAt));
  const result = object(record.result);
  ensure(text(result.definitionVersion) && result.recommendationContentHash === recommendation.contentHash
    && result.targetIssue === recommendation.targetIssue && date(result.targetDrawDate));
  ensure(result.formalRoi === null && nullableMoney(result.announcedPrizeReplayYuan) && texts(result.limitations));
  const audit = object(result.payoutAudit);
  ensure(typeof audit.eligible === 'boolean' && typeof audit.fortuneActive === 'boolean' && texts(audit.withheldReasons));
  ensure(Array.isArray(result.outcomes) && result.outcomes.length === recommendation.tickets.length);
  for (const item of result.outcomes) {
    const outcome = object(item);
    ensure(typeof outcome.redHits === 'number' && Number.isInteger(outcome.redHits) && outcome.redHits >= 0 && outcome.redHits <= 6
      && typeof outcome.blueHit === 'boolean' && [1, 2, 3, 4, 5, 6, 'fortune', 'none'].includes(outcome.grade as number | string)
      && nullableMoney(outcome.prizeYuan));
  }
  return value as VerificationRecord;
}
export function validateVerification(value: unknown): VerificationView {
  const record = object(value);
  const recommendation = validateRecommendation(record.recommendation);
  ensure(Array.isArray(record.versions));
  record.versions.forEach(item => verificationRecord(item, recommendation));
  if (record.latest !== null) {
    const latest = verificationRecord(record.latest, recommendation);
    ensure(record.versions.some(item => object(item).id === latest.id && object(item).drawFingerprint === latest.drawFingerprint));
  }
  // 当前latest由服务器按当前指纹匹配；禁止以versions[0]替代。
  return value as VerificationView;
}
/** 计数必须互相吻合；空样本平均值必须为null，非空必须与总数一致，避免假零或拼凑数据。 */
export function validateRecommendationSummary(value: unknown): RecommendationSummary {
  const record = object(value);
  const issues = object(record.issues), tickets = object(record.tickets), theoretical = object(record.theoretical), payout = object(record.payout);
  ensure(text(record.definitionVersion) && integer(record.recommendationCount) && texts(record.limitations));
  ensure(integer(issues.verified) && integer(issues.awaitingDraw) && integer(issues.awaitingVerification)
    && issues.verified + issues.awaitingDraw + issues.awaitingVerification === record.recommendationCount);
  const count = tickets.verifiedTicketCount;
  ensure(integer(count) && integer(tickets.totalRedHits, 0, Number(count) * 6) && integer(tickets.blueHitCount, 0, Number(count)));
  ensure(count === 0 ? tickets.averageRedHits === null && tickets.blueHitRate === null
    : tickets.averageRedHits === Number(tickets.totalRedHits) / count && tickets.blueHitRate === Number(tickets.blueHitCount) / count);
  const distribution = tickets.redHitDistribution;
  ensure(Array.isArray(distribution) && distribution.length === 7 && distribution.every(item => integer(item))
    && distribution.reduce((sum: number, item: number) => sum + item, 0) === count
    && distribution.reduce((sum: number, item: number, hits) => sum + item * hits, 0) === tickets.totalRedHits);
  const prizes = object(tickets.prizeCounts);
  const grades = ['1', '2', '3', '4', '5', '6', 'fortune', 'none'];
  ensure(Object.keys(prizes).length === grades.length && grades.every(grade => integer(prizes[grade]))
    && grades.reduce((sum, grade) => sum + Number(prizes[grade]), 0) === count);
  ensure(finite(theoretical.averageRedHits) && finite(theoretical.blueHitRate));
  ensure(integer(payout.accountedIssueCount) && integer(payout.withheldIssueCount)
    && payout.accountedIssueCount + payout.withheldIssueCount === issues.verified
    && nullableMoney(payout.accountedCostYuan) && payout.accountedCostYuan !== null
    && nullableMoney(payout.announcedPrizeReplayYuan) && payout.announcedPrizeReplayYuan !== null && payout.formalRoi === null);
  return value as RecommendationSummary;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nullableIssue(value: unknown): boolean { return value === null || issue(value); }
function numberStatistics(value: unknown, maximum: number): NumberStatistics[] {
  ensure(Array.isArray(value) && value.length === maximum);
  return value.map((item, index) => {
    const record = object(item);
    ensure(record.number === index + 1 && integer(record.appearanceCount) && finite(record.theoreticalAppearanceRate)
      && finite(record.expectedAppearanceCount) && integer(record.currentOmission) && typeof record.currentOmissionIsLowerBound === 'boolean'
      && integer(record.maximumObservedOmission) && (record.maximumCompleteOmission === null || integer(record.maximumCompleteOmission))
      && (record.appearanceRate === null || finite(record.appearanceRate))
      && (record.averageCompleteOmission === null || finite(record.averageCompleteOmission))
      && ['cold', 'normal', 'hot', 'unavailable'].includes(String(record.heatLabel)) && nullableIssue(record.lastAppearanceIssue));
    return {
      number: record.number, appearanceCount: record.appearanceCount, appearanceRate: record.appearanceRate as number | null,
      theoreticalAppearanceRate: record.theoreticalAppearanceRate, expectedAppearanceCount: record.expectedAppearanceCount,
      currentOmission: record.currentOmission, currentOmissionIsLowerBound: record.currentOmissionIsLowerBound,
      maximumObservedOmission: record.maximumObservedOmission, maximumCompleteOmission: record.maximumCompleteOmission as number | null,
      averageCompleteOmission: record.averageCompleteOmission as number | null, heatLabel: record.heatLabel as HeatLabel,
      lastAppearanceIssue: record.lastAppearanceIssue as string | null,
    };
  });
}
/** 只保留页面使用字段，避免把全量特征分布长期留在内存。 */
export function validateAnalysis(value: unknown): AnalysisReport {
  const record = object(value);
  ensure(text(record.definitionVersion) && timestamp(record.generatedAt) && hash(record.dataFingerprint) && texts(record.warnings));
  ensure((record.requestedWindow === null || integer(record.requestedWindow, 1)) && nullableIssue(record.requestedAsOfIssue));
  ensure(integer(record.sampleDrawCount) && nullableIssue(record.firstIssue) && nullableIssue(record.lastIssue));
  ensure(Array.isArray(record.features) && record.features.length === record.sampleDrawCount);
  let previous = '';
  const features: DrawFeatures[] = record.features.map(item => {
    const row = object(item);
    ensure(issue(row.issue) && String(row.issue) > previous && date(row.drawDate));
    previous = String(row.issue);
    ensure(integer(row.redSum, 21, 183) && integer(row.redSpan, 5, 32) && integer(row.redOddCount, 0, 6) && integer(row.acValue, 0, 10)
      && (row.repeatedRedCount === null || integer(row.repeatedRedCount, 0, 6)) && integer(row.blueBall, 1, 16)
      && (row.blueAmplitude === null || integer(row.blueAmplitude, 0, 15)));
    return { issue: row.issue as string, drawDate: row.drawDate as string, redSum: row.redSum, redSpan: row.redSpan, redOddCount: row.redOddCount,
      acValue: row.acValue, repeatedRedCount: row.repeatedRedCount as number | null, blueBall: row.blueBall, blueAmplitude: row.blueAmplitude as number | null };
  });
  ensure(record.firstIssue === (features[0]?.issue ?? null) && record.lastIssue === (features[features.length - 1]?.issue ?? null));
  return {
    definitionVersion: record.definitionVersion, requestedWindow: record.requestedWindow as number | null,
    requestedAsOfIssue: record.requestedAsOfIssue as string | null, sampleDrawCount: record.sampleDrawCount,
    firstIssue: record.firstIssue as string | null, lastIssue: record.lastIssue as string | null, generatedAt: record.generatedAt as string,
    dataFingerprint: record.dataFingerprint as string, warnings: record.warnings as string[],
    redNumbers: numberStatistics(record.redNumbers, 33), blueNumbers: numberStatistics(record.blueNumbers, 16), features,
  };
}

function interval(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]) && value[0] <= value[1];
}
function nullableObject(value: unknown): Record<string, unknown> | null { return value === null ? null : object(value); }
export function validateBacktest(value: unknown): BacktestRun {
  const record = object(value);
  ensure(positiveId(record.id) && text(record.strategyName) && text(record.strategyVersion) && text(record.seed) && /^\d+$/.test(record.seed));
  ensure(integer(record.ticketsPerIssue, 1, 100) && issue(record.evaluationStartIssue) && issue(record.evaluationEndIssue));
  ensure(typeof record.usesFinalHoldout === 'boolean' && ['running', 'succeeded', 'failed'].includes(String(record.status)));
  ensure(timestamp(record.startedAt) && (record.finishedAt === null || timestamp(record.finishedAt)));
  const summary = nullableObject(record.summary);
  if (summary !== null) {
    ensure(summary.formalRoiAvailable === false && (summary.definitionVersion === null || text(summary.definitionVersion))
      && (summary.dataFingerprint === null || hash(summary.dataFingerprint)));
    const coverage = nullableObject(summary.coverage);
    if (coverage) ensure(issue(coverage.trainingFirstIssue) && issue(coverage.evaluationFirstIssue) && issue(coverage.evaluationLastIssue) && integer(coverage.evaluatedIssues));
    const audit = nullableObject(summary.payoutAudit);
    if (audit) ensure(integer(audit.eligibleIssues) && Array.isArray(audit.withheldIssues));
    const distributions = nullableObject(summary.distributions);
    for (const item of Object.values(distributions ?? {})) {
      const metric = object(item);
      // 早期已保存汇总只有均值/标准差/区间；中位数与极值缺失时显示未提供，存在则必须是有限数。
      ensure(finite(metric.mean) && finite(metric.standardDeviation)
        && ['median', 'minimum', 'maximum'].every(key => metric[key] === undefined || finite(metric[key]))
        && interval(metric.outcomeInterval95) && (metric.monteCarloMeanInterval95 === null || interval(metric.monteCarloMeanInterval95)));
    }
    const calibration = nullableObject(summary.calibration);
    if (calibration) ensure(finite(calibration.theoreticalAverageRedHits) && finite(calibration.theoreticalBlueHitRate)
      && (calibration.firstRunRedTailP === null || finite(calibration.firstRunRedTailP))
      && (calibration.firstRunBlueTailP === null || finite(calibration.firstRunBlueTailP)));
  }
  // 成功记录必须有汇总；运行中/失败记录有无汇总都不画指标。
  if (record.status === 'succeeded') ensure(summary !== null);
  return value as BacktestRun;
}

export function validateTicketCheck(value: unknown, submitted: Ticket): TicketCheckResult {
  const record = object(value);
  const checked = ticket(record.ticket);
  ensure(checked.blueBall === submitted.blueBall && checked.redBalls.join() === [...submitted.redBalls].sort((a, b) => a - b).join());
  const features = object(record.features);
  const counts = (item: unknown, length: number) => Array.isArray(item) && item.length === length && item.every(count => integer(count, 0, 6));
  ensure(integer(features.redSum, 21, 183) && integer(features.redSpan, 5, 32) && integer(features.acValue, 0, 10)
    && integer(features.redOddCount, 0, 6) && integer(features.redEvenCount, 0, 6) && Number(features.redOddCount) + Number(features.redEvenCount) === 6
    && integer(features.redSmallCount, 0, 6) && integer(features.redLargeCount, 0, 6) && Number(features.redSmallCount) + Number(features.redLargeCount) === 6
    && counts(features.redZoneCounts, 3) && counts(features.redTailCounts, 10)
    && integer(features.consecutiveGroupCount, 0, 3) && integer(features.consecutivePairCount, 0, 5)
    && features.blueBall === submitted.blueBall && typeof features.blueIsOdd === 'boolean' && ['small', 'large'].includes(String(features.blueSize)));
  const theoretical = object(record.theoretical);
  ensure(theoretical.totalSingleTickets === 17721088 && theoretical.jackpotOdds === '1/17721088' && finite(theoretical.jackpotProbability));
  ensure(texts(record.disclaimers));
  return value as TicketCheckResult;
}