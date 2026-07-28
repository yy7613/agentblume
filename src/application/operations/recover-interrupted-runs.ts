/**
 * application層: 起動時の孤児Run回収 `RecoverInterruptedRunsUseCase`。
 *
 * ## 何が壊れていたか
 *
 * ワーカーのキューは**メモリ内配列**で、プロセスが落ちれば消える。しかし DB 上のRunレコードは
 * `queued` / `running` のまま残る。これまで起動時にそれを見に行く処理が無かったため、
 *
 * - `queued` のRunは**永久に実行されない**（誰も enqueue し直さない）
 * - `running` のRunは**永久に running のまま固まる**。`ResumeFactoryRunUseCase` は `waiting-approval`
 *   しか、`RetryFactoryRunUseCase` は `failed` しか受け付けないので、利用者に復帰手段が無い
 *
 * という状態だった（実験だけはリポジトリ実装が `interruptRunning` で救済していたが、
 * 「どの状態をどう扱うか」という**回収の方針**が保存層に埋まっているのは置き場所として誤りで、
 * かつ `queued` の再投入は誰も行っていなかった）。
 *
 * ## 回収の方針（単一プロセス前提）
 *
 * 現在の配線ではワーカーはアプリと同一プロセスにしか存在しない。したがって
 * **起動した時点で `running` のRunは、それを実行していたプロセスが既に死んでいる**と断定できる。
 *
 * | 状態 | 扱い | 理由 |
 * | --- | --- | --- |
 * | `running` | 終端状態（Factory/Agent/Harness は `failed`、実験は `interrupted`）へ確定 | 実行主体が居ない。終端にして初めて retry / resume が使える |
 * | `queued` | ワーカーへ再投入 | 実行が始まっていないので、そのまま最初から流せる |
 * | `waiting-approval` / `waiting-input` | **触らない** | 人間の応答を待つ正常な状態。checkpoint は永続化されており再起動をまたいで有効 |
 * | 終端（succeeded / failed / cancelled / completed / interrupted） | 触らない | 既に確定済み |
 *
 * 実験だけ `failed` ではなく `interrupted` にするのは、`interrupted` が**この事象のために既にある**
 * ドメイン状態だから（`resumeExperiment` は `interrupted` と `failed` の両方を受け付け、UIにも
 * 「再開」ボタンがある）。Factory Run には対応する状態が無く、`failed` からの retry 経路（UIの
 * 「再実行」ボタン）が既にあるので `failed` へ寄せる。
 *
 * 複数プロセス運用へ進むときは「running を孤児と断定してよいか」の判定だけが変わる（lease / heartbeat の
 * 導入）。その判定はこのユースケースの中にあるので、リポジトリや composition を触らずに差し替えられる。
 */
import { appendFactoryEvent, failFactoryRun } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { interruptExperiment } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { appendHarnessEvent, failHarnessRun } from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';
import { failRun } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import type { FactoryWorkerPort } from '../factory/factory-worker';
import type { ExperimentWorkerPort } from '../evaluation/experiment-worker';
import { describeError, type LoggerPort } from './logger';

/** 中断されたRunの失敗コード（Experimentの `PROCESS_INTERRUPTED` と同じ語彙を全種類で使う）。 */
export const INTERRUPTED_FAILURE_CODE = 'PROCESS_INTERRUPTED';
/** 失敗理由の本文。運用者が「なぜ落ちたか」ではなく「なぜ止まったか」を1行で分かるようにする。 */
export const INTERRUPTED_REASON = 'Interrupted because the agentblume process restarted';

export interface RecoverInterruptedRunsDeps {
  readonly factoryRuns: FactoryRunRepository;
  readonly factoryWorker: FactoryWorkerPort;
  readonly experiments: ExperimentRepository;
  readonly experimentWorker: ExperimentWorkerPort;
  readonly runs: RunRepository;
  readonly harnessRuns: HarnessRunRepository;
  readonly now?: () => Date;
  readonly logger?: LoggerPort;
}

