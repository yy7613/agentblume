/**
 * application層のPort: 複数リポジトリにまたがる書き込みを1つの原子的な単位で括る。
 *
 * リポジトリはそれぞれ自分のテーブルしか知らないため、「Toolを保存し、それを参照するSkillを保存し、
 * さらにそれを参照するAgentを保存する」といった一連の書き込みは、途中で失敗すると
 * **どこも参照していない孤児**を残す。ユースケースはこのPortで境界を宣言し、
 * 実際にトランザクションを張れるかどうかはアダプタ（配線）の責務にする。
 *
 * - SQLite配線: 共有接続に対して `BEGIN` / `COMMIT`（入れ子は SAVEPOINT）を張る。
 * - InMemory配線・トランザクション非対応の配線: `NoopUnitOfWork`（そのまま実行する）。
 *
 * `work` が例外を投げたら書き込みは巻き戻り、例外はそのまま呼び出し元へ伝わる。
 * **DBの外にある副作用（ファイル書き込み・外部API・モデル呼び出し）は巻き戻せない**ので、
 * 境界の内側にはDBへの書き込みだけを置くこと。
 */
export interface UnitOfWorkPort {
  /** `work` の中で行われた永続化を、まとめてコミットするか、まとめて巻き戻す。 */
  withTransaction<T>(work: () => Promise<T>): Promise<T>;
}

/** トランザクションを張れない配線で使う恒等実装（境界の宣言だけが残る）。 */
export class NoopUnitOfWork implements UnitOfWorkPort {
  async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}
