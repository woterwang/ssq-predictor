import { api, errorMessage, isIssue, isNotFound } from '../../services/api';
import type { PublicDraw } from '../../types/api';
import { describeStructure, formatAmount, formatBeijingTime, formatCount, prizeGradeText } from '../../utils/presentation';

interface PrizeRow { grade: number; label: string; countText: string; amountText: string }

/** 仅使用本期号码做局部纯计算，不请求完整统计/特征报告。 */
function presentDraw(draw: PublicDraw) {
  const structure = describeStructure(draw);
  const prizeRows: PrizeRow[] = [];
  // 公开详情仅呈现常规六奖级；缺项显示待公布，不把第7项占位当特别奖。
  const ordinaryGrades = [1, 2, 3, 4, 5, 6] as const;
  for (const grade of ordinaryGrades) {
    const prize = draw.prizeGrades.find(item => item.grade === grade);
    prizeRows.push({
      grade,
      label: prizeGradeText(grade),
      countText: formatCount(prize?.winningTicketCount ?? null),
      amountText: formatAmount(prize?.prizePerTicketYuan ?? null),
    });
  }
  return {
    structure,
    prizeRows,
    salesText: formatAmount(draw.salesAmountYuan),
    poolText: formatAmount(draw.prizePoolAmountYuan),
    completenessText: draw.isPrizeDetailComplete
      ? '接口标记常规奖级中奖注数齐全；金额仍可能待公布。此标记不代表派奖资格、特别奖规则或收益审计已核实。'
      : '接口标记常规奖级中奖注数尚不齐全；缺少的注数或金额均显示待公布，不视作0。',
  };
}

Page({
  requestVersion: 0,
  disposed: false,
  requestedIssue: '',
  data: {
    draw: null as PublicDraw | null,
    structure: null as ReturnType<typeof describeStructure> | null,
    prizeRows: [] as PrizeRow[],
    loading: false,
    error: '',
    notFound: false,
    routeValid: false,
    lastUpdated: '',
    salesText: '',
    poolText: '',
    completenessText: '',
  },
  onLoad(options: Record<string, string | undefined>) {
    const issue = options.issue;
    if (typeof issue !== 'string' || !isIssue(issue)) {
      this.setData({ error: '期号无效，请从历史列表选择，或输入有效的7位期号。' });
      return;
    }
    this.requestedIssue = issue;
    this.setData({ routeValid: true });
    void this.refresh();
  },
  onUnload() { this.disposed = true; this.requestVersion += 1; },
  async onPullDownRefresh() {
    await this.refresh();
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  async refresh() {
    if (this.disposed || this.data.loading || !this.data.routeValid) return;
    const version = ++this.requestVersion;
    this.setData({ loading: true, error: '' });
    try {
      const { data: draw } = await api.getDraw(this.requestedIssue);
      if (this.disposed || version !== this.requestVersion) return;
      if (draw.issue !== this.requestedIssue) throw new Error('响应期号不一致');
      this.setData({ draw, ...presentDraw(draw), notFound: false, lastUpdated: formatBeijingTime(new Date().toISOString()) });
    } catch (error) {
      if (this.disposed || version !== this.requestVersion) return;
      if (isNotFound(error)) {
        this.setData({
          draw: null, structure: null, prizeRows: [], notFound: true,
          lastUpdated: formatBeijingTime(new Date().toISOString()),
        });
      } else {
        this.setData({ error: errorMessage(error) });
      }
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ loading: false });
    }
  },
  openHistory() { wx.switchTab({ url: '/pages/history/index' }); },
});