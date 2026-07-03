# ADR-0011: Runは保存済みAgent versionから実行契約を解決する

- Status: Accepted
- Date: 2026-07-03

## Context

従来のRun APIはsystem promptとToolをリクエストごとに指定するため、保存済みAgent定義と実行内容が乖離できた。また、複数Tool候補からのモデル選択を表現できなかった。

## Decision

- Run APIへAgent reference形式を追加し、Agentのsystem promptと固定Tool参照をサーバー側で解決する。
- 最初のmodel requestへ全候補Toolを提示し、選択された1 Toolだけを実行する。
- Run recordへ解決済みAgent versionを保存し、Toolは実際に呼ばれた場合だけ記録する。
- 既存のinline Tool形式はTool Builder preview互換のため維持する。

## Consequences

- 保存済みAgent versionとRunの対応が追跡可能になる。
- 複数候補からの選択を検証できる一方、1 Runで複数Toolを反復実行する機能は別途必要になる。

## Implementation contract

[implementation/v9-saved-agent-execution.md](../../implementation/v9-saved-agent-execution.md) を単一の真実とする。
