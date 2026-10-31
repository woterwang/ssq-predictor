import { api, errorMessage, isIssue, isNotFound } from '../../services/api';
import type { HistoryMatchResult, PublicDraw, Ticket } from '../../types/api';
import { formatBeijingTime } from '../../utils/presentation';

/** 接受空格/逗号/加号/竖线分隔的7个号码：前6个红球，最后1个蓝球。 */
function parseSevenNumbers(input: string): Ticket | string {
  const parts = input.trim().split(/[\s,，、+|｜]+/).filter(Boolean);
  if (parts.length !== 7 || parts.some(part => !/^\d{1,2}$/.test(part))) return '请输入7个号码：前6个红球、最后1个蓝球，用空格分隔。';
  const numbers = parts.map(Number);
  const reds = numbers.slice(0, 6);
  const blue = numbers[6];
  if (reds.some(n => n < 1 || n > 33) || new Set(reds).size !== 6) return '红球须为6个不重复的1–33号码。';
  if (blue < 1 || blue > 16) return '蓝球须为1–16号码。';
  return { redBalls: [...reds].sort((a, b) => a - b), blueBall: blue };
}

function presentMatch(result: HistoryMatchResult) {
  const { coverage, matches } = result;
  const pad = (n: number) => String(n).padStart(2, '0');
  const firstCount = matches.filter(match => match.grade === 1).length;
  return {
    ticketText: `${result.ticket.redBalls.map(pad).join(' ')} | ${pad(result.ticket.blueBall)}`,
    coverageText: coverage.drawCount === 0 ? '服务器尚无收录开奖，无法比对。'
      : `比对范围：第${coverage.firstIssue}期至第${coverage.lastIssue}期，共${coverage.drawCount}期已收录开奖。`,
    summaryText: coverage.drawCount === 0 ? ''
      : matches.length === 0 ? '该组号码在上述范围内未开出过一等奖或二等奖。'
      : `共${matches.length}期符合：一等奖${firstCount}期、二等奖${matches.length - firstCount}期。`,
    rows: matches.map(match => ({ issue: match.issue, drawDate: match.drawDate, redBalls: match.redBalls, blueBall: match.blueBall,
      gradeText: match.grade === 1 ? '一等奖（六红+蓝）' : '二等奖（六红）' })),
    disclaimers: result.disclaimers.slice(0, 2),
  };
}
type MatchView = ReturnType<typeof presentMatch>;

