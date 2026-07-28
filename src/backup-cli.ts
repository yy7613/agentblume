/**
 * バックアップCLI（`npm run backup`）。
 *
 * サーバーを起動せずにバックアップを作れる／一覧できる／復元できる。**停止中でも動く**ことが要点で、
 * 「壊れて起動しなくなったから戻したい」ときにUIは使えないからである。
 *
 * ## なぜ PowerShell ではなく Node なのか
 *
 * `scripts/` の既存スクリプトは PowerShell だが、あれらは**開発用**（開発サーバーの起動・
 * スクリーンショット撮影）で、Windowsの開発機だけを相手にしている。バックアップと復旧は
 * 利用者の運用手順であり、macOS / Linux でも同じ手順で回せる必要がある。
 * さらに中身は「SQLiteのオンラインバックアップ」なので、どのみち `node:sqlite` を呼ぶNodeが要る。
 * PowerShell から Node を呼ぶ層を挟む理由が無い。
 *
 * ## 使い方
 *
 * ```
 * npm run backup                            # バックアップを作る（暗号鍵は含めない）
 * npm run backup -- --include-secret-key    # 暗号鍵も含める（機密度が上がる）
 * npm run backup -- --list                  # バックアップ置き場の一覧
 * npm run backup -- --restore <名前|パス>   # 復元する（**サーバーを止めてから**）
 * npm run backup -- --db <path> --out <dir> # 保存先・出力先を明示する
 * ```
 */
// Mastra 用 env（テレメトリ無効化・オフライン）を最初に確定させる。import順が意味を持つ（並べ替え禁止）。
import './mastra-runtime-env';
import { createApp } from './composition/root';
import type { LoggerPort } from './application/operations/logger';

/**
 * 運用ログは**stderr**へ出す。stdout は結果のJSONだけに保ち、
 * `npm run backup | jq` のようなパイプが素直に通るようにする（既定の `ConsoleLogger` は stdout）。
 */
const stderrLogger: LoggerPort = {
  info: (message, context) => { process.stderr.write(`agentblume [info] ${message}${context === undefined ? '' : ` ${JSON.stringify(context)}`}\n`); },
  warn: (message, context) => { process.stderr.write(`agentblume [warn] ${message}${context === undefined ? '' : ` ${JSON.stringify(context)}`}\n`); },
  error: (message, context) => { process.stderr.write(`agentblume [error] ${message}${context === undefined ? '' : ` ${JSON.stringify(context)}`}\n`); },
};

const argv = process.argv.slice(2);

function flag(name: string): boolean { return argv.includes(name); }
function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE = [
  'Usage: npm run backup -- [options]',
  '',
  '  (no options)              create a backup of the database and session artifacts',
  '  --include-secret-key      also copy ~/.agentblume/secret.key into the backup',
  '  --list                    list the backups found in the backup directory',
  '  --restore <name|path>     restore a backup (stop agentblume first)',
  '  --db <path>               database file to back up / restore into',
  '  --out <dir>               backup directory (default: <db>.backups)',
  '  --help                    show this message',
  '',
].join('\n');

if (flag('--help') || flag('-h')) {
  process.stdout.write(USAGE);
} else {
  const dbPath = option('--db');
  const out = option('--out');
  const restore = option('--restore');
  // `--restore` は値が要る。値なしで書かれた場合に「バックアップを作る」へ落ちると
  // 復元したかったのに新しいバックアップが増えるだけ、という分かりにくい事故になる。
  const restoreRequestedWithoutValue = flag('--restore') && restore === undefined;

  const app = createApp({
    profile: 'local',
    ...(dbPath === undefined ? {} : { dbPath }),
    ...(out === undefined ? {} : { backupRoot: out }),
    // 保存先の1行ログもCLIの出力（JSON）を汚さないよう stderr へ回す。
    logger: (message: string) => { process.stderr.write(`${message}\n`); },
    errorLogger: stderrLogger,
  });

  /** `close()` は同期契約で二重に呼ぶと throw する。復元経路は先に閉じるのでフラグで見張る。 */
  let closed = false;
  const closeOnce = (): void => { if (!closed) { closed = true; app.close(); } };

  try {
    if (restoreRequestedWithoutValue) {
      process.stderr.write('--restore requires a backup name or path\n\n');
      process.stderr.write(USAGE);
      process.exitCode = 2;
    } else if (restore !== undefined) {
      const restoreBackup = app.restoreBackup;
      // **ファイルを差し替える前に現用DBのハンドルを手放す**。
      // Windows は開いているファイルの rename を拒否する（SQLiteは FILE_SHARE_DELETE を付けない）ため、
      // 閉じないと退避の時点で失敗する。POSIX では rename 自体は通ってしまうが、開いたままの接続は
      // 差し替え前の inode を掴み続けるので、そのまま書き戻すと復元したファイルが上書きされる。
      // どちらの環境でも「先に閉じる」が正解になる。
      closeOnce();
      const result = await restoreBackup.execute(restore);
      process.stdout.write(`${JSON.stringify({ action: 'restore', path: result.path, database: result.database, artifacts: result.artifacts, movedAside: result.movedAside }, null, 2)}\n`);
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    } else if (flag('--list')) {
      const backups = await app.listBackups.execute();
      process.stdout.write(`${JSON.stringify({ action: 'list', root: app.listBackups.root(), backups }, null, 2)}\n`);
    } else {
      const created = await app.createBackup.execute({ includeSecretKey: flag('--include-secret-key') });
      process.stdout.write(`${JSON.stringify({ action: 'create', path: created.path, manifest: created.manifest }, null, 2)}\n`);
      for (const warning of created.warnings) process.stderr.write(`warning: ${warning}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'backup failed'}\n`);
    process.exitCode = 1;
  } finally {
    closeOnce();
  }
}
