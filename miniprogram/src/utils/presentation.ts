import type { Ticket, NextRecommendation, PrizeGrade } from '../types/api';

/** 使用UTC字段加固定8小时，避免真机本地时区改变北京时间显示。 */
export function formatBeijingTime(value: string | null): string {
  if (!value) return '未提供';
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return '时间格式无效';
  const date = new Date(milliseconds + 8 * 3600000);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} 北京时间`;
}
export function formatAmount(value: number | null): string {
  return value === null ? '待公布' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 元`;
}
export function formatCount(value: number | null): string { return value === null ? '待公布' : String(value); }
export function copyText(text: string): void {
  wx.setClipboardData({ data: text, fail: () => wx.showToast({ title: '复制未完成，请重试', icon: 'none' }) });
}
export function formatTickets(issue: string, tickets: Ticket[]): string {
  return `第${issue}期 · 固化原件\n${tickets.map((ticket, index) => `${index + 1}. ${ticket.redBalls.map(n => String(n).padStart(2, '0')).join(' ')} | ${String(ticket.blueBall).padStart(2, '0')}`).join('\n')}\n随机推荐不提高单注中奖概率，仅供研究与娱乐。`;
}
export function describeNextStatus(view: NextRecommendation): { label: string; message: string } {
  if (view.status === 'available') return { label: '原件已生成', message: '服务器已固化号码；刷新只读取原件，不会换号。' };
  if (view.status === 'closed') return { label: '已过保守生成截止', message: '已有原件仍可查看；20:00不是已核实的官方停售时间。' };
  if (view.status === 'awaiting_draw') return {
    label: view.reason === 'source_draw_not_finished' ? '源期开奖尚未完成' : '目标开奖待同步',
    message: '以服务器状态为准，不在客户端跳期补造号码或预判核验结果。',
  };
  return { label: '尚未生成', message: view.reason === 'no_draws' ? '服务器暂无开奖数据。' : '服务器尚未生成原件，公众页面不触发生成。' };
}
export function prizeGradeText(grade: PrizeGrade): string {
  if (grade === 'fortune') return '福运奖（已核实窗口）';
  if (grade === 'none') return '未中已支持奖级';
  return `${['一','二','三','四','五','六'][grade - 1]}等奖`;
}
export function describeStructure(ticket: Ticket) {
  const reds = [...ticket.redBalls].sort((a, b) => a - b);
  const odd = reds.filter(number => number % 2 === 1).length;
  const differences = new Set<number>();
  reds.forEach((left, index) => reds.slice(index + 1).forEach(right => differences.add(right - left)));
  return {
    sum: String(reds.reduce((sum, number) => sum + number, 0)),
    span: String(reds[5] - reds[0]),
    oddEven: `${odd} : ${6 - odd}`,
    zones: [reds.filter(n => n <= 11).length, reds.filter(n => n >= 12 && n <= 22).length, reds.filter(n => n >= 23).length].join(' : '),
    ac: String(differences.size - 5),
  };
}