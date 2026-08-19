# ADR-0035: domain/shared の設立と境界変換規約

- Status: Accepted
- Date: 2026-08-18
- 関連: [docs/05-dependency-graph.md](../05-dependency-graph.md) / [docs/03-domain-model.md](../03-domain-model.md) / [ADR-0001](./0001-layered-single-package.md) / [ADR-0034](./0034-domain-primitive-tiers-and-id-types.md)

## 文脈

[ADR-0034](./0034-domain-primitive-tiers-and-id-types.md) の Brand / Flavor を全 BC から使うには、どの BC にも属さない共有置き場が必要である。しかし src/domain/ 直下は BC フォルダのみで共有カーネルがなく、次のひずみがある。

1. `TenantScope` / `tenantKey` は全 BC 横断のテナント分離概念でありながら tool BC（src/domain/tool/ids.ts）にあり、全 BC が tool へ横断 import している。
2. 非空文字列検証（`must be a non-empty string`）が 11 ファイルに重複し、単一情報源がない。既に意味論の分岐（tool の createTool のみ trim しない）も発生している。
3. 境界（HTTP/DB）との変換規約が明文化されておらず、adapters/storage には `JSON.parse(...) as DomainType` の生キャストが複数残っている。

関連実装は src/domain/shared/ として着手済みである。本 ADR は shared の設立条件・内容物・非内容物と、境界変換規約を定める。

## 決定

### 1. src/domain/shared/ を唯一の共有カーネルとし、葉に保つ

全 BC が依存してよい共有置き場は src/domain/shared/ のみとし、shared 自身は**他 BC・他層に依存しない葉に保つ**。この制約は dependency-cruiser の新ルール `domain-shared-is-leaf`（[.dependency-cruiser.cjs](../../.dependency-cruiser.cjs)）で機械強制する。

理由: 共有カーネルは依存の吸引点になりやすく、レビュー頼みでは肥大化する。層境界を depcruise で強制する既存方針（[ADR-0001](./0001-layered-single-package.md)）と同じ機構で守る。

### 2. 初期内容物は brand / errors / assert / tenant-scope の4ファイルとする

- **brand.ts**: Brand / Flavor 型（[ADR-0034](./0034-domain-primitive-tiers-and-id-types.md) 決定2）。
- **errors.ts**: `SharedValidationError`（code `'DOMAIN_VALIDATION'`）と `ErrorFactory` 注入規約。shared の検証ヘルパーは既定でこのエラーを投げるが、各 BC は ErrorFactory を注入して自 BC のエラー型（AgentValidationError 等）を維持できる。
- **assert.ts**: `assertNonEmpty` — 11 ファイルに重複していた非空検証の単一情報源。エラーファクトリとラベル（`createAgent: name` 等）の注入により、BC 別エラー型と既存メッセージのバイト単位互換を維持する。tool BC の createTool のみ歴史的に trim しない（空白のみの文字列を許す）ため、この意味論を `{ trim: false }` オプションとして保存する。
- **tenant-scope.ts**: `TenantScope` / `tenantKey` を tool/ids.ts から実体移設する。旧パス（tool/ids.ts）は再エクスポートを維持し、既存 import を無修正で通す。

### 3. SemVer / ToolError / ToolValidationError は tool BC に残置する

SemVer も他 BC から横断利用されているが、shared へ移設しない。SemVer は `ToolValidationError` に依存し、その code `'TOOL_VALIDATION'` は HTTP エラーマッピング（[src/api/error-mapping.ts](../../src/api/error-mapping.ts): ToolValidationError → 400 TOOL_VALIDATION）経由で API 契約になっている。移設はエラー階層か API 契約のどちらかへ手を入れることになり、リスクが利益を上回る。他 BC からの tool/semver 横断 import は既存慣行として容認し、移設は将来の独立作業とする。

### 4. 境界変換規約: 境界はプリミティブ、ドメイン内は VO、変換は縁で一度だけ

