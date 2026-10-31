import type { Recommendation } from '../../types/api';
import { copyText, formatBeijingTime } from '../../utils/presentation';

/** 只展示审计原件；哈希可复制，但不宣称第三方可信存证或客户端已验哈希。 */
Component({
  properties: { record: Object },
  data: { expanded: false, generatedText: '', deadlineText: '', paramsText: '' },
  observers: {
    record(record: Recommendation | null) {
      this.setData({ generatedText: formatBeijingTime(record?.generatedAt ?? null),
        deadlineText: formatBeijingTime(record?.generationDeadline ?? null), paramsText: record ? JSON.stringify(record.strategyParams) : '' });
    },
  },
  methods: {
    toggle() { this.setData({ expanded: !this.data.expanded }); },
    copyHash() { const record = this.data.record as Recommendation | null; if (record) copyText(record.contentHash); },
  },
});