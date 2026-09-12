#!/usr/bin/env node
/**
 * test-completeness-check driver
 *
 * 2つの検査を行う開発用ツール（製品コードではない）。
 *
 *   audit  変更されたテストファイルの it() を 正常 / 異常 / 境界 / 例外 に分類し、欠けている観点を出す。
 *          変更された本体ファイルにテスト変更が伴っているかも見る。
 *   red    変更・追加されたテストを「修正前のコード」（--base、既定 HEAD）に対して実行し、
 *          新規テストが本当に赤になるか（＝修正を検証しているか）を確かめる。
 *          作業ツリーには一切触れない: git archive で base のスナップショットを一時ディレクトリへ展開し、
 *          node_modules をジャンクション（symlink）で共有して vitest を走らせる。git stash は使わない。
 *   all    audit → red。
 *
 * 使い方:
 *   node .claude/skills/test-completeness-check/driver.mjs audit [--base <ref>] [--strict] [--json] [files...]
 *   node .claude/skills/test-completeness-check/driver.mjs red   [--base <ref>] [--keep] [--json] [files...]
 *   node .claude/skills/test-completeness-check/driver.mjs all   [同上]
 *
 * files を省略すると、base との差分（変更・追加・未追跡）にあるテストファイルを対象にする。
 * 終了コード: 0 = 問題なし / 1 = 検査で欠落・疑いあり（--strict または red の WARN） / 2 = 対象なし・実行失敗。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args[0];
if (!['audit', 'red', 'all'].includes(command ?? '')) {
  console.error('usage: driver.mjs <audit|red|all> [--base <ref>] [--strict] [--keep] [--json] [--dir <path>] [files...]');
  process.exit(2);
}
const options = { base: 'HEAD', strict: false, keep: false, json: false, dir: undefined, files: [] };
for (let i = 1; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--base') options.base = args[++i] ?? 'HEAD';
  else if (a === '--dir') options.dir = args[++i];
  else if (a === '--strict') options.strict = true;
  else if (a === '--keep') options.keep = true;
  else if (a === '--json') options.json = true;
  else options.files.push(a.replace(/\\/g, '/'));
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// vitest はカレントディレクトリのドライブ文字が小文字だと崩壊する（このリポジトリの既知の罠）。
// git は大文字で返すので、以後のすべての実行はこの repoRoot を cwd にする。
process.chdir(repoRoot);

const TEST_FILE = /\.test\.(ts|tsx)$/;
const TEST_SUPPORT = /\.(test|contract|fixtures)\.(ts|tsx|mjs)$|(^|\/)test-support\//;
const SOURCE_FILE = /^src\/.*\.(ts|tsx)$/;

// --no-optional-locks: `git diff` が stat 情報の更新で index.lock を取ろうとして、並行して動く別の
// git（もう1つの red 実行や IDE の git 連携）と衝突し status 128 で落ちるのを防ぐ。読むだけなので不要な更新。
// stderr は捕捉して例外に載せる（既定だと親の stderr へそのまま出て、`git show base:新規ファイル` の
// 「exists on disk, but not in 'HEAD'」という想定内の失敗までノイズとして表示される）。
function git(...a) { return execFileSync('git', ['--no-optional-locks', ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
function lines(s) { return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean); }

/** base との差分にある（変更・追加・未追跡の）ファイル。削除は含めない。 */
function changedFiles() {
  const tracked = lines(git('diff', '--name-only', '--diff-filter=ACMR', options.base, '--'));
  const untracked = lines(git('ls-files', '--others', '--exclude-standard'));
  return [...new Set([...tracked, ...untracked])].map((f) => f.replace(/\\/g, '/'));
}

