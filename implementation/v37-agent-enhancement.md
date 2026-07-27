# v37 実装契約: Agent Factory による既存エージェントの強化

> Agent Factory を「0→1 生成」専用から、**既存エージェントを強化・改善する装置**へ広げる。
> 目的は「Tool/Skill を足す」「検証シナリオを回して評価する」「その結果でコンテキスト（systemPrompt / Skill instructions / Tool契約）を改善する」を、既存の改善ループに載せて自動で回すこと。
> 前提: v36 まで完成・全green。新規依存なし。

## 0. 規約

strict / Zod v4 / Vitest / 非mutate / depcruise 0違反 / カバレッジゲート(90/90/90/80)維持 / 既存の生成モードの挙動を変えない。

## 1. 改善提案エンジンの強化（土台）

v33 時点の改善ループは「既存の参照をバージョン差替する」ことしかできなかった。強化に必要な**能力の追加**を解禁する。

- **`add-tool` を実装**（従来は `apply-improvements.ts` で常に却下・Analystのプロンプトでも抑制）。Stage 2 の Tool 生成＋修復ループを `generate-agent-assets.ts` の **`generateToolWithRepair`** として切り出し、生成フローと改善ループで共有する。`sideEffect` は生成側=read-onlyへ丸める / add-tool側=違反なら却下（既存Agentの強化で副作用付きToolを黙って別物へ差し替える方が危険なため）。
- **`add-skill` を新設**。`FactorySkillPlan`（Runローカルのkey空間・`validateFactoryPlan` が参照整合を強制）を流用せず **`FactoryAddSkillPlan`** を別型にする。`toolRefs` は保存済みToolを internalId → publishName → `agentTool.name` → 同一イテレーションの add-tool key の順で解決し、1つでも解決できなければ提案ごと却下。`instructions` は Analyst が書く（`skill-instructions-revision` と同じ流儀。SkillWriter を注入せずロール呼び出しを増やさない）。
- **参照の追加に対応**: Agent 新版の `tools`/`skills` を「既存参照のバージョン差替」から**和集合**へ（同 internalId は新版優先）。
- **既存Agentのフィールド保全（既存バグの修正）**: Agent 新版作成時に `kind` をハードコードし `agents` / `mcpServers` / `harness` / `output` / `state` を落としていた。Factory生成Agentは持たないので顕在化していなかったが、**既存Agent（harness設定やMCP接続を持つもの）を改善対象にすると黙って設定が消える**。すべて引き継ぐ。
- Analyst のプロンプトから add-tool 抑制を外し、濫用防止規則（既存Toolの改訂で足りるなら出さない・1イテレーションの追加提案は2件まで）を入れる。Scenario/Persona の変更提案は引き続き禁止。
- Analyst 入力に任意 `availableDataSources` を追加。**これを渡さないと add-tool は提案されない**（プロンプトと `isValidTarget` の二重ゲート）。`run-factory` が Stage 0 の profiles を要約して渡す（生成モードでも渡すので、生成モードでも add-tool が有効になる）。

## 2. 強化モードの入口

`FactoryRun['input']` に **`baseAgent?: { internalId, version? }`**（未指定＝従来の生成モード、`version` 省略＝最新版）。縦断更新: domain型 / `startFactoryRun` / serialization(zod) / `CreateFactoryRunUseCase` / `RetryFactoryRunUseCase` / `factoryRunBodySchema` / routes / DTO。

`dataSourceIds` は **強化モードでのみ 0..5**（生成モードは 1..5 必須）。既存Agentのプロンプト改善だけなら新規データソースは要らない。

## 3. ステージの読み替え

| Stage | 強化モードの挙動 |
|---|---|
| 0 profiling | `baseAgent` をロード（未存在 / `kind !== 'normal'` は Run 失敗）。`loadCurrentSkillContracts` / `loadCurrentToolContracts` で現有能力を把握。データソース0件ならプロファイルは空 |
| 1 planning | Planner に `currentAgent {displayName, systemPrompt, tools[], skills[]}` を渡し**ギャップだけ**計画させる（既存能力は再計画しない・既存Toolで足りるなら `reuse`）。承認プロンプトも強化モード用の文言 |
| 2/3 generating | 計画された追加分のみ。**全Tool欠落でもRunを失敗させない**（既存Agentは動くため。生成モードは従来どおり失敗） |
| 4 assembling | `integrateAssetsIntoAgent` で既存Agentの patch 新版。追加0件なら**新版を作らず**既存版Refを artifacts へ |
| 5+ | 無改修で流用（`runValidationIteration` / `finalizeOrImprove` は元から Agent版を差し替えながら再検証する設計） |

**systemPrompt の再合成**は LLM に書き直させず、`replaceGuideSections` で決定的に行う: トップレベル見出し（`# `）でセクション分割し、Skillガイド / Tool使用ガイドの2節だけを差し替える。役割文・実行規則・利用者が書き足した節は一字一句保持する（既存プロンプトは利用者の資産であり、LLMの再起草で本番Agentのペルソナや業務ルールが黙って変わる方が危険）。見出しの無い自由記述プロンプトは末尾追記へフォールバック。`owner` も既存を継承し `FACTORY_OWNER` で潰さない。

`FactoryStage` / `FactoryEventKind` は**増やさない**。強化モードであることはイベントの `message`（`enhancing agent <name>@<ver>` / `enhanced existing agent ...` / `... kept as-is (no capability added)`）と `report.summary` の先頭で表現する。

## 4. UI

Factory画面のRun作成フォームに**モード切替**（新しく作る / 既存を強化）。強化モードでは対象Agentの `<select>`（`listAgents(scope,'normal')`）が必須になり、データソースは任意である旨を注記、Goalの説明も「どう改善したいか」に変わる。一覧ラベルは `強化: <Agent名>`、詳細にモードバッジ、承認カードは「既存Agent への変更計画」＋追加Tool/Skill件数、レポートは追加0件のとき「コンテキストの改善のみ」と明示する。

堅牢性: Agent一覧の取得失敗は画面全体を巻き添えにせず空配列へ倒す（強化モードを選ぶと案内が出る）。データソースは上限5件でチェックボックスを止める（従来は6件目を選べて400で初めて気づいた）。

## 5. 既知の制約

- 強化対象は `kind: 'normal'` のAgentのみ（pseudo-user / evaluator は対象外）。
- `state` は起点版を継承するため、published Agent を強化すると新版も published になる。
- `add-skill` の `instructions` は Analyst の生成物であり、SkillWriter ロールは通らない。
- `replaceGuideSections` は任意のH1で区切るため、Skill instructions が H1 を含むと差し替え範囲が早く切れる（利用者記述の消失より安全側に倒した結果）。
- モードを往復しても選択済みデータソースは保持される（強化モードでも送信対象）。

## 6. 検証

`npx vitest run` 228 files / **2187 passed**、`npm run typecheck` 0、`npm run depcruise` 0（690 modules）、`npm run test:cov` 合格（Stmts 91.42 / Branch 82.11 / Funcs 92.21 / Lines 95.68）。vitestは大文字ドライブ（`E:\`）で実行。
