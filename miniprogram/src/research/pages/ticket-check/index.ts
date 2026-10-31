import { api, errorMessage } from '../../../services/api';
import type { TicketCheckResult } from '../../../types/api';

interface Cell { number: number; text: string; selected: boolean; label: string }
const cells = (maximum: number, color: string): Cell[] => Array.from({ length: maximum }, (_, index) => ({
  number: index + 1, text: String(index + 1).padStart(2, '0'), selected: false, label: `${color}球${index + 1}，未选`,
}));

function present(result: TicketCheckResult) {
  const f = result.features;
  const tails = f.redTailCounts.map((count, tail) => count > 0 ? `尾${tail}×${count}` : '').filter(Boolean).join('  ');
  return {
    rows: [
      { label: '红球和值', value: String(f.redSum) },
      { label: '跨度（最大−最小）', value: String(f.redSpan) },
      { label: '奇 : 偶', value: `${f.redOddCount} : ${f.redEvenCount}` },
      { label: '小 : 大（1–16 / 17–33）', value: `${f.redSmallCount} : ${f.redLargeCount}` },
      { label: '分区（1–11 / 12–22 / 23–33）', value: f.redZoneCounts.join(' : ') },
      { label: '连号组 / 相邻对', value: `${f.consecutiveGroupCount} / ${f.consecutivePairCount}` },
      { label: 'AC值', value: String(f.acValue) },
      { label: '红球尾数', value: tails },
      { label: '蓝球', value: `${String(f.blueBall).padStart(2, '0')} · ${f.blueIsOdd ? '奇' : '偶'} · ${f.blueSize === 'small' ? '小（1–8）' : '大（9–16）'}` },
    ],
    odds: '1 / 17,721,088',
    disclaimers: result.disclaimers,
  };
}

/** 选号只在本地页面内存中，不持久化、不上传身份；“查看结构”不评价优劣或胜率。 */
Page({
  requestVersion: 0,
  disposed: false,
  data: {
    redCells: cells(33, '红'),
    blueCells: cells(16, '蓝'),
    reds: [] as number[],
    blue: 0,
    ready: false,
    submitting: false,
    error: '',
    result: null as ReturnType<typeof present> | null,
  },
  onUnload() { this.disposed = true; this.requestVersion += 1; },
  applySelection(reds: number[], blue: number) {
    // 任何编辑都使旧结果与在途请求失效，避免把旧号码的结构显示给新选择。
    this.requestVersion += 1;
    const sorted = [...reds].sort((a, b) => a - b);
    this.setData({
      reds: sorted, blue,
      redCells: this.data.redCells.map(cell => ({ ...cell, selected: sorted.includes(cell.number), label: `红球${cell.number}，${sorted.includes(cell.number) ? '已选' : '未选'}` })),
      blueCells: this.data.blueCells.map(cell => ({ ...cell, selected: cell.number === blue, label: `蓝球${cell.number}，${cell.number === blue ? '已选' : '未选'}` })),
      ready: sorted.length === 6 && blue > 0,
      submitting: false, error: '', result: null,
    });
  },
  toggleRed(event: WechatMiniprogram.CustomEvent) {
    const number = Number(event.currentTarget.dataset.number);
    if (!Number.isInteger(number) || number < 1 || number > 33) return;
    const reds = this.data.reds;
    if (reds.includes(number)) { this.applySelection(reds.filter(item => item !== number), this.data.blue); return; }
    if (reds.length >= 6) { wx.showToast({ title: '红球最多选6个，请先取消一个', icon: 'none' }); return; }
    this.applySelection([...reds, number], this.data.blue);
  },
  toggleBlue(event: WechatMiniprogram.CustomEvent) {
    const number = Number(event.currentTarget.dataset.number);
    if (!Number.isInteger(number) || number < 1 || number > 16) return;
    this.applySelection(this.data.reds, this.data.blue === number ? 0 : number);
  },
  reset() { this.applySelection([], 0); },
  async check() {
    if (this.disposed || this.data.submitting) return;
    if (!this.data.ready) {
      this.setData({ error: `还需选择红球${6 - this.data.reds.length}个、蓝球${this.data.blue ? 0 : 1}个。` });
      return;
    }
    const version = ++this.requestVersion;
    this.setData({ submitting: true, error: '', result: null });
    try {
      const { data } = await api.checkTicket({ redBalls: this.data.reds, blueBall: this.data.blue });
      if (this.disposed || version !== this.requestVersion) return;
      this.setData({ result: present(data) });
    } catch (error) {
      // 失败保留本地选择，便于重试。
      if (!this.disposed && version === this.requestVersion) this.setData({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ submitting: false });
    }
  },
});
