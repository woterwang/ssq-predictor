/**
 * 开奖记录解析与单条校验
 *
 * 把接口返回的原始记录转换为 DrawRecord，并逐项校验：
 * - 期号：7 位数字，年份不早于 2003，年内序号不小于 1；
 * - 日期：从 "2026-10-29(四)" 中截取日期部分，且必须是真实存在的日期；期号年份与开奖年份一致；
 * - 红球：6 个、互不重复、范围 1–33，入库前升序排列；
 * - 蓝球：1 个、范围 1–16；
 * - 金额与注数：空字符串视为“未公布”（null），其他非数字内容视为错误；
 * - 奖级明细：一至六等奖的中奖注数都已公布才算完整。
 *
 * 任一项出错，整条记录判为无效，并给出全部错误原因（不会只报第一个）。
 */
import {
  BLUE_BALL_COUNT_PER_DRAW,
  BLUE_BALL_MAX,
  BLUE_BALL_MIN,
  FIRST_DRAW_YEAR,
  RED_BALL_COUNT_PER_DRAW,
  RED_BALL_MAX,
  RED_BALL_MIN,
  REQUIRED_PRIZE_GRADES,
  type DrawRecord,
  type PrizeGradeDetail,
} from '../domain/lottery';
import { isValidDateText } from '../utils/time';
import type { CwlDrawNoticeItemRaw } from './cwlApiTypes';

/** 官方数据源标识 */
export const CWL_OFFICIAL_DATA_SOURCE = 'cwl_official';

/** 解析结果：有效时给出记录，无效时给出期号（能识别时）与全部错误原因 */
export type DrawParseResult =
  | { isValid: true; draw: DrawRecord }
  | { isValid: false; issue: string | null; errors: string[] };

/** 号码校验规则 */
interface BallNumberRule {
  /** 用于错误提示的名称，如“红球” */
  label: string;
  minNumber: number;
  maxNumber: number;
  expectedCount: number;
}

const RED_BALL_RULE: BallNumberRule = {
  label: '红球',
  minNumber: RED_BALL_MIN,
  maxNumber: RED_BALL_MAX,
  expectedCount: RED_BALL_COUNT_PER_DRAW,
};

const BLUE_BALL_RULE: BallNumberRule = {
  label: '蓝球',
  minNumber: BLUE_BALL_MIN,
  maxNumber: BLUE_BALL_MAX,
  expectedCount: BLUE_BALL_COUNT_PER_DRAW,
};

/**
 * 解析并校验一条原始开奖记录。
 */
export function parseDrawNoticeItem(
  rawItem: CwlDrawNoticeItemRaw,
  dataSource: string = CWL_OFFICIAL_DATA_SOURCE,
): DrawParseResult {
  const errors: string[] = [];

  const issue = parseIssueNumber(rawItem.code, errors);
  const drawDate = parseDrawDate(rawItem.date, errors);
  const redBalls = parseBallNumbers(rawItem.red, RED_BALL_RULE, errors);
  const blueBalls = parseBallNumbers(rawItem.blue, BLUE_BALL_RULE, errors);
  const salesAmountYuan = parseOptionalAmountYuan(rawItem.sales, '销售额', errors);
  const prizePoolAmountYuan = parseOptionalAmountYuan(rawItem.poolmoney, '奖池金额', errors);
  const prizeGrades = parsePrizeGrades(rawItem.prizegrades, errors);

  // 期号前 4 位是开奖年份，必须与开奖日期的年份一致
  if (issue !== null && drawDate !== null && issue.slice(0, 4) !== drawDate.slice(0, 4)) {
    errors.push(`期号年份与开奖日期不一致：期号 ${issue}，日期 ${drawDate}`);
  }

  if (errors.length > 0 || issue === null || drawDate === null || redBalls === null || blueBalls === null) {
    return { isValid: false, issue, errors };
  }

  return {
    isValid: true,
    draw: {
      issue,
      drawDate,
      redBalls,
      blueBall: blueBalls[0],
      salesAmountYuan,
      prizePoolAmountYuan,
      firstPrizeRegionText: emptyTextToNull(rawItem.content),
      prizeGrades,
      isPrizeDetailComplete: isPrizeDetailComplete(prizeGrades),
      dataSource,
      rawRecordJson: JSON.stringify(rawItem),
    },
  };
}

/**
 * 判断奖级明细是否完整：一至六等奖都存在，且中奖注数均已公布。
 * 一等奖无人中奖时注数为 0，也算已公布。
 */
export function isPrizeDetailComplete(prizeGrades: readonly PrizeGradeDetail[]): boolean {
  return REQUIRED_PRIZE_GRADES.every((requiredGrade) =>
    prizeGrades.some(
      (prizeGrade) => prizeGrade.grade === requiredGrade && prizeGrade.winningTicketCount !== null,
    ),
  );
}

/**
 * 解析期号：必须是 7 位数字，年份不早于 2003，年内序号不小于 1。
 */
function parseIssueNumber(value: unknown, errors: string[]): string | null {
  const issueText = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{7}$/.test(issueText)) {
    errors.push(`期号格式错误：${String(value)}`);
    return null;
  }
  const issueYear = Number(issueText.slice(0, 4));
  const sequenceInYear = Number(issueText.slice(4));
  if (issueYear < FIRST_DRAW_YEAR || sequenceInYear < 1) {
    errors.push(`期号超出合理范围：${issueText}`);
    return null;
  }
  return issueText;
}

