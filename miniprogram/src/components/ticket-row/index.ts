/** 统一一注格式；上层只有取得同快照证据时才允许传命中标记。 */
Component({
  properties: { redBalls: Array, blueBall: Number, matchedReds: Array, matchedBlue: Boolean, index: Number, label: String },
  data: { redCells: [] as Array<{ number: number; matched: boolean }>, accessibleLabel: '', ticketLabel: '' },
  observers: {
    'redBalls, blueBall, matchedReds, matchedBlue, index, label'(reds: number[], blue: number, matches: number[], blueMatched: boolean, index: number, label: string) {
      const redCells = [...reds].sort((a, b) => a - b).map(number => ({ number, matched: matches.includes(number) }));
      const ticketLabel = label || `第${index + 1}注`;
      this.setData({ redCells, ticketLabel,
        accessibleLabel: `${ticketLabel}，红球${reds.join('、')}，蓝球${blue}${blueMatched ? '，蓝命中' : ''}` });
    },
  },
});