/**
 * adapters層: 経費精算の実用化（docs/21-expense.md §20.8）のスキーマ（version 9）。
 *
 * v6 の文（`expense-migrations.ts`）は利用者の DB に適用済みの可能性があるので一字も変えず、追加だけをここに置く。
 * v7（receivables）・v8（contract）は他業務の版なので、経費の追加は 9 になる（ADR-0039 §6）。
 *
 * - すべて `CREATE … IF NOT EXISTS` / `INSERT OR IGNORE`。`ALTER TABLE` は使わない
 *   （予約版の手前で版の刻みが止まる期間は開くたびに流し直され、`ADD COLUMN` は冪等に書けないため）。
 * - 本体は `record_json`、絞り込みと並びに使う値だけを列へ出す（v5 / v6 と同じ）。
 * - `expense_claim_refs` / `expense_item_refs` / `expense_claim_approvers` / `expense_employee_subjects` は**派生の索引**。
 *   本体の保存と同じトランザクションで入れ直し、壊れても本体から再生成できる。v6 の `expense_claims` に列を足せないための表でもある。
 * - 末尾の埋め戻しは MVP で作った申請を集計・絞り込みに出すためのもの。`INSERT OR IGNORE` なので、
 *   流し直しても行数は変わらず、新しいコードが入れ直した行を上書きしない。
 */
import { statementMigration } from './schema-migration';

