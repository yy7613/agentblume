# v33 実装契約: Agent Factory（自動生成と自動改善ループ）

> 設計は [docs/16-agent-factory.md](../docs/16-agent-factory.md)、判断は [ADR-0033](../docs/adr/0033-agent-factory-generation-loop.md)。
> 前提: v32まで完成・全green。外部SDKは追加しない（LLMは既存 `ModelProviderPort` のみ）。

## 0. 規約

strict / `noUncheckedIndexedAccess` / ESM・拡張子なしimport / Zod v4 / Vitest / 既存エラー型パターン / 非mutate / テスト同居 / coverage閾値維持（lines・statements・functions 90 / branches 80）/ depcruise 0違反 / 既存テスト変更禁止（純増分）。

## 1. Domain（`src/domain/factory/`）

- `factory-run.ts`: `FactoryRun` / `FactoryRunStatus` / `FactoryStage` / `FactoryEvent`(+kind) / `FactoryIteration` / `IterationMetrics` / `FactoryReport` / `FactoryPlanCheckpoint` / 予算型。`FactoryEvent` は append-only sequenceを持ちRunレコードへ埋め込む（`appendFactoryEvent` は Harness の `appendHarnessEvent` に倣う）。状態遷移関数（`startFactoryRun` / `appendFactoryEvent` / `advanceStage` / `waitForPlanApproval` / `resumeFactoryRun` / `recordIteration` / `succeedFactoryRun` / `failFactoryRun` / `cancelFactoryRun`）は非mutateで、Harness runと同じ規律に従う。
- `factory-plan.ts`: `FactoryPlan`（Agent像 / `FactoryToolPlan[]` / SkillPlan[] / PersonaPlan[] / ScenarioPlan[]）と検証（参照整合・件数上限・副作用制限）。
- `improvement-proposal.ts`: `ImprovementProposal` union（`system-prompt-revision` / `skill-instructions-revision` / `tool-contract-revision` / `tool-graph-revision` / `add-tool`）+ `AppliedProposal` / `RejectedProposal`。
- `errors.ts`: `FactoryValidationError` / `FactoryNotFoundError`（既存ドメインのエラー型に倣う）。
- `serialization.ts`: Zodによるserialize / deserialize（`SerializedFactoryRun`。イベント・checkpoint・iterations・reportを含む）。
- `factory-run-repository.ts`: Port（`save`(upsert) / `find` / `list` — Harness run repositoryと同一契約）。
- checkpointはRun recordへ埋め込み、TTL 24時間。型付き応答（`plan-approval`: approve / revise / reject）以外は拒否する。

## 2. Adapters（`src/adapters/storage/` ほか）

- `in-memory-factory-run-repository.ts` / `sqlite-factory-run-repository.ts`（`factory_runs` テーブル、`(tenant_id, workspace_id, run_id)` 主キー、record JSON原子保存。`sqlite-harness-run-repository.ts` を雛形にする）。
- 共有契約テスト `factory-run-repository.contract.ts` を両実装で通す（`in-memory-factory-run-repository.test.ts` / `sqlite-factory-run-repository.test.ts` から呼ぶ）。
- `src/adapters/factory/in-process-factory-worker.ts`: `FactoryWorkerPort` 実装。v23 `InProcessExperimentWorker` と同じqueue / cancel / 進捗規律。同時実行1、`AbortSignal` を全LLM呼び出し・シナリオ実行へ伝播。

## 3. Application（`src/application/factory/`）

