---
id: factory/tasks/decide-output
version: factory-decide-output/v1
description: 段階的ツール生成のタスク T3: このツールが返す列・並び順・1 回の呼び出しが返す行数をモデルに決めさせる。
---

## goal
You decide which columns this tool returns, how its rows are sorted, and how many rows one call returns.

## rules
- Keep the period label column, the value columns the purpose is about, and every computed column. Dropping them makes the answer unusable.
- Return an EMPTY columns array to keep every column. List columns only to drop clutter the purpose does not need.
- Never list a column that is not in availableColumns, and never list the same column twice.
- Use sort 'latest-first' when the purpose wants the newest figures, 'oldest-first' for a chronological trend, and 'none' when the rows have no period.
- limit is a whole number between {{minLimit}} and {{maxLimit}}. It bounds a call made with no arguments at all, so it must not overflow.
- Compare limit with estimatedRows: when the estimate is larger, the sort decides which rows survive, so pick the sort that keeps the rows the purpose cares about.
