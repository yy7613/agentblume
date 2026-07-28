# 運用 runbook（バックアップ・復旧・引っ越し）

この資料は、agentblume を日常的に使う人がデータを失わないための手順書である。手順はそのまま実行できる形で書く。

> **前提**: agentblume はローカル実行のアプリで、データはこのPCの中にしか無い。クラウドの控えは存在しない。

---

## 1. データがどこにあるか

agentblume の状態は **3つの場所**に分かれている。3つの関係を知らないと、正しく戻せない。

| # | 場所 | 既定のパス | 中身 | 失うとどうなるか |
|---|---|---|---|---|
| 1 | **DBファイル** | `~/.agentblume/agentblume.db` | Tool / Skill / Agent / Harness / Wiki / 実行履歴 / 評価資産 / **暗号化された**APIキー | 作ったものが全部消える |
| 2 | **アーティファクト置き場** | `~/.agentblume/agentblume.db.session-artifacts/` | セッションアーティファクトの**実ファイル**（表・グラフのpayload） | DBのカタログだけが残り、開こうとすると壊れる |
| 3 | **暗号鍵ファイル** | `~/.agentblume/secret.key` | 保存済みAPIキーを復号する鍵（AES-256-GCM・32バイト） | **保存済みAPIキーが復号できなくなる**（UIから入れ直せば復旧する） |

- Windows では `~` は `C:\Users\<ユーザー名>` である。
- `AGENTCONTEXT_DB_PATH` を設定している場合、1 と 2 はその場所に付いて動く（2 は常に「DBファイル名 + `.session-artifacts`」）。
- 3 だけは既定でDBと別扱いにしてある。**DBファイルが単体で流出しても平文APIキーを復元できないようにする**ためで、これがバックアップの設計を少しややこしくしている（次節）。
- 実際に使われているDBのパスは起動時のログに出る（`agentblume: database file = …`）。

```powershell
# いま何が置かれているかを見る
ls ~/.agentblume
```

---

## 2. バックアップ

### 2.1 何が作られるか

1回のバックアップで、**1つのディレクトリ**ができる。

```
~/.agentblume/agentblume.db.backups/
  backup-20260728-093012345/
    manifest.json        # スキーマ版・作成日時・リビジョン・鍵の有無
    agentblume.db        # SQLiteのオンラインバックアップ（WAL適用済みの単一ファイル）
    session-artifacts/   # アーティファクトの実ファイル
    secret.key           # 「鍵も含める」を選んだときだけ
```

ディレクトリ名は UTC の `backup-YYYYMMDD-HHMMSSmmm` で、**名前順に並べると古い順**になる。

> **なぜ zip ではないのか**: Node の標準ライブラリにはアーカイバが無く、1ファイルに束ねるには新しい依存を足すか
> zip/tar を自前で書くことになる。復旧に使うものほど依存は少ないほうがよいので、標準APIだけで完結する
> ディレクトリ出力を既定にしている。1ファイルにしたい場合は、できたディレクトリをOS標準のZIP機能で固めればよい
> （エクスプローラで右クリック →「送る」→「圧縮フォルダー」、macOS/Linux は `zip -r`）。

> **なぜファイルコピーではだめなのか**: 稼働中のDBは WAL モードで動いており、直近のコミットは
> `agentblume.db-wal` 側にしか無い。`agentblume.db` を単純にコピーすると**コミット済みのデータが欠けた**
> スナップショットになる。agentblume は SQLite のオンラインバックアップを使ってこれを回避している。
> 手でコピーして済ませないこと。

### 2.2 画面から取る

**ステータス**画面 → 「バックアップと掃除」。

1. 保存先（`バックアップ先`）を確認する。
2. 必要なら「暗号鍵ファイルも含める」にチェックを入れる（判断は §2.4）。
3. 「バックアップを作成」を押す。
4. できたバックアップが下の一覧に増える。保存先パスが表示されるので、そのフォルダを**別のドライブへコピーする**。

サーバーは動かしたままでよい。実行中のAgentがいても取れる。

### 2.3 コマンドラインから取る（サーバー停止中でも可）