/**
 * 解析开奖日期：取开头的 YYYY-MM-DD，并确认是真实存在的日期（排除 2026-02-30 这类值）。
 */
function parseDrawDate(value: unknown, errors: string[]): string | null {
  const dateText = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    errors.push(`开奖日期格式错误：${String(value)}`);
    return null;
  }
  if (!isValidDateText(dateText)) {
    errors.push(`开奖日期不存在：${dateText}`);
    return null;
  }
  return dateText;
}

/**
 * 解析号码字符串（如 "03,11,17,22,23,29"）：校验个数、范围、是否重复，返回升序数组。
 */
function parseBallNumbers(value: unknown, rule: BallNumberRule, errors: string[]): number[] | null {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${rule.label}为空`);
    return null;
  }

  const ballNumbers: number[] = [];
  for (const numberText of value.split(',').map((part) => part.trim())) {
    if (!/^\d{1,2}$/.test(numberText)) {
      errors.push(`${rule.label}含非法内容：${value}`);
      return null;
    }
    ballNumbers.push(Number(numberText));
  }

  if (ballNumbers.length !== rule.expectedCount) {
    errors.push(`${rule.label}个数应为 ${rule.expectedCount}，实际为 ${ballNumbers.length}：${value}`);
    return null;
  }
  if (ballNumbers.some((ballNumber) => ballNumber < rule.minNumber || ballNumber > rule.maxNumber)) {
    errors.push(`${rule.label}超出范围 ${rule.minNumber}–${rule.maxNumber}：${value}`);
    return null;
  }
  if (new Set(ballNumbers).size !== ballNumbers.length) {
    errors.push(`${rule.label}有重复号码：${value}`);
    return null;
  }

  return ballNumbers.sort((left, right) => left - right);
}

/**
 * 解析金额（元）：空值视为未公布返回 null；允许千分位逗号；
 * 允许小数（四舍五入为整数元），其他内容记为错误。
 */
function parseOptionalAmountYuan(value: unknown, fieldLabel: string, errors: string[]): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const amountText = String(value).trim().replace(/,/g, '');
  if (amountText === '') {
    return null;
  }
  // 2013001 等历史记录形如“5250000（含加奖250000）”。前面的数字已含加奖，
  // 2014、2015 年还使用“含派奖”字样。只剥离这两种已验证说明，
  // 其他未知文字仍拒绝，避免误解析金额；派奖适用条件将在收益回测时另行核实。
  const numericAmountText = amountText.replace(/[（(]\s*含(?:加奖|派奖)\s*\d+(?:\.\d+)?\s*[）)]$/, '');
  if (!/^\d+(\.\d+)?$/.test(numericAmountText)) {
    errors.push(`${fieldLabel}格式错误：${String(value)}`);
    return null;
  }
  const amountYuan = Math.round(Number(numericAmountText));
  if (!Number.isSafeInteger(amountYuan)) {
    errors.push(`${fieldLabel}超出安全整数范围：${String(value)}`);
    return null;
  }
  return amountYuan;
}

/**
 * 解析非负整数（如中奖注数、奖级编号）：空值返回 null，其他非整数内容记为错误。
 */
function parseOptionalCount(value: unknown, fieldLabel: string, errors: string[]): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const countText = String(value).trim();
  if (countText === '') {
    return null;
  }
  if (!/^\d+$/.test(countText)) {
    errors.push(`${fieldLabel}格式错误：${String(value)}`);
    return null;
  }
  return Number(countText);
}

/**
 * 解析奖级明细数组：[{ type, typenum, typemoney }, ...] → 按奖级编号升序的 PrizeGradeDetail[]。
 * 官方尚未公布时可能为空数组或缺失，此时返回空数组（记录仍有效，只是奖级明细不完整）。
 */
function parsePrizeGrades(value: unknown, errors: string[]): PrizeGradeDetail[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push('奖级明细格式错误：不是数组');
    return [];
  }

  const prizeGrades: PrizeGradeDetail[] = [];
  for (const rawPrizeGrade of value as unknown[]) {
    if (typeof rawPrizeGrade !== 'object' || rawPrizeGrade === null) {
      errors.push('奖级明细格式错误：数组元素不是对象');
      continue;
    }
    const { type, typenum, typemoney } = rawPrizeGrade as Record<string, unknown>;

    const grade = parseOptionalCount(type, '奖级编号', errors);
    if (grade === null) {
      errors.push('奖级明细缺少奖级编号');
      continue;
    }
    if (prizeGrades.some((existingGrade) => existingGrade.grade === grade)) {
      errors.push(`奖级明细中奖级编号重复：${grade}`);
      continue;
    }

    prizeGrades.push({
      grade,
      winningTicketCount: parseOptionalCount(typenum, `奖级 ${grade} 中奖注数`, errors),
      prizePerTicketYuan: parseOptionalAmountYuan(typemoney, `奖级 ${grade} 单注奖金`, errors),
    });
  }

  return prizeGrades.sort((left, right) => left.grade - right.grade);
}

/**
 * 文本字段：非字符串或空白返回 null，否则返回去掉首尾空白的文本。
 */
function emptyTextToNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmedText = value.trim();
  return trimmedText === '' ? null : trimmedText;
}
