/**
 * 单式票奖级与保守奖金回放。
 * 官方依据：https://www.cwl.gov.cn/c/2026/01/29/493452.shtml 第17/18/28/29条。
 * 福运奖结束公告：https://www.cwl.gov.cn/c/2026/07/02/659473.shtml。
 * 历史派奖活动可能有票型/金额门槛，不能由现行一般规则推断活动资格。
 */
import type { BacktestDraw, DrawPayoutPolicy, LotteryTicket, PrizeGrade } from './backtestTypes';

export const PRIZE_GRADES: readonly PrizeGrade[] = [1, 2, 3, 4, 5, 6, 'fortune', 'none'];
export const PRIZE_RULE_VERSION = 'single-ticket-ordinary-fortune-2026-v1';
export const TICKET_PRICE_YUAN = 2;

export function assertLegalTicket(ticket: LotteryTicket): void {
  if (ticket.redBalls.length !== 6 || new Set(ticket.redBalls).size !== 6
    || ticket.redBalls.some(ball => !Number.isInteger(ball) || ball < 1 || ball > 33)
    || !Number.isInteger(ticket.blueBall) || ticket.blueBall < 1 || ticket.blueBall > 16) {
    throw new Error('单式票须为6个不重复的1–33红球及1个1–16蓝球');
  }
}

/** 先判高奖级。六等奖实际仅剩0/1/2红+蓝；福运奖实际仅剩3红且错蓝。 */
export function determinePrizeGrade(redHits: number, blueHit: boolean, fortuneActive: boolean): PrizeGrade {
  if (!Number.isInteger(redHits) || redHits < 0 || redHits > 6) throw new Error('红球命中数须为0–6整数');
  if (redHits === 6) return blueHit ? 1 : 2;
  if (redHits === 5) return blueHit ? 3 : 4;
  if (redHits === 4) return blueHit ? 4 : 5;
  if (redHits === 3 && blueHit) return 5;
  if (blueHit) return 6;
  if (redHits === 3 && fortuneActive) return 'fortune';
  return 'none';
}

export function countTicketHits(ticket: LotteryTicket, draw: LotteryTicket): { redHits: number; blueHit: boolean } {
  return { redHits: ticket.redBalls.filter(ball => draw.redBalls.includes(ball)).length, blueHit: ticket.blueBall === draw.blueBall };
}

function optionalAmount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * 先审计整期，不以某次模拟是否中大奖决定是否放行。
 * 2026福运奖只接受已核实窗口且原文金额为5元，未来规则须另加版本，不自动外推。
 */
export function buildDrawPayoutPolicy(draw: BacktestDraw): DrawPayoutPolicy {
  const reasons: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(draw.rawRecordJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('原文非对象');
    raw = parsed as Record<string, unknown>;
    if (Object.keys(raw).length === 0) reasons.push('缺少原始公告，无法审计历史活动说明');
  } catch { reasons.push('原始公告JSON无效'); }
  const fortuneActive = draw.issue >= '2026014' && draw.issue <= '2026075';
  const fortuneAmount = optionalAmount(raw.fyjMoney);
  if (fortuneActive && fortuneAmount !== 5) reasons.push('已核实福运奖窗口内缺少5元奖金原文');
  if (!fortuneActive && fortuneAmount !== null) reasons.push('核实窗口外出现福运奖字段，须重新核实适用规则');
  if (/含加奖|含派奖/.test(draw.rawRecordJson)
    || ['addmoney', 'addmoney2', 'z2add', 'm2add'].some(key => raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== '')) {
    reasons.push('历史加奖/派奖资格未核实，暂停整期收益核算');
  }
  const amounts: DrawPayoutPolicy['amounts'] = { none: 0 };
  for (const grade of [1, 2, 3, 4, 5, 6] as const) {
    const entries = draw.prizeGrades.filter(detail => detail.grade === grade);
    const amount = entries[0]?.prizePerTicketYuan;
    if (entries.length !== 1 || amount === null || amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
      reasons.push(`第${grade}奖级公告奖金缺失/无效（未中出浮动奖不能用0元代替）`);
    } else amounts[grade] = amount;
  }
  if (fortuneActive && fortuneAmount === 5) amounts.fortune = 5;
  return { fortuneActive, eligible: reasons.length === 0, withheldReasons: reasons, amounts };
}