```powershell
npm run backup                            # バックアップを作る（鍵は含めない）
npm run backup -- --include-secret-key    # 鍵も含める
npm run backup -- --list                  # バックアップ置き場の一覧
npm run backup -- --db <path> --out <dir> # 保存先・出力先を明示する
npm run backup -- --help
```

- サーバーが起動していてもいなくても動く。**停止中でも取れる**ので、定期実行（タスクスケジューラ / cron）に向く。
- 結果は stdout に JSON、警告は stderr に出る（`npm run backup --silent | jq` がそのまま通る）。
- 出力先の既定は `AGENTCONTEXT_BACKUP_DIR` → 無ければ `<DBファイル>.backups`。

Windows のタスクスケジューラで毎日取る例（`pwsh` から）:

```powershell
$action  = New-ScheduledTaskAction -Execute 'npm' -Argument 'run backup' -WorkingDirectory 'E:\vscode\AgentContext'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName 'agentblume-backup' -Action $action -Trigger $trigger
```

### 2.4 暗号鍵を含めるかどうか

| | 含めない（既定） | 含める |
|---|---|---|
| バックアップの機密度 | DBの中の**APIキーは暗号文のまま**。バックアップ単体では復号できない | **平文APIキーと同じ**。持ち出したら漏洩と同じ扱いになる |
| 同じPCへ戻したとき | 鍵がそのまま残っているので、APIキーもそのまま使える | 同上 |
| **別のPCへ移したとき** | APIキーは復号できない → UIから入れ直す | 鍵を手で置けばそのまま使える |
| 向いている用途 | 日常のバックアップ・世代管理 | PCの引っ越し・機材の入れ替え |

**日常のバックアップでは含めないこと**。鍵と暗号文を同じフォルダで運ぶと、
「DBが流出しても平文キーは守られる」という前提そのものが消える。
引っ越しのときだけ含め、移し終えたら鍵入りのバックアップは消す。

### 2.5 どこへ置くか

既定の出力先はDBファイルの隣である。**同じディスクが壊れたら一緒に消える**ので、これは「取ったこと」でしかない。

- できたディレクトリを別ドライブ・外付けディスク・NASへコピーする。
- または `AGENTCONTEXT_BACKUP_DIR` に別ドライブのパスを設定して、最初からそこへ書かせる。

```dotenv
AGENTCONTEXT_BACKUP_DIR=D:\agentblume-backups
```

古いバックアップは自動で消えない。ディスクが埋まる前に、要らない世代のディレクトリを手で削除する。

---

## 3. 復元

> **必ずサーバーを止めてから行う。** 稼働中のプロセスはDBファイルを開いたまま握っており、その足元で
> ファイルを差し替えるとデータが壊れる。この理由から、**復元はHTTP API・画面からは実行できない**。

### 3.1 手順

```powershell
# 1. 止める（開発サーバーの場合）
.\scripts\start-dev.ps1 -Stop
#    npm start で動かしている場合は Ctrl+C

# 2. 何があるか確認する
npm run backup -- --list

# 3. 戻す
npm run backup -- --restore backup-20260728-093012345

# 4. 起動して確認する
npm start
```

`--restore` には一覧に出た**名前**か、バックアップディレクトリの**絶対パス**を渡す。

### 3.2 復元が行うこと

1. `manifest.json` を検証する。**壊れている・スキーマ版がこのビルドより新しい**場合はここで中止する（現用データには触らない）。
2. 復元先のDBが使用中でないかを確認する。使用中なら中止する。
3. 現用のDBとアーティファクト置き場を **消さずに退避**する（`agentblume.db.pre-restore-<時刻>`）。
4. バックアップのDBとアーティファクトを所定の場所へ置く。古い `-wal` / `-shm` は削除する。

「戻したら前より悪くなった」ときは、退避された `*.pre-restore-*` を元の名前に戻せば引き返せる。
問題が無いことを確認したら、退避分は手で削除してよい。

### 3.3 暗号鍵は自動で上書きしない

鍵を含むバックアップから復元しても、**現用の `secret.key` は自動では置き換えない**。
いま動いている鍵で復号できるデータを、黙って壊さないためである。必要なときだけ手で置く。