**境界（HTTP/DB/外部SDK）を流れる表現は常に JSON-safe なプリミティブ / plain object とし、ドメイン内は VO を使う。変換は境界の内側の縁で一度だけ行う。**変換点は各 BC のデシリアライザ（src/domain/*/serialization.ts）と API ルートとする。ADR-0034 の Tier 1（実行時表現 = プリミティブ）はここと噛み合い、ID 類の「変換」は型注釈のみで実行時コストを持たない。

あわせて**読み寛容・書き厳格**とする。デシリアライザは既存永続データに寛容であり続け、厳格化は生成点（ファクトリ / API 入力検証）から行う。

理由: 変換点が散在すると同じ値が場所により VO だったり素の値だったりして型の保証が意味を失う。読み手側を厳格化すると過去の永続データの読み出しが壊れる（fail closed にすべきは書き込み側である）。

### 5. adapters/storage での `JSON.parse(...) as DomainType` 生キャストを禁止する

永続データの復元は各 BC のデシリアライザ（serialization.ts）を経由する。既知の違反（sqlite-data-source-repository ほか）は本 ADR 時点で残存しており、是正は後続マイルストーンとする（新規コードへの適用は即時）。

### 6. エラーメッセージの共通化はメッセージ不変が絶対条件とする

既存のエラーメッセージは (a) UI 日本語化（[src/ui/api/error-messages.ts](../../src/ui/api/error-messages.ts) が生メッセージへの正規表現一致で翻訳する）と (b) テストの期待値、の二重の契約である。shared への検証委譲は、ErrorFactory とラベル注入によりメッセージをバイト単位で不変に保てる場合のみ許可する。メッセージ自体を変える改善は、UI 翻訳とテストを同時に更新する独立作業として扱う。

## 検討した代替案

| 代替案 | 不採用の理由 |
|---|---|
| SemVer を shared へ移設し旧パスを再エクスポート | SemVer は ToolValidationError に依存するため、エラーごと移設すると code 'TOOL_VALIDATION' の API 契約か tool のエラー階層に手が入る。エラーを tool に残して SemVer だけ移すと shared → tool 依存が生じ、葉の制約（決定1）が崩れる。横断 import の容認のほうが総リスクが小さい |
| 検証エラーを SharedValidationError へ全 BC 統一 | エラー型・code・メッセージは HTTP マッピング・UI 日本語化・テストの契約であり、統一は互換破壊になる。ErrorFactory 注入（決定2）で BC 別エラー型を保ったまま実装だけを共有できる |
| domain/ 直下や src/util/ へ共有コードを平置き | TenantScope 等はドメイン概念であり、層外の util へ出すと depcruise の層ルールの保護外になる。domain/ 直下への平置きはパスベースの BC 境界判定を曖昧にし、葉の機械強制（決定1）が書けない |
| 境界検証を zod 等で全面導入 | domain 層へ外部ライブラリを持ち込まない既存方針（ADR-0020 ほか）に反する。既存の手書きデシリアライザとの二重検証になり、エラーメッセージ契約（決定6）も壊れやすい |
| shared を設けず各 BC の重複を容認し続ける | 検証の修正が 11 箇所への同期修正になり、意味論の分岐（tool の trim なし）が既に発生している。Brand / Flavor（ADR-0034）の置き場も定まらない |

## 帰結

- (+) 重複検証が単一情報源になり、既存のエラー型・メッセージ・テストは無修正のまま通る。
- (+) TenantScope の tool 横断 import が解消へ向かう（旧パスは互換維持のため既存コードも無修正）。ADR-0034 の型群の置き場が確定する。
- (+) 境界変換点が serialization.ts と API ルートに固定され、生キャストを検出するレビュー観点と depcruise 強制の土台が明確になる。
- (−) SemVer の横断 import という非対称は残る（容認。移設は将来の独立作業）。
- (−) 既知の生キャスト違反は当面残存する（後続マイルストーンで是正）。
- (−) ErrorFactory / ラベル注入の呼び出しは素朴な throw より冗長になる。