function resolveTargets() {
  if (options.files.length > 0) return options.files.filter((f) => TEST_FILE.test(f));
  return changedFiles().filter((f) => TEST_FILE.test(f));
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/** it()/test() のタイトルと本文（次の it/describe まで）を抜き出す。ヒューリスティック。 */
function extractTests(source) {
  const re = /\b(?:it|test)(?:\.(?:each|only|skip|todo|concurrent)\s*\((?:[^()]|\([^()]*\))*\))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  const found = [];
  let m;
  while ((m = re.exec(source)) !== null) found.push({ title: m[2], start: m.index });
  return found.map((t, i) => ({ title: t.title, body: source.slice(t.start, found[i + 1]?.start ?? source.length) }));
}

const CATEGORY_RULES = {
  // 例外: 投げる・拒否されることを検証している（本文に toThrow / rejects があれば確実）。
  例外: { title: /例外|throw|投げ|reject|拒否|400|403|404|409|413|422|500/i, body: /\.toThrow|\.rejects|toThrowError|throws\b|expect\([^)]*\)\.rejects/ },
  // 異常: 不正入力・欠落・失敗・競合・中断など、正常系の外側。
  異常: { title: /異常|不正|無効|失敗|拒否|欠|壊|不明|存在しない|中断|中止|競合|古い|取り消|無視|落ちない|巻き戻|リーク|invalid|fail|error|unknown|missing|malformed|reject|unreachable|not found|abort|cancel|race|stale|corrupt|conflict|denied|forbidden|leak|non-?error/i, body: null },
  // 境界: 上限・下限・ちょうど・空・0/1・+1/-1・重複・桁区切り。
  境界: { title: /境界|上限|下限|ちょうど|等しい|一致|超え|超過|以上|以下|以内|空|0\s*件|0\s*行|1\s*件|1\s*行|最大|最小|重複|同一|二重|複数|巨大|長い|桁|boundary|limit|exactly|equal|exceed|empty|zero|max|min|\+\s*1|-\s*1|off-?by|edge|overflow|truncat|duplicate|twice|huge|large|long/i, body: /MAX_|_LIMIT|\.toHaveLength\(0\)|\.length\)\.toBe\(0\)|toEqual\(\[\]\)/ },
  // 正常: 期待どおり動く・返す・できる（他に分類されない it も正常系とみなす）。
  正常: { title: /正常|成功|できる|返す|通る|保存|表示|動く|返却|そのまま|維持|保つ|ok\b|returns|succeeds|works|passes|renders|saves|keeps|happy/i, body: null },
};

function classify(test) {
  const cats = new Set();
  for (const [name, rule] of Object.entries(CATEGORY_RULES)) {
    if (rule.title.test(test.title) || (rule.body !== null && rule.body.test(test.body))) cats.add(name);
  }
  if (!cats.has('異常') && !cats.has('例外')) cats.add('正常');
  return cats;
}

function audit(targets) {
  const changed = changedFiles();
  const report = { base: options.base, files: [], sourcesWithoutTests: [], missing: 0 };
  for (const file of targets) {
    if (!fs.existsSync(file)) { report.files.push({ file, error: 'not found' }); continue; }
    const tests = extractTests(fs.readFileSync(file, 'utf8'));
    const counts = { 正常: 0, 異常: 0, 境界: 0, 例外: 0 };
    const detail = tests.map((t) => { const cats = classify(t); for (const c of cats) counts[c] += 1; return { title: t.title, categories: [...cats] }; });
    const missing = Object.entries(counts).filter(([, n]) => n === 0).map(([c]) => c);
    report.missing += missing.length;
    report.files.push({ file, total: tests.length, counts, missing, tests: detail });
  }
  // 本体が変わったのにテストが変わっていないファイル。
  // 判定は2段: (1) colocated 規約 x.ts ↔ x.test.ts(x) のテストが変更されている、
  // (2) 変更されたテストコード（test/contract/fixtures）のどれかが、そのモジュール名を import している
  //     （契約スイートで検証されるリポジトリなど、colocated でない検証を拾う）。
  const changedSources = changed.filter((f) => SOURCE_FILE.test(f) && !TEST_SUPPORT.test(f));
  const changedTests = new Set(changed.filter((f) => TEST_FILE.test(f)));
  const changedSupportText = changed.filter((f) => TEST_SUPPORT.test(f) && fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const src of changedSources) {
    const candidates = [src.replace(/\.tsx?$/, '.test.ts'), src.replace(/\.tsx?$/, '.test.tsx')];
    if (candidates.some((c) => changedTests.has(c))) continue;
    const stem = path.basename(src).replace(/\.tsx?$/, '');
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`from\\s+['"][^'"]*/${escaped}['"]`).test(changedSupportText)) continue;
    report.sourcesWithoutTests.push({ source: src, testExists: candidates.some((c) => fs.existsSync(c)) });
  }
  return report;
}

