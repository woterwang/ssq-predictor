import { api, errorMessage, isNotFound } from '../../services/api';
import type { PublicDraw, Ticket, VerificationRecord, VerificationView } from '../../types/api';
import { copyText, formatAmount, formatBeijingTime, formatTickets, prizeGradeText } from '../../utils/presentation';

interface FrozenTicketRow extends Ticket {
  ticketKey: string;
  ticketIndex: number;
  outcomeText: string;
  gradeText: string;
  amountText: string;
}
interface VersionRow { id: number; verifiedAtText: string; fingerprint: string; targetIssue: string }
interface WarningRow { key: string; text: string }

/** 补充原件关联检查；不从versions中挑选或自行重算核验结果。 */
function matchesFrozenRecord(view: VerificationView, latest: VerificationRecord): boolean {
  return latest.recommendationId === view.recommendation.id
    && latest.result.recommendationContentHash === view.recommendation.contentHash
    && latest.result.targetIssue === view.recommendation.targetIssue
    && latest.result.outcomes.length === view.recommendation.tickets.length
    && latest.result.outcomes.every(outcome => Number.isInteger(outcome.redHits)
      && outcome.redHits >= 0 && outcome.redHits <= 6 && typeof outcome.blueHit === 'boolean');
}

function presentTickets(view: VerificationView, showOutcomes: boolean): FrozenTicketRow[] {
  const latest = view.latest;
  return view.recommendation.tickets.map((ticket, ticketIndex) => {
    const outcome = showOutcomes && latest ? latest.result.outcomes[ticketIndex] : null;
    return {
      ...ticket,
      ticketKey: `${ticketIndex}-${ticket.redBalls.join('-')}-${ticket.blueBall}`,
      ticketIndex,
      outcomeText: outcome ? `服务端记录：命中${outcome.redHits}红 / ${outcome.blueHit ? '蓝命中' : '蓝未中'}` : '',
      gradeText: outcome ? prizeGradeText(outcome.grade) : '',
      amountText: outcome && latest?.result.payoutAudit.eligible
        ? formatAmount(outcome.prizeYuan) : '暂停金额展示',
    };
  });
}

