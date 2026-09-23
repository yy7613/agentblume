import type { ExperimentCaseResultDto, ExperimentStatusDto, GateReportDto, JudgeEvaluationRecordDto, ScenarioRunStatusDto } from '../api/types';

type Translate = (english: string, japanese: string) => string;

/**
 * 検証まわりの画面（Datasets/Experiments/Runs/Quality タブ）で共有する、状態語の表示ラベル。
 * 保存データ・CSSクラス名は生の値（'pass'・'queued' 等）のまま使い、ここでは表示文字列だけを言語に合わせる。
 */
export function experimentStatusLabel(status: ExperimentStatusDto, text: Translate): string {
  switch (status) {
    case 'queued': return text('queued', 'キュー待ち');
    case 'running': return text('running', '実行中');
    case 'completed': return text('completed', '完了');
    case 'failed': return text('failed', '失敗');
    case 'cancelled': return text('cancelled', '取消済み');
    case 'interrupted': return text('interrupted', '中断');
  }
}

/** ExperimentCaseResultDto.status / JudgeEvaluationRecordDto.status（'succeeded' | 'failed' の部分集合）に共通。 */
export function caseResultStatusLabel(status: ExperimentCaseResultDto['status'] | JudgeEvaluationRecordDto['status'], text: Translate): string {
  switch (status) {
    case 'succeeded': return text('succeeded', '成功');
    case 'failed': return text('failed', '失敗');
    case 'cancelled': return text('cancelled', '取消済み');
  }
}

export function scenarioRunStatusLabel(status: ScenarioRunStatusDto, text: Translate): string {
  switch (status) {
    case 'completed': return text('completed', '完了');
    case 'max-turns': return text('max-turns', 'ターン上限');
    case 'error': return text('error', 'エラー');
  }
}

/** 品質ゲートの合否。値そのもの（'pass'/'fail'）は変えず、表示だけ大文字英語 or 日本語にする。 */
export function gateStatusLabel(status: GateReportDto['status'], text: Translate): string {
  return status === 'pass' ? text('PASS', '合格') : text('FAIL', '不合格');
}