function printAudit(report) {
  console.log(`\n# audit — 観点の網羅（base: ${report.base}）\n`);
  if (report.files.length === 0) console.log('対象のテストファイルがありません（変更されたテストが無いか、files 指定がテストファイルではない）。');
  for (const f of report.files) {
    if (f.error) { console.log(`- ${f.file}: ${f.error}`); continue; }
    const c = f.counts;
    const flag = f.missing.length === 0 ? 'OK ' : 'MISS';
    console.log(`${flag} ${f.file}  it=${f.total}  正常=${c.正常} 異常=${c.異常} 境界=${c.境界} 例外=${c.例外}${f.missing.length ? `  欠落: ${f.missing.join(' / ')}` : ''}`);
  }
  if (report.sourcesWithoutTests.length > 0) {
    console.log('\n本体が変更されたのに対応するテストの変更が無いファイル:');
    for (const s of report.sourcesWithoutTests) console.log(`  - ${s.source}${s.testExists ? '' : '  （テストファイル自体が無い）'}`);
  }
  console.log('\n分類はタイトルと本文のキーワードによるヒューリスティック。欠落と出た観点は「本当に無いか」を人が確認し、無ければ足す。');
}

// ---------------------------------------------------------------------------
// red
// ---------------------------------------------------------------------------

/**
 * base 版に存在する it タイトルの照合器。`it.each` のタイトルは `%s` / `%i` / `$name` のテンプレートで
 * 書かれ、レポーターには展開後の文字列で出るため、プレースホルダを `.+?` にした正規表現でも照合する。
 * base に無いファイル（新規テスト）は何にも一致しない照合器を返す。
 */
