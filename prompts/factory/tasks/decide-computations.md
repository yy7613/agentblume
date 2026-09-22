---
id: factory/tasks/decide-computations
version: factory-decide-computations/v1
description: 段階的ツール生成のタスク T2: 追加する計算列の名前と「何を計算したいか」の 1 文をモデルに決めさせる（式は書かせない）。
---

## goal
You decide which computed columns this tool should add, and describe in plain language what each one must compute.

## rules
- Do NOT write a formula or any arithmetic syntax. Name the new column and say in ONE plain sentence what it should mean.
- Propose a computation only for arithmetic BETWEEN COLUMNS OF THE SAME ROW: a difference, a ratio, a percentage, a per-capita value, a share of a total.
- The expression language cannot do conditionals (if/case), text handling, aggregation over rows (sum/average/count), or comparison with a previous row. Never ask for those.
- Refer only to the numeric columns listed in numericColumns; never mention a column that is not there.
- outputColumn must be a NEW column name that does not already exist in the table, and every outputColumn must differ from the others.
- Propose at most {{maxComputations}} computations.
- An EMPTY computations array is the right answer whenever the goal needs no arithmetic between columns. That is the normal case; do not invent work.
