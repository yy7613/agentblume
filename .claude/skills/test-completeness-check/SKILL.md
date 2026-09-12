---
name: test-completeness-check
description: ユニットテストの網羅（正常/異常/境界/例外）を監査し、新しく書いたテストが「修正前のコード」で本当に赤になるかを確認する。テストを書いた後・修正の PR を出す前・「テストは十分か」と聞かれたときに使う。verify tests, audit test coverage categories, red-green check, run new tests against HEAD.
---

# test-completeness-check

テストの**量**ではなく**質**を確かめる開発用ツール。2つの検査を 1 本のドライバで行う。
パスはすべてリポジトリルート（`E:\vscode\AgentContext`）からの相対。

| 検査 | 何を見るか | 出力 |
|---|---|---|
| `audit` | 変更されたテストファイルの `it()` を **正常 / 異常 / 境界 / 例外** に分類し、欠けている観点を出す。本体が変わったのに対応するテスト変更が無いファイルも列挙する | `OK` / `MISS` 行 + 欠落観点 |
| `red` | 変更・追加したテストを **修正前のコード（`--base`、既定 `HEAD`）** で実行し、新規テストが赤になるか（＝修正を検証しているか）を確かめる。作業ツリーには触れない | `OK` / `WARN` / `RED` 行 + 「修正なしでも通る」テスト名 |

## 前提

Node 22（`.nvmrc`）、`npm ci` 済み、git。追加インストールは不要。Windows では `red` が `C:\Windows\System32\tar.exe`（標準の bsdtar）を使う。

## 使い方（エージェント向け・まずこれ）

修正とテストを書き終えた直後、コミットする前に、リポジトリルートで:

```powershell
node .claude/skills/test-completeness-check/driver.mjs audit
```

出力例（このセッションで実際に出たもの。`MISS` は欠けている観点、末尾は本体変更にテスト変更が伴わないファイル）:

```text
MISS src/adapters/factory/in-process-factory-worker.test.ts  it=10  正常=3 異常=7 境界=2 例外=0  欠落: 例外
OK  src/application/etl/engine.test.ts  it=59  正常=21 異常=32 境界=29 例外=28
MISS src/api/harness-run-routes.test.ts  it=5  正常=0 異常=5 境界=1 例外=2  欠落: 正常

本体が変更されたのに対応するテストの変更が無いファイル:
  - src/adapters/storage/sqlite-factory-run-repository.ts
  - src/application/tool/preview-tool.ts
```

`MISS` の観点を本当に足すべきかは人が判断する（例: 型で不正入力を弾くモジュールに「例外」は無くてよい）。分類はタイトルと本文のキーワードによるヒューリスティックで、日本語・英語の両方を見る。

次に、新しいテストが修正前で赤になるかを確認する。対象を絞ると速い（2 ファイルで約 2 秒 + vitest の起動）:

```powershell
node .claude/skills/test-completeness-check/driver.mjs red src/domain/harness/harness-run.test.ts src/application/factory/cancel-factory-run.test.ts
```

出力例:

```text
RED  src/application/factory/cancel-factory-run.test.ts  ファイル全体が旧コードで実行不能（import/型エラー）: Cannot find module './abort' ...
WARN src/domain/harness/harness-run.test.ts  新規 it=12  赤(検証)=6 赤(API不在)=1 回帰固定(緑)=0 緑=5  既存: 赤=0 緑=0
     ⚠ 修正なしでも通る: running / waiting-* のレコードへは終端マーカーを含めどのイベントも足せる（ガードは終端だけに効く）
```

読み方:

- **赤(検証)** — 旧コードで期待どおり失敗。修正を検証している。これが本命。
- **赤(API不在)** / **RED（ファイル全体が実行不能）** — 新しい関数・モジュールが旧コードに無く、実行できない。赤ではあるが「振る舞いの差」を証明していない。可能なら旧コードでも呼べる形（既存の API 経由）で振る舞いを固定するテストも 1 本置く。
- **緑（修正なしでも通る）** — その `it` は今回の修正を検証していない。意図的に既存挙動を固定する回帰テストなら、タイトルに `[回帰固定]` か「従来どおり」を入れると **回帰固定(緑)** として警告から外れる。そうでなければテストを見直す（期待値が緩い、修正した経路を通っていない）。

