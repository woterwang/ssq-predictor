/** 独立的常规公告奖金回放，不替代 backtest/prizeRules 的严格收益审计。 */
import type { BacktestDraw, LotteryTicket, PrizeGrade } from '../backtest/backtestTypes';
import { assertLegalTicket, countTicketHits, determinePrizeGrade, TICKET_PRICE_YUAN } from '../backtest/prizeRules';

export const ORDINARY_REPLAY_DEFINITION_VERSION = 'ordinary-prize-replay-v1' as const;

export const ORDINARY_REPLAY_LIMITATIONS: readonly string[] = [
  '仅按常规1–6奖级的公告单注金额进行税前回放，排除额外加奖、派奖与福运奖。',
  '常规公告回放不代表活动资格已核实，不代表实际兑奖或完整收益。',
  '不计算税费，也不模拟新增投注对奖池及单注奖金的稀释；不提供正式ROI。',
];

export interface OrdinaryPrizeReplay {
  definitionVersion: typeof ORDINARY_REPLAY_DEFINITION_VERSION;
  eligible: boolean;
  hasUnverifiedActivity: boolean;
  withheldReasons: string[];
  warnings: string[];
  costYuan: number;
  announcedPrizeReplayYuan: number | null;
  outcomes: Array<{
    redHits: number;
    blueHit: boolean;
    grade: Exclude<PrizeGrade, 'fortune'>;
    prizeYuan: number | null;
  }>;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

/** 与严格规则一致：0、false 等非空内容也表示字段存在，而非认定活动已核实。 */
function hasNonEmptyValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * 先审计整期全部常规奖级，再逐注回放；不能按是否中奖选择可核算样本。
 * 只读取入参，不访问配置、数据库，也不推断任何特别活动资格。
 */
export function buildOrdinaryPrizeReplay(draw: BacktestDraw, tickets: readonly LotteryTicket[]): OrdinaryPrizeReplay {
  assertLegalTicket(draw);
  for (const ticket of tickets) assertLegalTicket(ticket);

  const withheldReasons: string[] = [];
  const warnings = [...ORDINARY_REPLAY_LIMITATIONS];
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(draw.rawRecordJson);
    if (isNonEmptyRecord(parsed)) raw = parsed;
    else withheldReasons.push('原始公告须为非空JSON对象，无法审计常规公告奖金。');
  } catch {
    withheldReasons.push('原始公告JSON为空或无效，无法审计常规公告奖金。');
  }

  // 检查全文，与旧规则保持同一文字边界，不能擅自从公告奖金中扣除加奖。
  const containsActivityText = /含加奖|含派奖/.test(draw.rawRecordJson);
  if (containsActivityText) {
    withheldReasons.push('原始公告标注“含加奖/含派奖”，不能确认公告金额是否混入加奖或派奖，不擅自扣除，暂停整期常规金额回放。');
    warnings.push('公告中的加奖/派奖金额及活动资格未核实，额外活动不纳入常规回放。');
  }
  const activityFields = ['addmoney', 'addmoney2', 'z2add', 'm2add'].filter(key => hasNonEmptyValue(raw[key]));
  if (activityFields.length > 0) {
    warnings.push(`原始公告存在非空加奖/派奖字段（${activityFields.join('、')}，含0值也作标记）；活动资格未核实，额外活动金额不计入，不单独阻止常规公告回放。`);
  }

  // 这里只识别福运奖风险并排除，绝不复用严格规则的资格及5元金额核验。
  const inFortuneWindow = draw.issue >= '2026014' && draw.issue <= '2026075';
  const hasFortuneAmount = hasNonEmptyValue(raw.fyjMoney);
  if (inFortuneWindow) {
    warnings.push('本期处于福运奖核实窗口（2026014–2026075），本回放不核实其活动资格或奖金，明确排除福运奖。');
  }
  if (hasFortuneAmount) {
    warnings.push('原始公告含非空fyjMoney字段（含0值），其奖金及活动资格未核实，福运奖金额不计入常规回放。');
  }

  const amounts: Record<Exclude<PrizeGrade, 'fortune'>, number | null> = {
    1: null, 2: null, 3: null, 4: null, 5: null, 6: null, none: 0,
  };
  for (const grade of [1, 2, 3, 4, 5, 6] as const) {
    const entries = draw.prizeGrades.filter(detail => detail.grade === grade);
    const amount = entries[0]?.prizePerTicketYuan;
    if (entries.length !== 1 || amount === null || amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
      withheldReasons.push(`第${grade}奖级须恰有1条公告奖金且金额为正安全整数；缺失、重复、0元或无效金额均暂停整期回放，不按本次是否中奖放行。`);
    } else amounts[grade] = amount;
  }

  const eligible = withheldReasons.length === 0;
  const outcomes: OrdinaryPrizeReplay['outcomes'] = tickets.map(ticket => {
    const { redHits, blueHit } = countTicketHits(ticket, draw);
    const grade = determinePrizeGrade(redHits, blueHit, false);
    // 显式收窄类型；将来判奖规则变化时也不允许特别奖悄悄进入此接口。
    if (grade === 'fortune') throw new Error('常规公告回放不得包含福运奖');
    return { redHits, blueHit, grade, prizeYuan: eligible ? amounts[grade] : null };
  });

  return {
    definitionVersion: ORDINARY_REPLAY_DEFINITION_VERSION,
    eligible,
    hasUnverifiedActivity: containsActivityText || activityFields.length > 0 || inFortuneWindow || hasFortuneAmount,
    withheldReasons,
    warnings,
    costYuan: tickets.length * TICKET_PRICE_YUAN,
    announcedPrizeReplayYuan: eligible ? outcomes.reduce((sum, outcome) => sum + (outcome.prizeYuan ?? 0), 0) : null,
    outcomes,
  };
}