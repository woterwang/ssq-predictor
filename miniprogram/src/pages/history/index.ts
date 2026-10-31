import { api, errorMessage, isIssue, isNotFound } from '../../services/api';
import type { PublicDraw } from '../../types/api';
import { formatBeijingTime } from '../../utils/presentation';

Page({
  requestVersion: 0,
  queryVersion: 0,
  disposed: false,
  data: {
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