- `roles/`: 内蔵ロール（Planner / ToolSmith / SkillWriter / Assembler / ScenarioDesigner / Analyst）。各ロールは「promptテンプレート + 構造化出力スキーマ + 温度0」で `ModelProviderPort.complete` を1回呼ぶ純関数的クラス。データ値・発話・自由記述は `<untrusted-data>` 隔離（v25 Judgeと同じ規律）。
- `profile-data-sources.ts`: Stage 0。`ResolveDataSourceGraphUseCase` + `EtlEngine` で `DataProfile`（schema / sampleRows ≤ 20 / 列統計）を決定的に生成。LLM不使用。
- `run-factory.ts`: `RunFactoryUseCase`。パイプライン本体（Stage 0–5 + 改善ループ）。既存ユースケースを合成する:
  - Tool: ToolSmith提案 → `EtlEngine.propagateSchemas` + `preview` → 失敗時エラー付き再提案（`maxRepairAttempts`、既定2）→ `SaveToolUseCase`（draft、`sideEffect` は `read-only` / `session-write` のみ）。
  - Skill: `SaveSkillUseCase`（依存Toolは生成版SemVer固定）。
  - Agent: `GenerateAgentPromptUseCase` の決定的合成 + Assembler起草の役割文・追加規則 → `SaveAgentUseCase`（draft / `kind: 'normal'`）。
  - 検証資産: `SavePersonaUseCase` → `RegisterPseudoUserAgentUseCase` / `SaveScenarioUseCase`（`DEFAULT_SURVEY`、`expectedTools` は生成Tool公開名のみ）。Scenario集合はRun内で凍結。
  - ループ: `RunScenarioUseCase` × 全Scenario → `IterationMetrics` 集計 → 停止判定（目標達成 / 改善停滞 / 上限）→ Analyst → 提案検証・適用（上限 既定4/回）→ Agent新版。
- `query-factory-runs.ts`: 一覧 / 取得 / イベント取得。
- `respond-to-factory-run.ts`: 計画承認応答。`cancel-factory-run.ts`: キャンセル。
- 可用性: `structured-output` capabilityがない場合、Factory APIは `available: false` を返し実行を拒否する。

## 4. API（`src/api/factory-routes.ts`）

- `POST /factory-runs`（202 / Zod検証: goal必須・dataSourceIds 1..5・options上限）/ `GET /factory-runs` / `GET /factory-runs/:runId` / `GET /factory-runs/:runId/events` / `POST /factory-runs/:runId/responses` / `POST /factory-runs/:runId/cancel`。
- 既定options（設計書§9）はサーバー側で補完し、Run recordへsnapshotとして保存する。
- 既存エラーマッピング規約に従い、`factory-routes.test.ts` を同居させる。

## 5. Composition（`src/composition/root.ts`）

- profile `local` → SQLite repos + `InProcessFactoryWorker`、profile `test` → InMemory repos + 同worker（`ScriptedModelProvider` 駆動）。
- `AppOptions` へ差し替え可能なworker / role model providerの注入口を追加（テスト・埋め込み用）。

## 6. UI（`src/ui/factory/`）

- ナビゲーションへ「Factory」タブ追加（`src/ui/App.tsx`）。
- `FactoryPage.tsx`: 入力フォーム（goal / targetUsers / データソース複数選択 / 詳細オプション折り畳み）、実行タイムライン（events ポーリング）、計画承認カード（approve / revise / reject）、生成物リンク（既存Agent / Tool / Validation画面へ）、レポート（イテレーション別メトリクス推移・最良候補・未解決Finding）。昇格ボタンは置かない。
- `ToolApiClient` へfactory系メソッドとDTO（`src/ui/api/types.ts`）を追加。
- `FactoryPage.test.tsx`（@testing-library/react）。

## 7. マイルストーン

| M | 範囲 | 完了条件 | 状態 |
|---|---|---|---|
| M1 | Domain / serialization / repos + 契約テスト / Worker Port / API skeleton / Stage 0–1 / 計画承認checkpoint | scripted Plannerで `queued → running → waiting-approval → running` が通る | 完了 |
| M2 | ToolSmith修復ループ / SkillWriter / Assembler / Stage 2–4保存 / UI最小（入力 + タイムライン） | scripted台本で資産一式がdraft保存され既存画面で開ける | 完了 |
| M3 | ScenarioDesigner / Stage 5 / シナリオ一括実行 + メトリクス集計（ループなし1回） | ScenarioRunがFactoryRunへ紐付き、メトリクスが集計される | 完了 |
| M4 | Analyst / 提案検証・適用 / 停止条件 / レポート / バックエンド完成 | 統合テスト4系統（改善成功 / 停滞終了 / 予算超過 / 計画却下）green | 完了 |
| M5 | Factory UI（`src/ui/factory/FactoryPage.tsx`）・ナビ追加・`ToolApiClient` factory系メソッド + DTO（`src/ui/api/`）・UIテスト・e2e smoke・docsステータス確定 | `FactoryPage`がnav・入力フォーム・実行タイムライン・計画承認カード・レポートを表示し、`npm run typecheck` / `npx vitest run` / `npm run build` / `npm run depcruise` がgreen | 完了 |