/** 回収結果。起動ログへそのまま載せる（0件でも出す: 「回収が動いた」こと自体が情報）。 */
export interface RecoverInterruptedRunsSummary {
  readonly factoryRunsFailed: number;
  readonly factoryRunsRequeued: number;
  readonly experimentsInterrupted: number;
  readonly experimentsRequeued: number;
  readonly agentRunsFailed: number;
  readonly harnessRunsFailed: number;
  /** 個別レコードの回収に失敗した件数。回収は1件の失敗で止めない（残りを道連れにしない）。 */
  readonly failures: number;
}

export class RecoverInterruptedRunsUseCase {
  private readonly now: () => Date;

  constructor(private readonly deps: RecoverInterruptedRunsDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async execute(): Promise<RecoverInterruptedRunsSummary> {
    const at = this.now().toISOString();
    let failures = 0;
    /** 1件の失敗で回収全体を止めない。件数だけ数え、原因はログへ残す。 */
    const guard = async (what: string, id: string, work: () => Promise<void>): Promise<number> => {
      try { await work(); return 1; }
      catch (error) { failures += 1; this.deps.logger?.warn(`failed to recover ${what}`, { id, reason: describeError(error) }); return 0; }
    };

    let factoryRunsFailed = 0;
    for (const run of await this.deps.factoryRuns.listAllByStatus('running')) {
      factoryRunsFailed += await guard('factory run', run.id, async () => {
        const failed = failFactoryRun(run, { stage: run.stage, reason: INTERRUPTED_REASON }, at);
        await this.deps.factoryRuns.save(appendFactoryEvent(failed, { kind: 'run_failed', at, stage: run.stage, message: INTERRUPTED_REASON }));
      });
    }
    let factoryRunsRequeued = 0;
    for (const run of await this.deps.factoryRuns.listAllByStatus('queued')) {
      factoryRunsRequeued += await guard('factory run', run.id, async () => { this.deps.factoryWorker.enqueue(run.scope, run.id); });
    }

    let experimentsInterrupted = 0;
    for (const experiment of await this.deps.experiments.listAllByStatus('running')) {
      experimentsInterrupted += await guard('experiment', experiment.id, async () => {
        await this.deps.experiments.update(interruptExperiment(experiment, at));
      });
    }
    let experimentsRequeued = 0;
    for (const experiment of await this.deps.experiments.listAllByStatus('queued')) {
      experimentsRequeued += await guard('experiment', experiment.id, async () => { this.deps.experimentWorker.enqueue(experiment.scope, experiment.id); });
    }

    // Agent RunはHTTPリクエスト内で同期実行されるためキューが無い。再投入する相手が居ないので
    // 終端（failed）へ確定させるだけにする。`waiting-approval` は触らない（承認待ちは正常な状態）。
    let agentRunsFailed = 0;
    for (const record of await this.deps.runs.listAllByStatus('running')) {
      agentRunsFailed += await guard('agent run', record.runId, async () => {
        await this.deps.runs.save(failRun(record, {
          trace: record.trace, failure: { code: INTERRUPTED_FAILURE_CODE, message: INTERRUPTED_REASON }, completedAt: at,
        }));
      });
    }

    // Harness Runも同様（`waiting-input` / `waiting-approval` は checkpoint を持つ正常な待機状態）。
    let harnessRunsFailed = 0;
    for (const record of await this.deps.harnessRuns.listAllByStatus('running')) {
      harnessRunsFailed += await guard('harness run', record.runId, async () => {
        const failed = failHarnessRun(record, { code: INTERRUPTED_FAILURE_CODE, message: INTERRUPTED_REASON }, at);
        await this.deps.harnessRuns.save(appendHarnessEvent(failed, { kind: 'harness_failed', at, message: INTERRUPTED_REASON }));
      });
    }

    return { factoryRunsFailed, factoryRunsRequeued, experimentsInterrupted, experimentsRequeued, agentRunsFailed, harnessRunsFailed, failures };
  }
}
