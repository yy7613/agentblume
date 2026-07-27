/**
 * adapters層: 共有SQLite接続に対する `UnitOfWorkPort` 実装。
 *
 * ## 直列化する理由
 *
 * `node:sqlite` は同期APIだが、`withTransaction` が括るのは**非同期**の処理である。
 * 接続は1本しかないため、2つの非同期トランザクションが await 点で交錯すると
 * `BEGIN` の中で `BEGIN` を実行することになり、SQLiteが拒否する（＝Runが落ちる）。
 * そこで、外側のトランザクションは**キューで直列化**する。
 *
 * ## 入れ子は合流させる
 *
 * 同じトランザクション文脈から `withTransaction` が再入した場合（ユースケースが別の
 * ユースケースを呼ぶ配線）にキュー待ちすると自分自身を待ってデッドロックする。
 * `AsyncLocalStorage` で「今トランザクションの中か」を判定し、内側は SAVEPOINT で
 * 同じ単位へ合流させる（内側だけの巻き戻しも可能）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWorkPort } from '../../application/persistence/unit-of-work';
import type { SqliteDatabase } from './sqlite-database';

export class SqliteUnitOfWork implements UnitOfWorkPort {
  private readonly inTransaction = new AsyncLocalStorage<true>();
  /** 直前の外側トランザクションの完了。失敗しても後続を止めないよう握り潰して繋ぐ。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly database: SqliteDatabase) {}

  async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore() === true) return this.run(work);
    const current = this.queue.then(() => this.inTransaction.run(true, () => this.run(work)));
    this.queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    const transaction = this.database.enterTransaction();
    try {
      const result = await work();
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }
}
