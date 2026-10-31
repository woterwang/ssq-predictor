import { init, setPlatformAPI } from '../../lib/echarts';
import type { ChartInstance } from '../../lib/echarts';

interface Point { issue: string; value: number | null }
interface CanvasTouch { x: number; y: number }
interface ChartState { chart: ChartInstance | null; disposed: boolean }

/** zrender需要的最小Canvas外壳：Canvas 2D节点没有DOM事件接口，触摸由组件手动转发。 */
class CanvasAdapter {
  constructor(private readonly node: WechatMiniprogram.Canvas) {}
  getContext(type: string) { return type === '2d' ? this.node.getContext('2d') : null; }
  get width() { return this.node.width; }
  set width(value: number) { this.node.width = value; }
  get height() { return this.node.height; }
  set height(value: number) { this.node.height = value; }
  addEventListener(): void { /* 事件由touchStart/touchEnd转发 */ }
  removeEventListener(): void { /* 无DOM监听需移除 */ }
}

const states = new WeakMap<object, ChartState>();

function buildOption(points: Point[], color: string, seriesName: string): Record<string, unknown> {
  return {
    animation: false,
    color: [color],
    grid: { left: 40, right: 12, top: 16, bottom: 36 },
    tooltip: { trigger: 'axis', confine: true, textStyle: { fontSize: 12 } },
    xAxis: { type: 'category', data: points.map(point => point.issue), boundaryGap: false,
      axisTick: { show: false }, axisLabel: { fontSize: 10, color: '#58677C', hideOverlap: true } },
    yAxis: { type: 'value', scale: true, minInterval: 1,
      axisLabel: { fontSize: 10, color: '#58677C' }, splitLine: { lineStyle: { color: '#E3E8EF' } } },
    // null保持断线，不补零、不连接跨缺期点。
    series: [{ type: 'line', name: seriesName, data: points.map(point => point.value), connectNulls: false,
      showSymbol: points.length <= 40, symbolSize: 4, lineStyle: { width: 1.5 } }],
  };
}

Component({
  properties: {
    points: { type: Array, value: [] },
    color: { type: String, value: '#C93648' },
    seriesName: { type: String, value: '' },
    summary: { type: String, value: '' },
  },
  data: { failed: false },
  lifetimes: {
    // ready在组件完成布局后触发：此时节点可见、尺寸可测，再创建图表。
    ready() {
      const state: ChartState = { chart: null, disposed: false };
      states.set(this, state);
      this.createSelectorQuery().select('#trend-canvas').fields({ node: true, size: true }).exec(result => {
        const target = result[0] as { node?: WechatMiniprogram.Canvas; width?: number; height?: number } | undefined;
        if (state.disposed) return;
        if (!target?.node || !target.width || !target.height) { this.setData({ failed: true }); return; }
        try {
          const context = target.node.getContext('2d');
          setPlatformAPI({ measureText: (text: string, font?: string) => {
            context.font = font || '12px sans-serif';
            return context.measureText(text);
          } });
          state.chart = init(new CanvasAdapter(target.node), null,
            { width: target.width, height: target.height, devicePixelRatio: wx.getWindowInfo().pixelRatio });
          this.render();
        } catch {
          this.setData({ failed: true });
        }
      });
    },
    detached() {
      const state = states.get(this);
      if (!state) return;
      state.disposed = true;
      state.chart?.dispose();
      state.chart = null;
      states.delete(this);
    },
  },
  observers: { 'points, color, seriesName'() { this.render(); } },
  methods: {
    render() {
      const chart = states.get(this)?.chart;
      if (chart) chart.setOption(buildOption(this.data.points as Point[], this.data.color, this.data.seriesName), true);
    },
    dispatch(names: string[], touch: CanvasTouch | undefined) {
      const chart = states.get(this)?.chart;
      if (!chart || !touch) return;
      const noop = () => undefined;
      for (const name of names) {
        chart.getZr().handler.dispatch(name, { zrX: touch.x, zrY: touch.y, preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop });
      }
    },
    // 只绑定点按，不拦截touchmove，页面纵向滚动不受图表影响。
    touchStart(event: { touches: CanvasTouch[] }) { this.dispatch(['mousedown', 'mousemove'], event.touches[0]); },
    touchEnd(event: { changedTouches: CanvasTouch[] }) { this.dispatch(['mouseup', 'click'], event.changedTouches[0]); },
  },
});