export const EXPENSE_V9_STATEMENTS: readonly string[] = [
  // 従業員（A）。code_key は NULL 可（社員番号は任意）。SQLite の UNIQUE は NULL 同士を重複とみなさない。
  `CREATE TABLE IF NOT EXISTS expense_employees (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    code_key TEXT, name_key TEXT NOT NULL, department_id TEXT, manager_id TEXT,
    enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_employees_scope_code ON expense_employees (tenant_id, workspace_id, code_key)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_employees_scope_name ON expense_employees (tenant_id, workspace_id, name_key)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_employees_scope_department ON expense_employees (tenant_id, workspace_id, department_id)`,
  // ログイン ID → 従業員（派生。一意制約で同じログイン ID の二重登録を DB でも止める）。
  `CREATE TABLE IF NOT EXISTS expense_employee_subjects (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, subject TEXT NOT NULL, employee_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, subject)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_employee_subjects_scope_employee ON expense_employee_subjects (tenant_id, workspace_id, employee_id)`,
  // ワークスペースに 1 つの設定（kind: organization / payout / cards / fares）。版を増やさずに種類を足せるよう 1 表にまとめる。
  `CREATE TABLE IF NOT EXISTS expense_settings (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, kind)
  )`,
  // 申請の派生索引（従業員・部門・仮払・振込・集計用の表示値）。
  `CREATE TABLE IF NOT EXISTS expense_claim_refs (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    employee_id TEXT, department_id TEXT, department_text TEXT, claimant_name TEXT NOT NULL,
    advance_id TEXT, payout_batch_id TEXT, approved_at TEXT, settled_at TEXT,
    PRIMARY KEY (tenant_id, workspace_id, claim_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claim_refs_scope_employee ON expense_claim_refs (tenant_id, workspace_id, employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claim_refs_scope_department ON expense_claim_refs (tenant_id, workspace_id, department_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claim_refs_scope_advance ON expense_claim_refs (tenant_id, workspace_id, advance_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claim_refs_scope_payout ON expense_claim_refs (tenant_id, workspace_id, payout_batch_id)`,
  // 明細の派生索引（集計・カード照合の候補）。
  `CREATE TABLE IF NOT EXISTS expense_item_refs (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, claim_id TEXT NOT NULL, item_id TEXT NOT NULL,
    transaction_date TEXT, amount INTEGER, category_id TEXT, corporate INTEGER NOT NULL, payee_key TEXT,
    PRIMARY KEY (tenant_id, workspace_id, claim_id, item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_item_refs_scope_date ON expense_item_refs (tenant_id, workspace_id, transaction_date)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_item_refs_scope_date_amount ON expense_item_refs (tenant_id, workspace_id, transaction_date, amount)`,
  // 現在の段の承認者（派生。「あなたの承認待ち」）。段が進むたびに入れ直す。
  `CREATE TABLE IF NOT EXISTS expense_claim_approvers (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, claim_id TEXT NOT NULL, employee_id TEXT NOT NULL, step_index INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, claim_id, employee_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claim_approvers_scope_employee ON expense_claim_approvers (tenant_id, workspace_id, employee_id)`,
  // 仮払（B）。
  `CREATE TABLE IF NOT EXISTS expense_advances (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    employee_id TEXT NOT NULL, status TEXT NOT NULL, amount INTEGER NOT NULL,
    needed_on TEXT NOT NULL, planned_settle_by TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_advances_scope_status ON expense_advances (tenant_id, workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_advances_scope_employee ON expense_advances (tenant_id, workspace_id, employee_id)`,
  // カード明細の取込と利用行（B）。同じファイルは SHA-256、期間の重なるファイルの同じ行は dedupe_key の一意で 1 件にする。
  `CREATE TABLE IF NOT EXISTS expense_card_imports (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    file_sha256 TEXT NOT NULL, card_id TEXT, period_from TEXT, period_to TEXT, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_card_imports_scope_sha ON expense_card_imports (tenant_id, workspace_id, file_sha256)`,
  `CREATE TABLE IF NOT EXISTS expense_card_transactions (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    import_id TEXT NOT NULL, card_id TEXT NOT NULL, used_on TEXT NOT NULL, amount INTEGER NOT NULL, merchant_key TEXT,
    status TEXT NOT NULL, claim_id TEXT, item_id TEXT, dedupe_key TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_card_transactions_scope_dedupe ON expense_card_transactions (tenant_id, workspace_id, dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_card_transactions_scope_date_amount ON expense_card_transactions (tenant_id, workspace_id, used_on, amount)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_card_transactions_scope_status ON expense_card_transactions (tenant_id, workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_card_transactions_scope_claim ON expense_card_transactions (tenant_id, workspace_id, claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_card_transactions_scope_import ON expense_card_transactions (tenant_id, workspace_id, import_id)`,
  // 振込バッチ（B）。口座番号の写しは record_json（封緘値）にだけ置く。
  `CREATE TABLE IF NOT EXISTS expense_payout_batches (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    status TEXT NOT NULL, transfer_date TEXT NOT NULL, total_amount INTEGER NOT NULL, record_count INTEGER NOT NULL,
    file_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_payout_batches_scope_status ON expense_payout_batches (tenant_id, workspace_id, status, transfer_date)`,
  // 規程のヒアリング（C）。
  `CREATE TABLE IF NOT EXISTS expense_policy_hearings (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_policy_hearings_scope_status ON expense_policy_hearings (tenant_id, workspace_id, status, updated_at)`,
  // 埋め戻し（§20.8.2）: MVP の申請の派生索引。JSON の true は json_extract で 1 になる。
  `INSERT OR IGNORE INTO expense_claim_refs (tenant_id, workspace_id, claim_id, employee_id, department_id, department_text, claimant_name, advance_id, payout_batch_id, approved_at, settled_at)
   SELECT tenant_id, workspace_id, id,
     json_extract(record_json, '$.claimant.employeeId'), json_extract(record_json, '$.claimant.departmentId'),
     json_extract(record_json, '$.claimant.department'), json_extract(record_json, '$.claimant.name'),
     json_extract(record_json, '$.advanceId'), json_extract(record_json, '$.payout.batchId'),
     json_extract(record_json, '$.approval.at'), json_extract(record_json, '$.settlement.settledAt')
   FROM expense_claims`,
  // 支払先キーは JS の正規化（仕訳の normalizeDescription）を SQL で再現できないので、v6 の索引の値を借りる。
  `INSERT OR IGNORE INTO expense_item_refs (tenant_id, workspace_id, claim_id, item_id, transaction_date, amount, category_id, corporate, payee_key)
   SELECT c.tenant_id, c.workspace_id, c.id,
     json_extract(i.value, '$.id'), json_extract(i.value, '$.facts.transactionDate'), json_extract(i.value, '$.facts.amount'),
     json_extract(i.value, '$.categoryId'), CASE WHEN json_extract(i.value, '$.facts.corporatePayment') = 1 THEN 1 ELSE 0 END,
     k.payee_key
   FROM expense_claims c, json_each(c.record_json, '$.items') i
   LEFT JOIN expense_item_keys k ON k.tenant_id = c.tenant_id AND k.workspace_id = c.workspace_id AND k.claim_id = c.id AND k.item_id = json_extract(i.value, '$.id')`,
];

export const EXPENSE_V9_MIGRATION = statementMigration(9, 'expense practical extensions (employees, advances, card statements, payouts, hearings, derived indexes)', EXPENSE_V9_STATEMENTS);
