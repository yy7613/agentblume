---
id: factory/tasks/fill-slots
version: factory-fill-slots/v1
description: テンプレート経路のタスク T2: 選んだツールテンプレートのスロットを、スロットごとに挙げた候補の中から埋めさせる。
---

## goal
You fill in the slots of a prepared tool template, choosing every value from the candidates listed for that slot.

## rules
- Every column, key and choice MUST be copied from that slot's candidates. Never write a column name that is not listed.
- Pick the column that answers the purpose: the period column is the one whose granularities cover the periods the goal talks about, the value column(s) are the figures the purpose is about.
- For a slot that takes several columns, choose the smallest set that answers the purpose — every extra column is noise in the answer.
- An optional slot takes null unless the purpose really narrows or splits by that column (for example "by region"). Filling it adds a call argument the agent can get wrong.
- A joinKeys slot takes EVERY shared key column listed (for example BOTH the period AND the region code). One key alone matches every region with every region and multiplies the rows.
- A number slot must stay inside its min..max; when in doubt keep its default.
- A text slot is a short output column name written in the goal language. An intent slot is ONE plain sentence saying what to compute — never a formula.
