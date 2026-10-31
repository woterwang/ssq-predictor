import { api, errorMessage, isNotFound } from '../../services/api';
import type { NextRecommendation, PublicDraw, Ticket } from '../../types/api';
import { copyText, describeNextStatus, formatBeijingTime, formatTickets } from '../../utils/presentation';

interface HomeTicketRow extends Ticket { ticketKey: string; ticketIndex: number }

Page({
  // 请求代次与销毁标志属于页面实例，不发送给视图层。
  nextRequestVersion: 0,
  drawRequestVersion: 0,
  disposed: false,
  data: {
    next: null as NextRecommendation | null,
    latestDraw: null as PublicDraw | null,
    frozenTickets: [] as HomeTicketRow[],
    nextLoading: false,
    drawLoading: false,
    nextError: '',
    drawError: '',
    nextUpdatedAt: '',
    drawUpdatedAt: '',
    latestEmpty: false,
    statusLabel: '',
    statusMessage: '',
    statusTheme: 'warning',
    targetIssueText: '',
    targetDateText: '',
    deadlineText: '',
    generatedAtText: '',
    sourceIssueText: '',
  },
  onShow() {
    // 返回首页也只发只读请求；正在加载时不重复发起。
    void this.refreshNext();
    void this.refreshLatestDraw();
  },
  onUnload() {
    this.disposed = true;
    this.nextRequestVersion += 1;
    this.drawRequestVersion += 1;
  },
  async onPullDownRefresh() {
    await Promise.all([this.refreshNext(), this.refreshLatestDraw()]);
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  async refreshNext() {
    if (this.disposed || this.data.nextLoading) return;
    const version = ++this.nextRequestVersion;
    this.setData({ nextLoading: true, nextError: '' });
    try {
      const { data: next } = await api.getNext();
      if (this.disposed || version !== this.nextRequestVersion) return;
      const description = describeNextStatus(next);
      this.setData({
        next,
        frozenTickets: (next.recommendation?.tickets ?? []).map((ticket, ticketIndex) => ({
          ...ticket, ticketIndex, ticketKey: `${ticketIndex}-${ticket.redBalls.join('-')}-${ticket.blueBall}`,
        })),
        statusLabel: description.label,
        statusMessage: description.message,
        statusTheme: next.status === 'available' ? 'primary' : 'warning',
        targetIssueText: next.recommendation?.targetIssue ?? next.nextDraw?.issue ?? '服务器未提供目标期号',
        targetDateText: next.recommendation?.targetDrawDate ?? next.nextDraw?.drawDate ?? '未提供',
        deadlineText: formatBeijingTime(next.generationDeadline),
        generatedAtText: formatBeijingTime(next.recommendation?.generatedAt ?? null),
        sourceIssueText: next.sourceLatestIssue ?? '未提供',
        nextUpdatedAt: formatBeijingTime(new Date().toISOString()),
      });
    } catch (error) {
      if (!this.disposed && version === this.nextRequestVersion) this.setData({ nextError: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.nextRequestVersion) this.setData({ nextLoading: false });
    }
  },
  async refreshLatestDraw() {
    if (this.disposed || this.data.drawLoading) return;
    const version = ++this.drawRequestVersion;
    this.setData({ drawLoading: true, drawError: '' });
    try {
      const { data: latestDraw } = await api.getLatestDraw();
      if (this.disposed || version !== this.drawRequestVersion) return;
      this.setData({ latestDraw, latestEmpty: false, drawUpdatedAt: formatBeijingTime(new Date().toISOString()) });
    } catch (error) {
      if (this.disposed || version !== this.drawRequestVersion) return;
      if (isNotFound(error)) {
        this.setData({ latestDraw: null, latestEmpty: true, drawUpdatedAt: formatBeijingTime(new Date().toISOString()) });
      } else {
        this.setData({ drawError: errorMessage(error) });
      }
    } finally {
      if (!this.disposed && version === this.drawRequestVersion) this.setData({ drawLoading: false });
    }
  },
  copyFrozenTickets() {
    const record = this.data.next?.recommendation;
    if (record) copyText(formatTickets(record.targetIssue, record.tickets));
  },
  openVerification() {
    const record = this.data.next?.recommendation;
    if (record) wx.navigateTo({ url: `/pages/verification/index?id=${record.id}` });
  },
  openLatestDraw() {
    const draw = this.data.latestDraw;
    if (draw) wx.navigateTo({ url: `/pages/draw-detail/index?issue=${draw.issue}` });
  },
  openRecommendations() { wx.navigateTo({ url: '/pages/recommendations/index' }); },
  openResearch() { wx.navigateTo({ url: '/research/pages/strategy/index' }); },
});