```powershell
# 現用の鍵を退避してから置き換える（必ず退避すること）
Move-Item ~/.agentblume/secret.key ~/.agentblume/secret.key.old
Copy-Item <バックアップのパス>/secret.key ~/.agentblume/secret.key
```

鍵を入れ替えたあと保存済みAPIキーが復号できない場合は、**設定画面から入れ直す**のが確実な復旧手段である。

---

## 4. 別のマシンへ引っ越す

1. 旧マシンで**鍵を含めて**バックアップを取る。

   ```powershell
   npm run backup -- --include-secret-key
   ```

2. できたディレクトリを新マシンへ丸ごとコピーする（USBメモリ・共有フォルダなど。**このディレクトリは
   平文APIキーと同じ機密度**なので、公開の場所を経由させないこと）。
3. 新マシンで agentblume を用意する（`npm install` → `npm run build`）。**旧マシンと同じか新しいバージョン**であること。
4. 新マシンで復元する。

   ```powershell
   npm run backup -- --restore <コピーしたディレクトリの絶対パス>
   ```

5. §3.3 の手順で `secret.key` を置き換える。
6. `npm start` で起動し、設定画面でモデル接続のテストが通ることを確認する。
7. **移し終えたら、鍵入りのバックアップと持ち運びに使ったメディアを消す。**

APIキーを入れ直してもよいなら、鍵を含めずに 1〜4 と 6 だけでよい（そのぶん持ち運びの機密度が下がる）。

---

## 5. ディスクを管理する（retention）

実行履歴（Run）は放っておくと無制限に増える。agentblume は**保持期限**で自動的に掃除する。

| 設定 | 既定 | 内容 |
|---|---|---|
| `payloadDays` | 30日 | この日数を過ぎたRunの入出力payloadを伏せ字にする |
| `traceDays` | 14日 | この日数を過ぎたRunのトレースを伏せ字にする |
| 両方を過ぎたRun | | 行ごと削除する |
| `aggregateDays` | 365日 | 日次集計（Runを逆引きできない匿名の統計）を削除する |
| `auditDays` | 365日 | 監査ログ（誰が何をしたか）を削除する。**30日未満は設定できない** |

> 監査ログの既定が trace（14日）よりずっと長いのは意図的である。監査が答える問いは「先月あの設定を変えたのは誰か」で、実行トレースと同じ寿命では用を成さない。
>
> `auditDays` にだけ下限（30日）があるのは、**0を許すと「変更した記録ごと」消せてしまう**ためである。`PUT /operations/retention` の監査行は変更時刻で書かれるので、`auditDays: 0` にした直後に適用すれば `deleteBefore(いま)` がその行を含めて消し、残るのは「誰かが operate に成功した」1行だけになる。「保持期限の変更そのものが監査対象だから大丈夫」は成り立たない。下限があると、消せるようになるまで30日待つ必要が生まれる。併せて `PUT /operations/retention` は**変更後の値（payloadDays / traceDays / aggregateDays / auditDays）を監査 detail へ載せる**ので、短縮の意図そのものが記録に残る。

- 自動実行は24時間ごと（`AGENTCONTEXT_RETENTION_INTERVAL_MS`。`0` で無効）。初回は起動直後ではなく1インターバル後。
- **いますぐ掃除したい**ときは、ステータス画面の「保持期限をいま適用」を押す。削除件数が表示される。
- 保持期限そのものは `PUT /operations/retention` で変更する。

掃除しても**DBファイルは自動で小さくならない**。SQLiteは削除した領域を解放せず、以後の書き込みで再利用する
（＝「縮む」のではなく「それ以上増えなくなる」）。空き領域を実際に切り詰める操作（`VACUUM`）は
agentblume からは提供していないので、ディスクの逼迫は retention とバックアップ世代の削除で管理する。
バックアップ側のディレクトリは自動削除されないため、こちらの方が先に効くことが多い。

アーティファクトの実ファイルはセッション単位で管理され、Runの削除に追随する。
`agentblume.db.session-artifacts/` が異常に大きい場合は、まず retention を適用してから様子を見る。

---

## 6. トラブルシュート

