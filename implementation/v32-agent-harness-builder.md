# v32 実装計画: Agent Harness Builder

> Implemented。詳細仕様は [docs/14-agent-harness-builder.md](../docs/14-agent-harness-builder.md)、判断は [ADR-0032](../docs/adr/0032-versioned-agent-harness-orchestration.md)。M1–M6のpreviewとinteractive runtimeを実装済み。

## 1. 目的と初回リリース境界

保存済みAgent versionを図上のslotへ割り当て、Harnessを保存・検証・previewできる基盤を追加する。全patternは共通のRun、予算、時間上限、root/child event契約でone-shot previewできる。

初回に含めないもの:

- Harnessの入れ子。
- production副作用実行と実承認。
- 任意コードnode、cron、Webhook。
- Microsoft Agent Frameworkへの直接依存。

## 2. Slice A: DomainとRepository（実装済み）

追加候補:

```text
src/domain/harness/
  agent-harness.ts
  pattern.ts
  serialization.ts
  errors.ts
  harness-repository.ts
src/adapters/storage/
  in-memory-harness-repository.ts
  sqlite-harness-repository.ts
```

- `HarnessMetadata`、`AgentSlot`、pattern別Topology、Policiesをimmutable型で定義。
- `createAgentHarness`で共通・pattern固有validation。
- 保存済みHarnessは全slotがSemVer固定Agent refを持つ。
- SQLite migrationと後方互換serialization test。
- Repository contract testをInMemory/SQLiteで共有。

完了条件: Domain、serialization、repositoryのtestとtypecheckがgreen。

## 3. Slice B: CompilerとValidation API（実装済み）

```text
src/application/harness/
  compile-harness.ts
  validate-harness.ts
  save-harness.ts
  query-harnesses.ts
src/api/harness-routes.ts
```

- Authoring modelから`ExecutableHarness` IRを生成。
- Agent ref存在、実効副作用、必要Model capabilityを解決。
- `POST /harness-drafts/validate`はfield/slot/edge単位のissueを返す。
- `POST /harnesses`、list/get/versionsを追加。
- 外部SDK型をimportしないdependency ruleを追加。

完了条件: patternごとのvalid/invalid fixtureとAPI統合testがgreen。

## 4. Slice C: Harness Builder UI（初期実装済み）

```text
src/ui/harness-builder/
  HarnessBuilder.tsx
  PatternGallery.tsx
  HarnessCanvas.tsx
  AgentPalette.tsx
  HarnessInspector.tsx
  store.ts
```

- `@xyflow/react`を再利用するが、Tool Builder storeとは分離。
- Presetからslot/topologyを生成。
- Agent Paletteからslotへ割当、version固定、目的編集。
- Sequential並べ替え、Concurrent Aggregator設定。
- issueをCanvas node/edgeとInspector fieldへ対応付ける。
- 未保存変更、読込、version保存、i18n en/ja。

完了条件: UI unit test、保存DTO test、最低1本のPlaywright builder flowがgreen。

## 5. Slice D: Run基盤（初期実装済み）

```text
src/domain/harness-run/
  harness-run.ts
  harness-event.ts
  repositories.ts
src/application/harness/
  run-harness.ts
  harness-runtime.ts
  context-projector.ts
src/adapters/harness/
  local-harness-runtime.ts
  scripted-harness-runtime.ts
```

- root Harness Runとsequence付きeventを保存。
- `AgentRunnerPort` adapterで既存保存済みAgent実行をleafとして呼ぶ。
- child Run ID、Agent version、usage、latencyをroot eventへ記録。
- Harness Session Workspaceを共有し、会話履歴はparticipant別に投影。
- abort、timeout、共有budgetを実装。

完了条件: Scripted runtimeでroot→child traceを決定的に再現できる。

## 6. Slice E: Sequential（実装済み）

- slot順にAgentを実行。
- `full-conversation`と`previous-response`を実装。
- fail-fastを既定にし、失敗eventと未実行slotを記録。
- 最終slot応答をHarness terminal outputにする。

Contract cases:

1. 3 Agentが指定順に実行される。
2. 各Agentへ期待するcontextだけが渡る。
3. 中間失敗で後続を実行しない。
4. budget枯渇で停止する。

## 7. Slice F: Concurrent（実装済み）

- 同一taskをbranchへ渡し、`maxParallelism`内で実行。
- budgetを開始前に予約。
- `Promise.allSettled`相当でbranch結果を収集し、slot順へ整列。
- `collect`とassigned Agent Aggregatorを実装。

Contract cases:

1. 独立branchへ他branchの履歴が漏れない。
2. 完了順が異なっても集約順は固定。
3. collect/fail-fast failure policy。
4. cancelが全branchへ伝播する。

## 8. Slice G: Chat、Status、Validation

- Chat targetをAgent/HarnessのRunnable summaryへ拡張。
- Harness中間出力を折り畳み表示。
- StatusでHarness root→participant Run→Tool traceを辿る。
- Scenario targetへHarness refを追加し、participant path assertionを導入。

## 9. Slice H: Interactive Runtime（実装済み）

### Handoffの継続会話

`autonomous: false`のHandoffで担当Agentがhandoffせず応答すると、`waiting-input`へ遷移する。checkpointにはactive participant、公開Conversation Ledger、残participant/model/tool budget、24時間の期限、画面表示用promptを保存する。`POST /harness-runs/:runId/responses`の`{ kind: 'input' }`で同じRun IDを再開し、次の応答後も必要なら新しいcheckpointを保存する。

### Magenticの人手承認

`requirePlanSignoff: true`のManager delegate planは、participantを実行する前に`waiting-approval`へ遷移する。checkpointは選択slot、instruction、公開Ledger、round/stall/reset、残予算、期限、表示用planを保存する。`approve`は保存済みinstructionを実行し、`revise`はfeedbackをLedgerへ加えてManagerを再実行し、`reject`はRunをcancelledにする。公開可能な進捗のみ保存し、非公開思考過程を要求しない。

### 状態とAPI

```text
running --Handoff terminal--> waiting-input --input--> running
running --Magentic plan--> waiting-approval --approve/revise--> running
waiting-approval --reject--> cancelled
waiting-* --cancel--> cancelled
```

`HarnessRunRecord`にcheckpointを埋め込み、InMemory/SQLite Repositoryが同じroot recordとして保存する。開始、再開、cancelはそれぞれ`POST /harness-runs`、`POST /harness-runs/:runId/responses`、`POST /harness-runs/:runId/cancel`を使用する。期限を過ぎたcheckpointは再開できない。

## 10. 後続Slice

### Group Chatの継続会話

同じcheckpoint unionを拡張し、round-robin／Manager selectorの途中で利用者が発話できる会話モードを追加する。hard maxRoundsは維持する。

### Tool承認とClaw Starter

planning/memory/approval/background/observability policy presetを提供し、Local RuntimeとMicrosoft Agent Framework adapter/exportのcontractを揃える。

## 11. 全体DoD

- typecheck 3構成、Vitest全件、dependency cruise、Playwrightがgreen。
- 全Harness/Agent参照がversion固定。
- preview/testは実効副作用`write/external-action`をfail closed。
- すべてのloopにhard limitがあり、cancel/timeoutがchildへ伝播。
- root Runから使用した全Agent/Tool versionとchild Runへ到達できる。
- SDK固有型がdomain/application/UI DTOへ漏れていない。
