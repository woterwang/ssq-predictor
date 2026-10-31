import { api, errorMessage } from '../../../services/api';
import type { BacktestRun } from '../../../types/api';
import { formatBeijingTime } from '../../../utils/presentation';
import { runDetail, runListItem } from '../../utils/backtest';

/** 只读已保存汇总：不启动回测、不读服务器报告文件、不做跨模型排行或伪造曲线。 */
Page({
  requestVersion: 0,
  disposed: false,
  runs: new Map<number, BacktestRun>(),
  data: {
    items: [] as ReturnType<typeof runListItem>[],
    selected: null as ReturnType<typeof runDetail> | null,
    beforeId: null as number | null,
    hasMore: false,
    loaded: false,
    refreshing: false,
    loadingMore: false,
    error: '',
    lastUpdated: '',
    paginationNote: '',
  },
  onLoad() { this.runs = new Map(); void this.refresh(); },
  onUnload() { this.disposed = true; this.requestVersion += 1; },
  async onPullDownRefresh() {
    await this.refresh();
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  refresh() { return this.loadRuns(true); },
  loadMore() { return this.loadRuns(false); },
  async loadRuns(refresh: boolean) {
    if (this.disposed || this.data.refreshing || (!refresh && (this.data.loadingMore || !this.data.hasMore))) return;
    const version = ++this.requestVersion;
    const cursor = refresh ? null : this.data.beforeId;
    this.setData({ refreshing: refresh, loadingMore: !refresh, error: '' });
    try {
      const envelope = await api.listBacktests(cursor);
      if (this.disposed || version !== this.requestVersion) return;
      const received = envelope.data;
      if (received.length > 20 || (cursor !== null && received.some(run => run.id >= cursor))) {
        throw new Error('回测分页响应不符合排除式游标');
      }
      const candidate = envelope.pagination?.nextBeforeId;
      const cursorValid = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
        && received.length > 0 && candidate === received[received.length - 1].id && (cursor === null || candidate < cursor);
      const runs = refresh ? new Map<number, BacktestRun>() : new Map(this.runs);
      for (const run of received) runs.set(run.id, run);
      this.runs = runs;
      const ordered = [...runs.values()].sort((left, right) => right.id - left.id);
      // 刷新后保留原选择（若仍存在），否则默认最新一条；失败/进行中也可选中查看状态。
      const selectedId = this.data.selected && runs.has(this.data.selected.id) ? this.data.selected.id : ordered[0]?.id;
      const selectedRun = selectedId === undefined ? undefined : runs.get(selectedId);
      this.setData({
        items: ordered.map(runListItem),
        selected: selectedRun ? runDetail(selectedRun) : null,
        beforeId: cursorValid ? candidate : null,
        hasMore: received.length === 20 && cursorValid,
        loaded: true,
        lastUpdated: formatBeijingTime(new Date().toISOString()),
        paginationNote: received.length === 20 && !cursorValid && candidate !== null ? '分页游标缺失或未前进，已停止追加；可刷新重试。' : '',
      });
    } catch (error) {
      if (!this.disposed && version === this.requestVersion) this.setData({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ refreshing: false, loadingMore: false });
    }
  },
  selectRun(event: WechatMiniprogram.CustomEvent) {
    const run = this.runs.get(Number(event.currentTarget.dataset.id));
    if (!run) return;
    this.setData({ selected: runDetail(run) });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  openStrategy() { wx.navigateTo({ url: '/research/pages/strategy/index' }); },
});
