# ADR-0012: Agent Tool Loopに固定上限を設ける

- Status: Accepted
- Date: 2026-07-03

## Context

保存済みAgentは複数Tool候補を持てるが、Increment 9では1 Tool call後の追加callを拒否していた。複数データ取得や段階的変換には反復実行が必要だが、無制限ループはコスト、停止性、副作用の面で危険である。

## Decision

- Tool call最大4回、model round最大5回の固定上限を設ける。
- 各roundで同じ固定versionのTool集合を提示する。
- 同一completionの複数callは受信順に実行する。
- preview/testのread-only制約は候補集合全体へ適用する。
- 実行Tool列と各call/resultをRunへ永続化する。

## Consequences

- 複数Toolを必要とするAgent taskを再現可能な範囲で実行できる。
- 4 callを超えるtaskは明示的に失敗するため、将来は用途別policyやWorkflowへの移行が必要になる。

## Implementation contract

[implementation/v10-iterative-tool-loop.md](../../implementation/v10-iterative-tool-loop.md) を単一の真実とする。
