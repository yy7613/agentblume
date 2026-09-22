---
id: factory/tasks/decide-filters
version: factory-decide-filters/v1
description: 段階的ツール生成のタスク T1: 期間列の扱いと、呼び出し引数として公開するカテゴリ列をモデルに決めさせる（複数値フィルタを持たないビルドではカテゴリの 1 行だけ入れ替わる）。
---

## goal
You decide how this tool narrows its rows: how it handles the period column, and which category columns it exposes as call arguments.

## rules.head
- When a period column has "mixed": true, rows of several granularities share it, so you MUST pin the granularity: pick a fixed one, or 'argument'.
- Pick 'argument' only when the goal really needs more than one granularity (monthly AND yearly); then defaultGranularity must be one of the granularities present in that column.
- With a fixed granularity, leave defaultGranularity null. Set period to null only when the data has no period column.
- Set range to true whenever the goal mentions a span of time, a trend, the latest figures, or a maximum over time; false only for a single fixed label.

## rules.category.multi
- Add a category filter only for a column the goal actually narrows on, and always set multi to true: one call must be able to ask for several values, or a comparison costs one call per value.

## rules.category.single
- Add a category filter only for a column the goal actually narrows on; multi must be false because this build accepts a single value per argument.

## rules.tail
- Keep at most {{maxCategoryFilters}} category filters: the conversation has only {{maxToolCalls}} tool calls, and every extra argument is one more thing the agent can get wrong.
- Argument names are snake_case ({{argumentPattern}}), unique, and may not be {{reservedArguments}}: the tool declares those itself.
- An empty categoryFilters array is the right answer when the goal needs no narrowing by category.
