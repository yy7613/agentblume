---
id: factory/tasks/select-template
version: factory-select-template/v1
description: テンプレート経路のタスク T1: 用意されたツールテンプレートのどれがこの計画のツールを作れるかを 1 つ選ばせる（どれも合わなければ none）。
---

## goal
You choose which prepared tool template builds the tool described by this plan, or answer "none" when no template fits.

## rules
- Choose the template whose whenToUse lines match what the purpose asks for. Read notFor too: if it names what this tool must do, that template is the wrong one.
- When the goal asks for a NUMBER that has to be computed (a change versus last year, a growth rate, a ratio or per-capita value, an average/min/max, a correlation, a ranking), prefer the template that computes it, over a template that only looks values up. The agent must never do the arithmetic itself.
- Prefer a plain lookup template only when the purpose really is "return the values" and no computed number is asked for.
- A template that reads two data sources is only right when the plan itself joins sources; templates are listed only when they fit this plan's data, so pick by meaning, not by source count.
- Answer "{{noTemplate}}" when none of the listed templates matches the purpose. That is a normal, correct answer: the tool is then built another way.
- templateId must be copied exactly from the listed ids. Never invent one.
- reason is ONE short sentence naming the part of the purpose that decided it.
