import { api, errorMessage } from '../../services/api';
import type { Recommendation } from '../../types/api';
import { formatBeijingTime } from '../../utils/presentation';

interface ArchiveRow {
  id: number;
  targetIssue: string;
  targetDateText: string;
  generatedAtText: string;
  strategyText: string;
  ticketCountText: string;
}

function presentArchive(record: Recommendation): ArchiveRow {
  return {
    id: record.id,
    targetIssue: record.targetIssue,
    targetDateText: record.targetDrawDate ?? '未提供',
    generatedAtText: formatBeijingTime(record.generatedAt),
    strategyText: `${record.strategyName} · ${record.strategyVersion}`,
    ticketCountText: `${record.tickets.length}注固化原件`,
  };
}

Page({
  requestVersion: 0,
  disposed: false,
  data: {
    items: [] as ArchiveRow[],
    beforeId: null as number | null,
    hasMore: false,
    loaded: false,
    refreshing: false,
    loadingMore: false,
    error: '',
    lastUpdated: '',
    paginationNote: '',
  },
  onLoad() { void this.refresh(); },
  onUnload() { this.disposed = true; this.requestVersion += 1; },
  async onPullDownRefresh() {
    await this.refresh();
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  onReachBottom() { void this.loadMore(); },
  refresh() { return this.loadRecords(true); },
  loadMore() { return this.loadRecords(false); },
  async loadRecords(refresh: boolean) {
    if (this.disposed || this.data.refreshing || (!refresh && (this.data.loadingMore || !this.data.hasMore))) return;
    const version = ++this.requestVersion;
    const cursor = refresh ? null : this.data.beforeId;
    this.setData({ refreshing: refresh, loadingMore: !refresh, error: '' });
    try {
      const envelope = await api.listRecommendations(cursor);
      if (this.disposed || version !== this.requestVersion) return;
      const received = envelope.data;
      if (received.length > 20 || (cursor !== null && received.some(record => record.id >= cursor))) {
        throw new Error('推荐分页响应不符合排除式游标');
      }
      const candidate = envelope.pagination?.nextBeforeId;
      const cursorValid = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
        && received.length > 0 && candidate === received[received.length - 1].id
        && (cursor === null || candidate < cursor);
      const merged = new Map<number, ArchiveRow>();
      for (const item of refresh ? [] : this.data.items) merged.set(item.id, item);
      for (const record of received) merged.set(record.id, presentArchive(record));
      this.setData({
        items: [...merged.values()].sort((left, right) => right.id - left.id),
        beforeId: cursorValid ? candidate : null,
        hasMore: received.length === 20 && cursorValid,
        loaded: true,
        lastUpdated: formatBeijingTime(new Date().toISOString()),
        paginationNote: received.length === 20 && !cursorValid && candidate !== null
          ? '分页游标缺失或未前进，已停止追加；可刷新重试。' : '',
      });
    } catch (error) {
      // 失败保持游标及列表；核验只在详情请求，列表无N+1网络访问。
      if (!this.disposed && version === this.requestVersion) this.setData({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ refreshing: false, loadingMore: false });
    }
  },
  openVerification(event: WechatMiniprogram.CustomEvent) {
    const value: unknown = event.currentTarget.dataset.id;
    const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    if (Number.isSafeInteger(id) && id > 0) wx.navigateTo({ url: `/pages/verification/index?id=${id}` });
  },
});