引数を省略すると `HEAD` との差分にあるテストファイル全部が対象になる（このセッションの実測: 30 ファイルで `all` が 122 秒。結果は OK 14 / WARN 13 / RED 3 で、WARN があるので終了コード 1）。`--base <ref>` で比較元を変える（例: `--base origin/main`）。`--json` で機械可読、`--strict`（audit）で欠落があれば終了コード 1。`red` は「修正なしでも通る」新規テストが 1 つでもあれば終了コード 1。

まとめて回すなら:

```powershell
node .claude/skills/test-completeness-check/driver.mjs all
```

## 仕組み（`red` が作業ツリーを壊さない理由）

1. `git archive --format=tar <base>` で修正前のスナップショットを一時ディレクトリ（`%TEMP%\red-check-*`）へ展開する。`git stash` / `checkout` は使わない（並行作業中の変更を巻き込む事故を避ける）。
2. `node_modules` はコピーせず**ジャンクション**で共有する（コピーは数分かかる）。
3. 変更・追加された**テストコードだけ**（`*.test.*` / `*.contract.*` / `*.fixtures.*` / `test-support/`）を作業ツリーから上書きコピーする。本体コードは修正前のまま。
4. その中で `npx vitest run --reporter=json` を回し、`it` タイトルを base 版と照合して「新規」と「既存」に分け、失敗メッセージから **assertion 失敗**と **API 不在（import/TypeError/ReferenceError）** を見分ける。`it.each` のテンプレートタイトル（`%s`, `$name`）は展開後の文字列と正規表現で照合する。
5. 終了時にジャンクションを外してから一時ディレクトリを削除する（`--keep` で残す）。

## Gotchas（実際に踏んだもの）

- **Git Bash から起動すると MSYS の `tar` が `H:\Temp\...` を解釈できず status 128 で落ちた。** ドライバは Windows では System32 の `tar.exe` を絶対パスで呼ぶので、PowerShell / cmd / Git Bash のどこから呼んでも同じ。
- **`git diff` を 2 つ同時に走らせると `index.lock` の取り合いで片方が落ちる。** ドライバは `git --no-optional-locks` で読むので、IDE の git 連携や別の `red` 実行と並行しても大丈夫。
- **残った `red-check-*` を手で消すとき、`rm -rf` は絶対に使わない。** `node_modules` はジャンクションなので、辿って本物の `node_modules` を消す。`--keep` した後の片付けは `Remove-Item <dir>\node_modules`（ジャンクションだけ外す）→ `Remove-Item -Recurse <dir>` の順。ドライバの自動片付けはこの順で行う。**実行中の `red` の一時ディレクトリに触ると、その実行の vitest が途中で壊れる**（このセッションで一度やった）。
- `it.each` の展開タイトルが「新規」と誤判定されて数十件の偽 WARN が出た。テンプレート照合を入れて解消済み。新しい形のテンプレート（`%o` 以外の独自記法）を使う場合は照合に漏れるので、その `it` は既存でも「新規・緑」と出る。
- 小文字ドライブ（`e:\`）の cwd では vitest が全滅する。ドライバは `git rev-parse --show-toplevel`（大文字で返る）へ `chdir` してから動く。手で `npx vitest` を叩くときは `E:\` に `cd` する。

## Troubleshooting

| 症状 | 原因と対処 |
|---|---|
| `red: 対象のテストファイルがありません。`（終了コード 2） | base との差分にテストファイルが無い。`--base` を確認するか、ファイルを引数で渡す。 |
| `vitest の結果ファイルが生成されませんでした` | 一時ディレクトリでの vitest 起動自体が失敗。`--keep` で残して `<dir>\vitest-result.json` の有無と直前の stdout/stderr（ドライバが末尾 4000 文字を出す）を見る。`node_modules` ジャンクションが無ければ `npm ci` 未実施。 |
| `RED ... ファイル全体が旧コードで実行不能` が大量に出る | 新しいモジュールをテストが直接 import している。想定どおりの結果だが検証としては弱い。既存 API 経由の振る舞いテストを足すか、そのまま「API 不在」として受け入れる。 |
| `MISS ... 欠落: 正常` | 異常系だけのテストファイル（例: ルートの 403/404 だけ）。1 本は成功経路を置く。 |