### 「database is locked」「SQLITE_BUSY」が出る

同じDBファイルを2つのプロセスが同時に触っている。

```powershell
.\scripts\start-dev.ps1 -Stop   # 残っている開発プロセスを止める
```

- 開発サーバーと `npm start` を同時に起動していないか確認する。
- バックアップの**取得**は同時に動いてよい（WALのため）。**復元**だけは占有が要る。

### 復元しようとして「the database is currently in use」

サーバー（または別のCLI）がまだ動いている。全部止めてからやり直す。
`-Stop` で止まらない場合は、タスクマネージャーで `node` プロセスを確認する。

### 起動時に「database schema version N is newer than this build supports」

**新しいバージョンの agentblume が書いたDBを、古いビルドで開こうとしている。**
データを壊さないために起動を止めている。古いビルドへ「戻る」のではなく、agentblume を新しくする。

```powershell
git pull
npm install
npm run build
npm start
```

同じメッセージは復元時にも出る。その場合、そのバックアップは今のビルドでは戻せない（先にビルドを上げる）。

### 復元しようとして「backup manifest could not be read」

`manifest.json` が無い、または壊れている。バックアップ作成中にプロセスが落ちた場合にこうなる。
**マニフェストは最後に書かれる**ので、無い＝未完成という判定である。そのディレクトリは削除して、別の世代から戻す。
画面の一覧でも「未完成のバックアップ」と表示される。

### APIキーが「Stored secret could not be decrypted with the current key file」になる

DBと鍵ファイルの**組み合わせが合っていない**。よくある原因:

- DBだけを復元して、鍵は別マシンのものが残っている
- `AGENTCONTEXT_SECRET_KEY_PATH` を変更した / 鍵ファイルを消した

復旧手段は2つ。

1. 対応する鍵ファイルがあるなら §3.3 の手順で置き換える。
2. 無いなら、**設定画面からAPIキーを入れ直す**（これで完全に直る。他のデータには影響しない）。

### バックアップが「ENOSPC」「EACCES」で失敗する

- `ENOSPC`: バックアップ先のディスクが満杯。古い世代を消すか、`AGENTCONTEXT_BACKUP_DIR` を別ドライブへ向ける。
- `EACCES` / `EPERM`: サーバープロセスに書き込み権限が無い。フォルダの権限を確認するか、書き込めるパスを指定する。

### 「the database is in-memory (:memory:)」でバックアップできない

`AGENTCONTEXT_DB_PATH=:memory:` で起動している。この設定は使い捨て検証用で、**データはプロセス終了時に消える**。
残したいなら `.env` の `AGENTCONTEXT_DB_PATH` をファイルパスにして（または行ごと消して既定に戻して）再起動する。

### 動いているビルドが分からない

```powershell
curl http://127.0.0.1:3030/health
```

`AGENTCONTEXT_SOURCE_REVISION` を設定していれば `revision` が返る。同じ値がバックアップの `manifest.json` にも入るので、
「どのビルドが書いたバックアップか」を後から突き合わせられる。

---

## 7. チェックリスト

- [ ] バックアップを取っている（画面から手動 / `npm run backup` を定期実行）
- [ ] バックアップ先が**DBとは別のディスク**にある、またはそこへコピーしている
- [ ] 日常のバックアップに**鍵を含めていない**
- [ ] 復元を**一度は試した**（本番で初めて試さない。空きディレクトリへ `--db` を向ければ安全に練習できる）
- [ ] 古い世代を定期的に消している
- [ ] retention の設定が用途に合っている

```powershell
# 復元の練習（現用データに触らない）
npm run backup -- --db C:\temp\restore-drill\agentblume.db --restore <バックアップの絶対パス>
```

---

## 関連

- [02-tech-stack.md](./02-tech-stack.md) — 永続化・秘密値の保管・バックアップの設計
- [08-security-auth.md](./08-security-auth.md) — 秘密値の取り扱い
- [.env.example](../.env.example) — `AGENTCONTEXT_DB_PATH` / `AGENTCONTEXT_SECRET_KEY_PATH` / `AGENTCONTEXT_BACKUP_DIR`
