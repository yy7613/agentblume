import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * クライアント切断で abort する AbortSignal。**UIの「中断」はこれ1本に懸かっている**。
 *
 * `request.raw.signal` は Node 26.1 で入った新しいAPIで、`@types/node` が 26 系のため
 * 型検査は通るが、このリポジトリが動かす Node 22（.nvmrc / engines >=22.9）では
 * **実行時に undefined** になる。素で参照するとユースケースへ `undefined` が渡り、
 * ブラウザが fetch を abort してもモデル呼び出しは最大10分走り続ける。
 *
 * そのため未提供の実行環境では、応答ストリームが「書き終える前に閉じた」＝クライアントが
 * 切断した、という古典的な判定で同等のシグナルを自前で作る。
 *
 * 長時間かかりうるルート（モデル実行・外部接続テスト）は必ずこれを通すこと。
 */
export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const native = (request.raw as Partial<{ signal: AbortSignal }>).signal;
  if (native !== undefined) return native;
  const controller = new AbortController();
  const raw = reply.raw;
  raw.once('close', () => { if (!raw.writableEnded) controller.abort(); });
  return controller.signal;
}
