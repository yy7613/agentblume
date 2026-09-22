---
id: factory/tasks/decide-join
version: factory-decide-join/v1
description: 段階的ツール生成のタスク T0: このツールがどの共有キー列でデータソースを結合し、どの結合モードを使うかをモデルに決めさせる。
---

## goal
You decide how this tool joins its data sources: which shared key columns it joins on, and which join mode it uses.

## rules
- Take every key from joinCandidates[].keys. Never invent a column, and never join on a note or free-text column (注記, remarks, 備考).
- Join on ALL the keys the candidate lists (for example BOTH the period AND the region code). One key alone matches every region with every region and multiplies the rows.
- When the sources share both a code and a name for the same thing, the code alone is enough; list the name only if there is no code.
- Use at most {{maxJoinKeys}} keys, each one at most once.
- Use mode 'inner' — it keeps exactly the rows where every source has a value, which is what putting values side by side means.
- Use mode 'left' only when the purpose explicitly needs rows that exist in the primary source alone.
- uniqueLeft / uniqueRight false only means the tool has to narrow that side later; it is not a reason to drop a key.
