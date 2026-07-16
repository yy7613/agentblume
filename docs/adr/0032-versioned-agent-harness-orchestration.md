# ADR-0032: マルチエージェント構成をバージョン付きAgent Harnessと型付きPattern Compilerで表現する

- Status: Accepted (M1–M3 implemented; interactive patterns follow)
- Date: 2026-07-15
- Context doc: [docs/14-agent-harness-builder.md](../14-agent-harness-builder.md)

## Context

既存のマルチエージェントは、親AgentがサブAgentをToolとして呼び、結果を受け取って最終責任を持つAgent-as-Tools方式だけを実装している。Sequential、Concurrent、Handoff、Group Chat、Magenticでは、制御主体、文脈共有、停止条件、対話のpause/resumeが異なるため、`Agent.agents`の参照リストだけでは表現できない。

同時に、Agent Framework固有のWorkflow型をドメインへ保存するとSDK更新へ追従できず、ローカル実行、Fake実行、他Providerへの差し替えが難しくなる。

## Decision

1. **`AgentHarness`を新しいバージョン付き集約として導入する。** Harnessはpattern、Agent slot、topology、policies、output policyを保持し、割当AgentはSemVer固定参照とする。
2. **Patternは型付きunionとする。** 初期対応は`agent-as-tools / sequential / concurrent / handoff / group-chat / magentic`。自由edge graphを保存形式の中心にしない。
3. **Pattern Compilerを設ける。** Authoring modelから共通`ExecutableHarness` IRを生成し、Canvas表示、保存時検証、Local Runtime、外部SDK Adapterが同じIRを使用する。
4. **Harness topologyとruntime policyを分離する。** 計画、記憶、承認、共有予算、観測、background実行はpatternとは独立したpolicyとする。Clawはこのpolicyを設定済みのStarter Templateとして提供する。
5. **Harnessは単一のRunnableとして公開する。** ChatではAgentまたはHarnessを1つ選ぶ。内部参加Agentはchild Runとして追跡し、Harness root Runが最終応答と状態を所有する。
6. **共有Conversation Ledgerと参加者別sessionを使う。** Context Projectorがpatternに応じて`task-only / previous-response / full-conversation`を投影する。Tool call内部は他Agentへbroadcastしない。
7. **pause/resumeを第一級にする。** Handoffのユーザー入力待ち、Tool承認、Magentic計画承認を`waiting-input / waiting-approval`状態と型付きrequest/responseで保存する。
8. **hard budgetを必須にする。** モデル判定の終了条件だけに依存せず、時間、participant Run、model round、Tool call、並列度、pattern固有round/stall/resetを制限する。
9. **SDKはAdapterへ隔離する。** 初期は既存Agent Runをleafとして使うLocal Harness Runtimeを実装する。Microsoft Agent Framework連携は同じPort/Event contractのAdapterまたは一方向exportとする。

## Relationship to ADR-0018

[ADR-0018](./0018-multi-agent-sub-agent-delegation.md)は変更しない。単純委譲は引き続きAgent集約内の`agents`で表現する。本ADRは、制御フロー自体を保存・可視化する必要がある構成に限って新集約を追加する。

## Consequences

- Pattern Galleryから図を作り、slotへAgentを割り当てる一貫したUXを提供できる。
- 不正なHandoff edge、未設定Manager、停止条件なしGroup Chatを保存前に拒否できる。
- 同じHarness definitionをFake、Local、Microsoft Agent Frameworkの各Runtimeでcontract testできる。
- Harness root、participant Agent Run、Tool traceの3段階で観測できる。
- 新しい集約、repository、Run/Event/Checkpoint、ChatのRunnable抽象が必要になり、既存Agent-as-Toolsだけより実装量は増える。
- Harness入れ子と汎用Workflow制御ノードは初期版に含めないため、将来の`RunnableRef`一般化とWorkflow統合が別途必要になる。

## Alternatives considered

- **`Agent.agents`へpattern fieldを追加する**: Sequential等のrootを持たない構成やHandoffの有向meshを自然に表せず、Agent集約が複数の実行意味論を持つため却下。
- **自由なnode/edgeだけを保存する**: 見た目は柔軟だがpattern固有の停止性・文脈規則を後付け検証することになり、ノーコード利用者に危険なため却下。
- **Microsoft Agent Framework Workflowを直接永続化する**: SDK isolation原則とFake/Local実行の再現性を損なうため却下。
- **汎用Workflow Builder完成まで待つ**: Agent協調に必要な限定nodeと会話ledgerを小さく導入でき、利用価値が独立しているため却下。

## Implementation contract

[implementation/v32-agent-harness-builder.md](../../implementation/v32-agent-harness-builder.md) を参照する。
