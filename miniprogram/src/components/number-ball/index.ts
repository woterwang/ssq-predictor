/** 球是展示组件；命中有描边与勾选双标识，不能只依赖颜色。 */
Component({
  properties: { number: Number, color: { type: String, value: 'red' }, matched: Boolean },
  data: { numberText: '', accessibleLabel: '' },
  observers: {
    'number, color, matched'(number: number, color: string, matched: boolean) {
      const maximum = color === 'blue' ? 16 : 33;
      const valid = Number.isInteger(number) && number >= 1 && number <= maximum;
      this.setData({ numberText: valid ? String(number).padStart(2, '0') : '—',
        accessibleLabel: `${color === 'blue' ? '蓝' : '红'}球${valid ? number : '未提供'}${matched ? '，命中' : ''}` });
    },
  },
});