function baseTitleMatcher(file) {
  let titles = [];
  try { titles = extractTests(git('show', `${options.base}:${file}`)).map((t) => t.title); }
  catch { return () => false; }
  const exact = new Set(titles);
  const templates = titles
    .filter((t) => /%[sidjo#%]|\$\{?\w+/.test(t))
    .map((t) => new RegExp('^' + t.split(/%[sidjo#%]|\$\{?[\w.]+\}?/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?') + '$'));
  return (title) => exact.has(title) || templates.some((re) => re.test(title));
}

/** 既存挙動を固定する回帰テスト（修正が無くても通って正しい）はタイトルで見分け、警告から外す。 */
// 明示マーカー `[回帰固定]` / `[pin]` を推奨。それ以外はタイトルの言い回しから推定する。
const PIN_TITLE = /\[回帰固定\]|\[pin\]|従来どおり|従来通り|変わらない|変えない|そのまま|回帰|退行|regression|unchanged|still|keeps?\b|pin\b/i;

function classifyFailure(messages) {
  const text = messages.join('\n');
  if (/Cannot find module|Failed to resolve import|does not provide an export|is not a function|is not a constructor|ReferenceError|TypeError|SyntaxError|is not defined|has no exported member|Unknown file extension/.test(text)) return 'api';
  return 'assertion';
}

function red(targets) {
  if (targets.length === 0) { console.error('red: 対象のテストファイルがありません。'); process.exit(2); }
  const tmp = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'red-check-'));
  fs.mkdirSync(tmp, { recursive: true });
  const log = (m) => { if (!options.json) console.log(m); };
  log(`\n# red — 修正前コード（${options.base}）で新規テストが赤になるか\n作業ディレクトリ: ${tmp}`);

  // 1. base のスナップショットを展開（作業ツリーには触れない）。
  const tar = path.join(tmp, 'base.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${tar}`, options.base], { stdio: 'inherit' });
  // Git Bash から起動すると PATH 先頭の MSYS tar が Windows 形式のパス（H:\...）を解釈できず落ちる。
  // Windows では System32 の bsdtar を絶対パスで使う（PowerShell / cmd / Git Bash のどこから呼んでも同じ挙動）。
  const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(fs.existsSync(tarBin) ? tarBin : 'tar', ['-xf', tar, '-C', tmp], { stdio: 'inherit' });
  fs.rmSync(tar);

  // 2. node_modules を共有（コピーすると数分かかる）。Windows ではジャンクション、他は dir symlink。
  const nm = path.join(tmp, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(repoRoot, 'node_modules'), nm, 'junction');

  // 3. 変更・追加されたテストコード（test / contract / fixtures / test-support）を作業ツリーから上書きコピー。
  //    本体コード（*.ts の実装）はコピーしない＝修正前のまま。
  const support = changedFiles().filter((f) => TEST_SUPPORT.test(f) && fs.existsSync(f));
  const copied = [...new Set([...targets, ...support])];
  for (const f of copied) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.copyFileSync(f, path.join(tmp, f)); }
  log(`コピーしたテストコード: ${copied.length} ファイル（本体コードは ${options.base} のまま）`);

  // 4. vitest を JSON レポーターで実行。外部送信は CI と同じ環境変数で止める。
  const out = path.join(tmp, 'vitest-result.json');
  const env = { ...process.env, MASTRA_TELEMETRY_DISABLED: 'true', MASTRA_OFFLINE: '1', CI: '1' };
  log(`vitest 実行中（${targets.length} ファイル）…`);
  const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...targets], { cwd: tmp, env, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  if (!fs.existsSync(out)) {
    console.error('vitest の結果ファイルが生成されませんでした。stdout/stderr:');
    console.error(run.stdout?.slice(-4000)); console.error(run.stderr?.slice(-4000));
    process.exit(2);
  }
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));

  // 5. 集計: 新規テスト（base に同名タイトルが無い it）は赤であるべき。既存タイトルは参考情報。
  const report = { base: options.base, dir: tmp, files: [], warnings: 0 };
  for (const suite of result.testResults ?? []) {
    const rel = path.relative(tmp, suite.name).replace(/\\/g, '/');
    const existsInBase = baseTitleMatcher(rel);
    const entry = { file: rel, suiteFailed: suite.status === 'failed' && (suite.assertionResults ?? []).length === 0, suiteMessage: suite.message?.split('\n')[0] ?? '', newTests: [], existingTests: [] };
    for (const t of suite.assertionResults ?? []) {
      const isNew = !existsInBase(t.title);
      const kind = t.status === 'failed' ? classifyFailure(t.failureMessages ?? []) : PIN_TITLE.test(t.title) ? 'pin' : 'green';
      (isNew ? entry.newTests : entry.existingTests).push({ title: t.title, status: t.status, kind });
    }
    entry.summary = {
      newTotal: entry.newTests.length,
      newRedAssertion: entry.newTests.filter((t) => t.kind === 'assertion').length,
      newRedApi: entry.newTests.filter((t) => t.kind === 'api').length,
      newPin: entry.newTests.filter((t) => t.kind === 'pin').length,
      newGreen: entry.newTests.filter((t) => t.kind === 'green').length,
      existingRed: entry.existingTests.filter((t) => t.status === 'failed').length,
      existingGreen: entry.existingTests.filter((t) => t.status === 'passed').length,
    };
    if (entry.summary.newGreen > 0) report.warnings += entry.summary.newGreen;
    report.files.push(entry);
  }

  if (!options.keep) {
    try { fs.unlinkSync(nm); } catch { try { fs.rmdirSync(nm); } catch { /* ignore */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return report;
}

function printRed(report) {
  console.log('');
  for (const f of report.files) {
    const s = f.summary;
    if (f.suiteFailed) { console.log(`RED  ${f.file}  ファイル全体が旧コードで実行不能（import/型エラー）: ${f.suiteMessage}`); continue; }
    const verdict = s.newTotal === 0 ? 'INFO' : s.newGreen === 0 ? 'OK  ' : 'WARN';
    console.log(`${verdict} ${f.file}  新規 it=${s.newTotal}  赤(検証)=${s.newRedAssertion} 赤(API不在)=${s.newRedApi} 回帰固定(緑)=${s.newPin} 緑=${s.newGreen}  既存: 赤=${s.existingRed} 緑=${s.existingGreen}`);
    for (const t of f.newTests.filter((x) => x.kind === 'green')) console.log(`     ⚠ 修正なしでも通る: ${t.title}`);
  }
  console.log(`\n読み方: 赤(検証)= 旧コードで期待どおり失敗（修正を検証している）。赤(API不在)= 新APIが無く実行できない（検証としては弱い。可能なら旧コードでも動く形で振る舞いを固定する）。回帰固定(緑)= タイトルに「従来どおり / 変わらない / regression」等があり、既存挙動の固定として緑が正しい。緑= 修正が無くても通る＝その it は今回の修正を検証していない（意図的な回帰固定ならタイトルにそう書く）。`);
  if (report.dir && options.keep) console.log(`一時ディレクトリを残しました: ${report.dir}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const targets = resolveTargets();
let exitCode = 0;
if (command === 'audit' || command === 'all') {
  const report = audit(targets);
  if (options.json) console.log(JSON.stringify(report, null, 2)); else printAudit(report);
  if (options.strict && (report.missing > 0 || report.sourcesWithoutTests.length > 0)) exitCode = 1;
}
if (command === 'red' || command === 'all') {
  const report = red(targets);
  if (options.json) console.log(JSON.stringify(report, null, 2)); else printRed(report);
  if (report.warnings > 0) exitCode = 1;
}
process.exit(exitCode);
