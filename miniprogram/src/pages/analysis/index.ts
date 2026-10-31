import { api, errorMessage, isAnalysisWindow } from '../../services/api';
import type { AnalysisReport, AnalysisWindow } from '../../types/api';
import { formatBeijingTime } from '../../utils/presentation';
import { coverageText, numberDetail, numberRows, WINDOW_TEXT } from '../../utils/analysis';

type BallColor = 'red' | 'blue';
const WINDOW_OPTIONS = (['30', '100', '300', 'all'] as AnalysisWindow[]).map(value => ({ value, label: WINDOW_TEXT[value] }));

/** 统计页只做GET与本地展示；冷热/遗漏是已有样本描述，不改变下一期概率。 */
Page({
  requestVersion: 0,
  disposed: false,
  report: null as AnalysisReport | null,
  data: {
    color: 'red' as BallColor,
    window: '100' as AnalysisWindow,
    windowOptions: WINDOW_OPTIONS,
    loading: false,
    loaded: false,
    error: '',
    lastUpdated: '',
    shownWindowText: '',
    coverage: '',
    generatedText: '',
    warnings: [] as string[],
    rows: [] as ReturnType<typeof numberRows>,
    selected: null as ReturnType<typeof numberDetail> | null,
  },
  onLoad() { void this.load(false); },
  onUnload() { this.disposed = true; this.requestVersion += 1; },
  async onPullDownRefresh() {
    await this.load(true);
    if (!this.disposed) wx.stopPullDownRefresh();
  },
  refresh() { return this.load(true); },
  async load(refresh: boolean) {
    if (this.disposed) return;
    const version = ++this.requestVersion;
    const window = this.data.window;
    this.setData({ loading: true, error: '' });
    try {
      const { data } = await api.getAnalysis(window, refresh);
      if (this.disposed || version !== this.requestVersion) return;
      if (data.requestedWindow !== (window === 'all' ? null : Number(window))) throw new Error('统计窗口与请求不一致');
      this.report = data;
      this.setData({
        loaded: true,
        shownWindowText: WINDOW_TEXT[window],
        coverage: coverageText(data),
        generatedText: formatBeijingTime(data.generatedAt),
        warnings: data.warnings,
        lastUpdated: formatBeijingTime(new Date().toISOString()),
      });
      this.renderColor();
    } catch (error) {
      // 失败保留上次窗口与数据，并在页面标明旧数据所属窗口。
      if (!this.disposed && version === this.requestVersion) this.setData({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ loading: false });
    }
  },
  renderColor() {
    const report = this.report;
    if (!report) return;
    const color = this.data.color;
    this.setData({ rows: numberRows(color === 'red' ? report.redNumbers : report.blueNumbers, color), selected: null });
  },
  chooseColor(event: WechatMiniprogram.CustomEvent) {
    const color: unknown = event.currentTarget.dataset.color;
    if ((color === 'red' || color === 'blue') && color !== this.data.color) {
      this.setData({ color });
      this.renderColor();
    }
  },
  chooseWindow(event: WechatMiniprogram.CustomEvent) {
    const window: unknown = event.currentTarget.dataset.window;
    if (isAnalysisWindow(window) && window !== this.data.window && !this.data.loading) {
      this.setData({ window });
      void this.load(false);
    }
  },
  selectNumber(event: WechatMiniprogram.CustomEvent) {
    const number = Number(event.currentTarget.dataset.number);
    const report = this.report;
    if (!report) return;
    const items = this.data.color === 'red' ? report.redNumbers : report.blueNumbers;
    const item = items.find(entry => entry.number === number);
    if (!item) return;
    this.setData({ selected: this.data.selected?.number === number ? null : numberDetail(item, this.data.color) });
  },
  closeDetail() { this.setData({ selected: null }); },
  openTrend() { wx.navigateTo({ url: `/charts/pages/trend/index?window=${this.data.window}` }); },
  openBacktests() { wx.navigateTo({ url: '/research/pages/backtests/index' }); },
  openStrategy() { wx.navigateTo({ url: '/research/pages/strategy/index' }); },
  openTicketCheck() { wx.navigateTo({ url: '/research/pages/ticket-check/index' }); },
});
