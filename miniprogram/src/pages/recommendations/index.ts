import { api, errorMessage } from '../../services/api';
import type { PrizeGrade, Recommendation, RecommendationSummary } from '../../types/api';
import { formatAmount, formatBeijingTime, prizeGradeText } from '../../utils/presentation';
import { fixed, percent } from '../../utils/analysis';

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

const GRADES: PrizeGrade[] = [1, 2, 3, 4, 5, 6, 'fortune', 'none'];
function presentSummary(summary: RecommendationSummary) {
  const { issues, tickets, theoretical, payout } = summary;
  return {
    statusText: `共${summary.recommendationCount}期档案：已核验${issues.verified}期 · 待开奖${issues.awaitingDraw}期 · 已开奖待核验${issues.awaitingVerification}期`,
    hasSample: tickets.verifiedTicketCount > 0,
    ticketText: `已核验${tickets.verifiedTicketCount}注（仅当前开奖版本）`,
    redText: `平均红球命中 ${fixed(tickets.averageRedHits, 3)}（随机理论 ${fixed(theoretical.averageRedHits, 3)}）`,
    blueText: `蓝球命中率 ${percent(tickets.blueHitRate)}（随机理论 ${percent(theoretical.blueHitRate)}）`,
    distributionText: tickets.redHitDistribution.map((count, hits) => `${hits}红×${count}`).join(' · '),
    prizeText: GRADES.map(grade => `${prizeGradeText(grade)} ${tickets.prizeCounts[String(grade)]}`).join(' · '),
    payoutText: payout.accountedIssueCount > 0
      ? `奖金审计通过${payout.accountedIssueCount}期：成本 ${formatAmount(payout.accountedCostYuan)}，公告税前奖金回放 ${formatAmount(payout.announcedPrizeReplayYuan)}`
      : '暂无奖金审计通过的期，不核算金额',
    withheldText: `暂停核算${payout.withheldIssueCount}期；正式ROI不提供。`,
    limitations: summary.limitations,
  };
}
type SummaryView = ReturnType<typeof presentSummary>;

Page({
  requestVersion: 0,
  summaryVersion: 0,
  disposed: false,
  data: {
    summary: null as SummaryView | null,
    summaryLoading: false,
    summaryError: '',
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
  onUnload() { this.disposed = true; this.requestVersion += 1; this.summaryVersion += 1; },
  async onPullDownRefresh() {
    await this.refresh();
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  onReachBottom() { void this.loadMore(); },
  async refresh() { await Promise.all([this.loadSummary(), this.loadRecords(true)]); },
  loadMore() { return this.loadRecords(false); },
  async loadSummary() {
    if (this.disposed || this.data.summaryLoading) return;
    const version = ++this.summaryVersion;
    this.setData({ summaryLoading: true, summaryError: '' });
    try {
      const envelope = await api.getRecommendationSummary();
      if (!this.disposed && version === this.summaryVersion) this.setData({ summary: presentSummary(envelope.data) });
    } catch (error) {
      // 失败保留上次汇总并提示，不以0或空样本替代。
      if (!this.disposed && version === this.summaryVersion) this.setData({ summaryError: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.summaryVersion) this.setData({ summaryLoading: false });
    }
  },
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