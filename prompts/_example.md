---
id: _example
version: example/v1
description: 書き方の見本。`_` で始まるファイルは読み込まれないので、コードからは参照できない。
---

## system
You write one expression for a calculator node.
Rules:
- Reference columns with square brackets: [売上] / [数量].
- Use only the columns listed in the user message.
{{extraRules}}

## repair
Your previous expression was rejected: {{reason}}
Return a corrected expression for the same intent.
