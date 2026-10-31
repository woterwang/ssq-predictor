import { api, errorMessage, isAnalysisWindow } from '../../../services/api';
import type { AnalysisWindow, DrawFeatures } from '../../../types/api';
import { formatBeijingTime } from '../../../utils/presentation';
import { WINDOW_TEXT } from '../../../utils/analysis';

type MetricKey = 'redSum' | 'redSpan' | 'acValue' | 'redOddCount' | 'repeatedRedCount' | 'blueBall' | 'blueAmplitude';
const METRICS: Array<{ key: MetricKey; label: string; color: string; note: string }> = [
  { key: 'redSum', label: '红球和值', color: '#C93648', note: '6个红球相加；均匀开奖理论均值为102。' },
  { key: 'redSpan', label: '红球跨度', color: '#C93648', note: '最大红球减最小红球。' },
  { key: 'acValue', label: 'AC值', color: '#C93648', note: '15个两两正差的不同值个数减5。' },
  { key: 'redOddCount', label: '红球奇数个数', color: '#C93648', note: '0–6；偶数个数为6减此值。' },
  { key: 'repeatedRedCount', label: '与上期重号数', color: '#C93648', note: '与库内紧邻上一期相同的红球数；无可比上期时断线。' },
  { key: 'blueBall', label: '蓝球号码', color: '#2864B7', note: '开奖蓝球号码（1–16）。' },
  { key: 'blueAmplitude', label: '蓝球振幅', color: '#2864B7', note: '与上一期蓝球之差的绝对值；无可比上期时断线。' },
];
const PAGE_SIZE = 100;
const WINDOW_OPTIONS = (['30', '100', '300', 'all'] as AnalysisWindow[]).map(value => ({ value, label: WINDOW_TEXT[value] }));

/** 走势数据来自统计报告的升序features；长样本按100点分页显示，并明示所显示区间。 */
Page({
  requestVersion: 0,
  disposed: false,
  features: [] as DrawFeatures[],
  data: {
    window: '100' as AnalysisWindow,
    windowOptions: WINDOW_OPTIONS,
    metrics: METRICS.map(({ key, label }) => ({ key, label })),
    metric: 'redSum' as MetricKey,
    metricLabel: METRICS[0].label,
    metricNote: METRICS[0].note,
    color: METRICS[0].color,
    end: 0,
    total: 0,
    points: [] as Array<{ issue: string; value: number | null }>,
    rangeText: '',
    summary: '',
    canOlder: false,
    canNewer: false,
    showTable: false,
    loading: false,
    loaded: false,
    error: '',
    lastUpdated: '',
    shownWindowText: '',
    generatedText: '',
  },
  onLoad(query: Record<string, string | undefined>) {
    if (isAnalysisWindow(query.window)) this.setData({ window: query.window });
    void this.load(false);
  },
  onUnload() { this.disposed = true; this.requestVersion += 1; },
  refresh() { return this.load(true); },
  async load(refresh: boolean) {
    if (this.disposed) return;
    const version = ++this.requestVersion;
    const window = this.data.window;
    this.setData({ loading: true, error: '' });
    try {
      // 与分析页同窗口复用同一进程内请求；刷新按钮强制重取。
      const { data } = await api.getAnalysis(window, refresh);
      if (this.disposed || version !== this.requestVersion) return;
      if (data.requestedWindow !== (window === 'all' ? null : Number(window))) throw new Error('统计窗口与请求不一致');
      this.features = data.features;
      this.setData({ loaded: true, total: data.features.length, end: data.features.length, shownWindowText: WINDOW_TEXT[window],
        generatedText: formatBeijingTime(data.generatedAt), lastUpdated: formatBeijingTime(new Date().toISOString()) });
      this.renderPoints();
    } catch (error) {
      if (!this.disposed && version === this.requestVersion) this.setData({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ loading: false });
    }
  },
  renderPoints() {
    const end = this.data.end;
    const start = Math.max(0, end - PAGE_SIZE);
    const metric = this.data.metric;
    const points = this.features.slice(start, end).map(row => ({ issue: row.issue, value: row[metric] }));
    const values = points.map(point => point.value).filter((value): value is number => value !== null);
    const gaps = points.length - values.length;
    const mean = values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : '—';
    this.setData({
      points,
      rangeText: points.length ? `显示第${points[0].issue}期至第${points[points.length - 1].issue}期，共${points.length}点（样本${this.data.total}期）` : '暂无可绘制数据',
      summary: values.length ? `最小${Math.min(...values)}，最大${Math.max(...values)}，均值${mean}${gaps ? `；断点${gaps}个` : ''}。` : '所显示区间无数值。',
      canOlder: start > 0,
      canNewer: end < this.data.total,
    });
  },
  chooseMetric(event: WechatMiniprogram.CustomEvent) {
    const definition = METRICS.find(item => item.key === event.currentTarget.dataset.key);
    if (!definition || definition.key === this.data.metric) return;
    this.setData({ metric: definition.key, metricLabel: definition.label, metricNote: definition.note, color: definition.color });
    this.renderPoints();
  },
  chooseWindow(event: WechatMiniprogram.CustomEvent) {
    const window: unknown = event.currentTarget.dataset.window;
    if (isAnalysisWindow(window) && window !== this.data.window && !this.data.loading) {
      this.setData({ window });
      void this.load(false);
    }
  },
  older() {
    if (!this.data.canOlder) return;
    this.setData({ end: Math.max(Math.min(PAGE_SIZE, this.data.total), this.data.end - PAGE_SIZE) });
    this.renderPoints();
  },
  newer() {
    if (!this.data.canNewer) return;
    this.setData({ end: Math.min(this.data.total, this.data.end + PAGE_SIZE) });
    this.renderPoints();
  },
  toggleTable() { this.setData({ showTable: !this.data.showTable }); },
});