Page({
  requestVersion: 0,
  disposed: false,
  requestedId: 0,
  data: {
    view: null as VerificationView | null,
    targetDraw: null as PublicDraw | null,
    frozenTickets: [] as FrozenTicketRow[],
    versions: [] as VersionRow[],
    auditWarnings: [] as WarningRow[],
    loading: false,
    error: '',
    drawError: '',
    drawPending: false,
    notFound: false,
    routeValid: false,
    verificationUpdatedAt: '',
    drawUpdatedAt: '',
    generatedAtText: '',
    targetDateText: '',
    statusLabel: '',
    statusMessage: '',
    latestVerifiedAtText: '',
    latestFingerprint: '',
    latestProblem: '',
    showOutcomes: false,
    replayAvailable: false,
    replayAmountText: '',
    formalRoiText: '暂不提供',
  },
  onLoad(options: Record<string, string | undefined>) {
    const rawId = options.id;
    if (typeof rawId !== 'string' || !/^[1-9]\d*$/.test(rawId)) {
      this.setData({ error: '推荐记录编号无效，请从首页或推荐档案进入。' });
      return;
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) {
      this.setData({ error: '推荐记录编号超出有效范围，请从推荐档案重新进入。' });
      return;
    }
    this.requestedId = id;
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
      const { data: view } = await api.getVerification(this.requestedId);
      if (this.disposed || version !== this.requestVersion) return;
      if (view.recommendation.id !== this.requestedId) throw new Error('原件编号与请求不一致');
      const verificationUpdatedAt = formatBeijingTime(new Date().toISOString());
      let targetDraw: PublicDraw | null = null;
      let drawError = '';
      let drawPending = false;
      let drawUpdatedAt = '';
      let targetFetched = false;
      // 先取得核验原件，才知道目标期号；第二路失败不得丢弃固化号码。
      try {
        const envelope = await api.getDraw(view.recommendation.targetIssue);
        if (this.disposed || version !== this.requestVersion) return;
        if (envelope.data.issue !== view.recommendation.targetIssue) throw new Error('目标期号与响应不一致');
        targetDraw = envelope.data;
        targetFetched = true;
        drawUpdatedAt = formatBeijingTime(new Date().toISOString());
      } catch (error) {
        if (this.disposed || version !== this.requestVersion) return;
        if (isNotFound(error)) {
          drawPending = true;
          drawUpdatedAt = formatBeijingTime(new Date().toISOString());
        } else {
          drawError = errorMessage(error);
          // 同一期的旧开奖可保留，但必须带旧时间，且不能据此呈现当前核验结论。
          if (this.data.targetDraw?.issue === view.recommendation.targetIssue) {
            targetDraw = this.data.targetDraw;
            drawUpdatedAt = this.data.drawUpdatedAt;
          }
        }
      }
      if (this.disposed || version !== this.requestVersion) return;
      const latest = view.latest;
      const latestValid = latest !== null && matchesFrozenRecord(view, latest);
      const latestProblem = latest && !latestValid ? 'latest与固化原件关联或逐注结果不一致，未显示为有效核验；请只读刷新重试。' : '';
      // 两次HTTP请求没有共享快照证明，绝不叠加号码命中描边或伪造matchedReds。
      const showOutcomes = targetFetched && latestValid;
      let statusLabel = '当前版本待核验';
      let statusMessage = '已取得目标开奖，但latest为空；没有与核验响应时点匹配的结果，不能判断中奖与否。';
      if (drawPending) {
        statusLabel = '待开奖 / 待同步';
        statusMessage = '目标期尚未收录。404不代表未中奖；保留全部固化号码，暂不展示命中或收益判断。';
      } else if (drawError) {
        statusLabel = '目标开奖读取失败';
        statusMessage = '未能确认目标开奖状态，不能据旧开奖或历史版本认定当前结果；可手动重试。';
      } else if (latestProblem) {
        statusLabel = '核验数据不一致';
        statusMessage = latestProblem;
      } else if (showOutcomes) {
        statusLabel = '服务端当前核验（响应时点）';
        statusMessage = '逐注文字来自核验响应的latest。下方开奖号码独立取得，两次请求之间可能发生修正，不声称属于同一快照。';
      }
      const warnings: WarningRow[] = [];
      if (latest) {
        latest.result.payoutAudit.withheldReasons.forEach((text, index) => warnings.push({ key: `audit-${index}`, text }));
        latest.result.limitations.forEach((text, index) => warnings.push({ key: `limit-${index}`, text }));
        if (!latest.result.payoutAudit.eligible) warnings.unshift({ key: 'withheld', text: '当前核验响应的公告金额回放资格未通过；暂停收益展示。' });
      }
      const replayAvailable = showOutcomes && latest !== null && latest.result.payoutAudit.eligible
        && latest.result.announcedPrizeReplayYuan !== null && Number.isFinite(latest.result.announcedPrizeReplayYuan);
      this.setData({
        view, targetDraw, drawError, drawPending, drawUpdatedAt, verificationUpdatedAt,
        frozenTickets: presentTickets(view, showOutcomes),
        versions: view.versions.map(record => ({
          id: record.id,
          verifiedAtText: formatBeijingTime(record.verifiedAt),
          fingerprint: record.drawFingerprint,
          targetIssue: record.result.targetIssue,
        })),
        auditWarnings: warnings,
        generatedAtText: formatBeijingTime(view.recommendation.generatedAt),
        targetDateText: view.recommendation.targetDrawDate ?? '未提供',
        statusLabel, statusMessage, latestProblem, showOutcomes, replayAvailable,
        latestVerifiedAtText: latestValid && latest ? formatBeijingTime(latest.verifiedAt) : '',
        latestFingerprint: latestValid && latest ? latest.drawFingerprint : '',
        replayAmountText: replayAvailable && latest ? formatAmount(latest.result.announcedPrizeReplayYuan) : '',
        notFound: false,
        formalRoiText: '暂不提供',
      });
    } catch (error) {
      if (this.disposed || version !== this.requestVersion) return;
      if (isNotFound(error)) {
        this.setData({
          view: null, targetDraw: null, frozenTickets: [], versions: [], auditWarnings: [],
          notFound: true, drawError: '', drawPending: false, showOutcomes: false, replayAvailable: false,
          verificationUpdatedAt: formatBeijingTime(new Date().toISOString()),
        });
      } else {
        // 核验请求失败保持整个旧展示；视图明确标注旧数据取得时间。
        this.setData({
          error: errorMessage(error),
          statusLabel: '最新核验未取得（保留旧记录）',
          statusMessage: '以下原件和审计历史来自上次成功响应，不作当前命中或收益判断。请手动重试。',
          showOutcomes: false,
          replayAvailable: false,
        });
      }
    } finally {
      if (!this.disposed && version === this.requestVersion) this.setData({ loading: false });
    }
  },
  copyFrozenTickets() {
    const record = this.data.view?.recommendation;
    if (record) copyText(formatTickets(record.targetIssue, record.tickets));
  },
  openRecommendations() { wx.navigateTo({ url: '/pages/recommendations/index' }); },
});