# v10 実装契約: Bounded Iterative Tool Loop

> Increment 10 の単一の真実。Increment 1〜9を前提とする。

## 1. 目的

Agentが1回の応答生成中に複数Toolを順次利用できるようにする。無制限ループや暗黙の副作用実行を避けるため、候補Tool・call数・model round数を固定上限で制御する。

## 2. Loop contract

- 1 RunあたりTool callは最大4回。
- 最終応答を得るmodel roundは最大5回。
- 各roundでAgent versionに固定された同じTool definition集合を提示する。
- 1 completion内の複数Tool callを順番に実行し、対応する全Tool messageを次roundへ渡す。
- Tool callなしのassistant messageを最終応答とする。
- 上限超過、未知Tool、引数不正、追加roundでのunsafe ToolはRun失敗として永続化する。

## 3. Trace / Run record

- model-request / tool-call / tool-resultを実行順の連番で記録する。
- Run recordへ実際に呼ばれたTool参照を呼び出し順で`tools`として保存する。
- 既存互換の`tool`は最後に呼ばれたToolを示す。
- usageは全model roundを合算する。

## 4. 完了条件

- 2種類のToolを順次呼ぶ正常系、同一roundの複数call、直接応答、上限超過をunit/API testで確認する。
- Status / Agent Builderの既存trace表示で全callを追跡できる。
- Playwright、typecheck、全test、coverage、depcruise、production build、実HTTP smokeが成功する。
