/**
 * 开奖序列校验（跨记录）
 *
 * 单条记录合法不代表整体数据完整，这里检查记录之间的关系：
 * 1. 年份缺失：首尾年份之间某一年完全没有数据；
 * 2. 年内期号缺失：某年 001 到该年已有最大序号之间有空缺；
 * 3. 年末可能缺期：某年最后一期之后，按开奖日历当年仍有开奖日（只检查已有下一年数据的年份）；
 * 4. 日期顺序：按期号排序后，开奖日期必须严格递增。
 *
 * 第 3 项按“周二、四、日开奖”推算；若早年开奖日规则不同，可能产生误报，因此只提示“可能缺期”。
 */
import { findNextScheduledDrawDate, type SalesSuspensionPeriod } from '../calendar/drawCalendar';

/** 校验所需的最少字段 */
export interface DrawIssueAndDate {
  issue: string;
  drawDate: string;
}

/** 序列问题 */
export interface DrawSequenceProblem {
  problemType: 'missing_year' | 'missing_issue' | 'possible_missing_year_end' | 'date_not_increasing';
  /** 涉及的期号：缺失的期号、年末可能缺失的第一期、或日期有问题的期号；缺失整年时为 null */
  issue: string | null;
  message: string;
}

/**
 * 生成期号，如 (2026, 5) → 2026005。
 */
function buildIssue(year: number, sequenceInYear: number): string {
  return `${year}${String(sequenceInYear).padStart(3, '0')}`;
}

/**
 * 检查开奖序列的完整性与顺序，返回发现的全部问题（无问题时返回空数组）。
 * @param suspensionPeriods 停售期，用于年末缺期检查
 */
export function findDrawSequenceProblems(
  draws: readonly DrawIssueAndDate[],
  suspensionPeriods: readonly SalesSuspensionPeriod[] = [],
): DrawSequenceProblem[] {
  const problems: DrawSequenceProblem[] = [];
  if (draws.length === 0) {
    return problems;
  }

  // 期号格式固定为 7 位数字，按字符串排序即按期号先后排序
  const sortedDraws = [...draws].sort((left, right) => left.issue.localeCompare(right.issue));

  // 按年份归集年内序号，并记录每年最后一期（已按期号升序，后出现的覆盖先出现的）
  const sequenceNumbersByYear = new Map<number, Set<number>>();
  const lastDrawByYear = new Map<number, DrawIssueAndDate>();
  for (const draw of sortedDraws) {
    const issueYear = Number(draw.issue.slice(0, 4));
    const sequenceInYear = Number(draw.issue.slice(4));
    const sequenceNumbers = sequenceNumbersByYear.get(issueYear) ?? new Set<number>();
    sequenceNumbers.add(sequenceInYear);
    sequenceNumbersByYear.set(issueYear, sequenceNumbers);
    lastDrawByYear.set(issueYear, draw);
  }

  // 1. 年份缺失
  const firstYear = Number(sortedDraws[0].issue.slice(0, 4));
  const lastYear = Number(sortedDraws[sortedDraws.length - 1].issue.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year++) {
    if (!sequenceNumbersByYear.has(year)) {
      problems.push({ problemType: 'missing_year', issue: null, message: `${year} 年没有任何开奖数据` });
    }
  }

  // 2. 年内期号缺失
  for (const [year, sequenceNumbers] of sequenceNumbersByYear) {
    const maxSequenceInYear = Math.max(...sequenceNumbers);
    for (let sequenceInYear = 1; sequenceInYear <= maxSequenceInYear; sequenceInYear++) {
      if (!sequenceNumbers.has(sequenceInYear)) {
        const missingIssue = buildIssue(year, sequenceInYear);
        problems.push({ problemType: 'missing_issue', issue: missingIssue, message: `缺少期号 ${missingIssue}` });
      }
    }
  }

  // 3. 年末可能缺期：只检查不是最后一年的年份（最后一年可能尚未结束）
  for (const [year, lastDrawOfYear] of lastDrawByYear) {
    if (year === lastYear) {
      continue;
    }
    const nextScheduledDrawDate = findNextScheduledDrawDate(lastDrawOfYear.drawDate, suspensionPeriods);
    if (nextScheduledDrawDate.slice(0, 4) === String(year)) {
      const possiblyMissingIssue = buildIssue(year, Number(lastDrawOfYear.issue.slice(4)) + 1);
      problems.push({
        problemType: 'possible_missing_year_end',
        issue: possiblyMissingIssue,
        message:
          `${year} 年最后一期为 ${lastDrawOfYear.issue}（${lastDrawOfYear.drawDate}），` +
          `但 ${nextScheduledDrawDate} 按日历仍应开奖，可能缺少 ${possiblyMissingIssue} 起的年末数据（若当年开奖日规则不同或有停售，可忽略）`,
      });
    }
  }

  // 4. 日期必须随期号严格递增（日期格式为 YYYY-MM-DD，可直接按字符串比较）
  for (let index = 1; index < sortedDraws.length; index++) {
    const previousDraw = sortedDraws[index - 1];
    const currentDraw = sortedDraws[index];
    if (currentDraw.drawDate <= previousDraw.drawDate) {
      problems.push({
        problemType: 'date_not_increasing',
        issue: currentDraw.issue,
        message: `期号 ${currentDraw.issue}（${currentDraw.drawDate}）的日期不晚于上一期 ${previousDraw.issue}（${previousDraw.drawDate}）`,
      });
    }
  }

  return problems;
}