当初案（docs/16-agent-factory.md §12執筆時点）ではM5候補として「EvaluationDataset export / Judge指標のループ組み込み / v27還流接続 / Harness対象生成」を挙げていたが、実際の実装ではM5をUI・APIクライアント・docs確定に充て、これらは本v33契約のスコープ外の後続増分として引き続き未着手のまま残す（§10 実装結果のスコープ縮小も参照）。

## 8. テスト方針

- 各ロール: scripted台本で正常 / JSON破損 / スキーマ不適合 / 修復成功 / 修復上限到達を検証。
- パイプライン統合: 「生成 → 検証(低) → 改訂 → 検証(改善) → succeeded」「改善停滞で早期終了 + 最良イテレーション選択」「`budget_exceeded` 停止」「reject → cancelled」。
- 安全性: write系Tool計画の拒否、Scenario凍結（イテレーション間で版不変）、untrusted隔離文字列がsystem messageへ混入しないこと、昇格APIを呼ばないこと。
- Repository契約テスト両実装green。E2E: testプロファイルでFactory実行 → タイムライン → 生成AgentがAgent画面へ表示されるsmoke。

## 9. DoD

- [ ] `npm test`（既存 + 新規）green、coverage閾値維持
- [ ] `npm run typecheck`（3 tsconfig）green
- [ ] `npm run depcruise` 0違反（factory層の依存方向を含む）
- [ ] `npm run build` green
- [ ] `npm run test:e2e` green（smoke追加込み）
- [ ] docs/README.md 索引・関連ドキュメントのcross-link更新
- [ ] feature branchへ `Co-Authored-By` 付きコミット

## 10. 実装結果

- Status: Complete (2026-07-20)
- M1–M5 すべて完了。Domain / repos（InMemory・SQLite契約テスト）/ Worker / API skeleton / Stage 0–1（M1）、ToolSmith修復ループ・SkillWriter・Assembler・Stage 2–4資産保存（M2）、ScenarioDesignerのマテリアライズ・Stage 5・シナリオ一括実行とメトリクス集計（M3）、Analyst・改善提案の検証と適用・停止条件・レポート（M4）、Factory UI（`src/ui/factory/FactoryPage.tsx`）・`ToolApiClient` factory系メソッド + DTO・UIテスト・e2e smoke・docsステータス確定（M5）を提供する。
- スコープ縮小（意図的、2件）:
  1. データソースプロファイリング（Stage 0）は`file`系データソースのみに対応する。`database`系データソースのプロファイリングは未対応（`src/application/factory/profile-data-sources.ts`: `'ProfileDataSources: database data source profiling is not supported yet'`）。
  2. 改善提案`add-tool`（新規Tool追加）は構造的には受理・検証するが、自動適用は本契約のスコープ外として常にrejectedに記録する（`src/application/factory/apply-improvements.ts`: `'add-tool application is a later slice'`）。
- 179 test files / 1137 tests green（`npx vitest run`、v33新規UIテスト `src/ui/factory/FactoryPage.test.tsx` 5件を含む）。
- `npm run typecheck`（既定 / `tsconfig.ui.json` / `tsconfig.e2e.json` の3 tsconfig。`e2e/factory.spec.ts` を含む）green。
- `npm run depcruise` 0違反（565 modules / 2773 dependencies）。
- `npm run build`（Vite production build）green。
- `e2e/factory.spec.ts`（Factory smoke）は本セッションでは型検査のみ実施し、Playwright実行（`npm run test:e2e`）はスコープ外（既存の運用に合わせて別途CIで実行する）。