Page({
  requestVersion: 0,
  queryVersion: 0,
  matchVersion: 0,
  disposed: false,
  data: {
    numbersInput: '',
    matching: false,
    matchError: '',
    matchResult: null as MatchView | null,
    draws: [] as PublicDraw[],
    beforeIssue: null as string | null,
    hasMore: false,
    loaded: false,
    refreshing: false,
    loadingMore: false,
    error: '',
    lastUpdated: '',
    paginationNote: '',
    issueInput: '',
    searching: false,
    queryError: '',
  },
  onLoad() { void this.refresh(); },
  onUnload() {
    this.disposed = true;
    this.requestVersion += 1;
    this.queryVersion += 1;
    this.matchVersion += 1;
  },
  async onPullDownRefresh() {
    await this.refresh();
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  onReachBottom() { void this.loadMore(); },
  refresh() { return this.loadDraws(true); },
  loadMore() { return this.loadDraws(false); },
  async loadDraws(refresh: boolean) {
    if (this.disposed || this.data.refreshing || (!refresh && (this.data.loadingMore || !this.data.hasMore))) return;
    // 刷新可以取代在途追加；旧追加的响应与finally均不得覆盖刷新。
    const version = ++this.requestVersion;
    const cursor = refresh ? null : this.data.beforeIssue;
    this.setData({ refreshing: refresh, loadingMore: !refresh, error: '' });
    try {
      const envelope = await api.listDraws(cursor);
      if (this.disposed || version !== this.requestVersion) return;
      const received = envelope.data;
      if (received.length > 20 || (cursor !== null && received.some(draw => draw.issue >= cursor))) {
        throw new Error('开奖分页响应不符合排除式游标');
      }
      const candidate = envelope.pagination?.nextBeforeIssue;
      const cursorValid = typeof candidate === 'string' && isIssue(candidate)
        && received.length > 0 && candidate === received[received.length - 1].issue
        && (cursor === null || candidate < cursor);
      // 限制为服务端20条分页，绝不通过逐条详情请求填充列表。
      const hasMore = received.length === 20 && cursorValid;
      const merged = new Map<string, PublicDraw>();
      for (const draw of refresh ? [] : this.data.draws) merged.set(draw.issue, draw);
      for (const draw of received) merged.set(draw.issue, draw);
      const draws = [...merged.values()].sort((left, right) => right.issue.localeCompare(left.issue));
      this.setData({
        draws,
        beforeIssue: cursorValid ? candidate : null,
        hasMore,
        loaded: true,
        lastUpdated: formatBeijingTime(new Date().toISOString()),
        paginationNote: received.length === 20 && !cursorValid && candidate !== null
          ? '分页游标缺失或未前进，已停止追加；可刷新重试。' : '',
      });
    } catch (error) {
      // 不清空旧列表、旧游标与hasMore，允许用户重试同一页。
      if (!this.disposed && version === this.requestVersion) this.setData({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ refreshing: false, loadingMore: false });
    }
  },
  onIssueChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.queryVersion += 1;
    this.setData({ issueInput: event.detail.value, searching: false, queryError: '' });
  },
  onNumbersChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    // 编辑即作废在途请求与旧结果，避免把上一组号码的结果当作当前输入。
    this.matchVersion += 1;
    this.setData({ numbersInput: event.detail.value, matching: false, matchError: '', matchResult: null });
  },
  async matchNumbers() {
    if (this.disposed || this.data.matching) return;
    const parsed = parseSevenNumbers(this.data.numbersInput);
    if (typeof parsed === 'string') {
      this.setData({ matchError: parsed, matchResult: null });
      return;
    }
    const version = ++this.matchVersion;
    this.setData({ matching: true, matchError: '', matchResult: null });
    try {
      const { data } = await api.matchHistory(parsed);
      if (!this.disposed && version === this.matchVersion) this.setData({ matchResult: presentMatch(data) });
    } catch (error) {
      if (!this.disposed && version === this.matchVersion) this.setData({ matchError: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.matchVersion) this.setData({ matching: false });
    }
  },
  async findIssue() {
    if (this.disposed || this.data.searching) return;
    const issue = this.data.issueInput.trim();
    if (!isIssue(issue)) {
      this.setData({ queryError: '请输入有效的7位期号，例如年份加3位期次；期次不能为000。' });
      return;
    }
    const version = ++this.queryVersion;
    this.setData({ searching: true, queryError: '' });
    try {
      const { data: draw } = await api.getDraw(issue);
      if (this.disposed || version !== this.queryVersion) return;
      if (draw.issue !== issue) throw new Error('精确查询响应期号不一致');
      // 精确查询先由API确认收录，再进入会独立刷新数据的详情页。
      wx.navigateTo({ url: `/pages/draw-detail/index?issue=${draw.issue}` });
    } catch (error) {
      if (!this.disposed && version === this.queryVersion) {
        this.setData({ queryError: isNotFound(error) ? '尚未收录该期；可能待开奖、待同步或超出可用历史范围。' : errorMessage(error) });
      }
    } finally {
      if (!this.disposed && version === this.queryVersion) this.setData({ searching: false });
    }
  },
  openDraw(event: WechatMiniprogram.CustomEvent) {
    const issue: unknown = event.currentTarget.dataset.issue;
    if (typeof issue === 'string' && isIssue(issue)) wx.navigateTo({ url: `/pages/draw-detail/index?issue=${issue}` });
  },
});