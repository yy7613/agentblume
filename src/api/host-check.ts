/**
 * api層: `Host` ヘッダ検査（DNSリバインディング対策）。
 *
 * ## 何を防ぐか
 *
 * ループバックへバインドした単一ユーザーモードでは**認証が無い**。この状態で利用者が
 * 悪意あるWebページを開くと、そのページは自分のドメイン（例 `evil.example`）を
 * `127.0.0.1` へ解決させることで、被害者のブラウザに `http://evil.example:3030/...` として
 * ローカルAPIを叩かせられる。ブラウザから見れば同一オリジンではないので**応答は読めない**が、
 * 副作用のあるリクエスト（設定の書き換え・MCPサーバーの登録と起動）は通ってしまう。
 * CORSはこれを止めない（プリフライトの無い単純リクエストは飛ぶ）。
 *
 * 決め手は `Host` ヘッダで、ブラウザはこれを**攻撃者のドメインのまま**送る。
 * よって「ループバックに閉じているのに `Host` が localhost 系でない」リクエストは
 * 正当な経路が存在しないので拒否してよい。
 *
 * ## 適用範囲
 *
 * 検査するのは**認証が無い単一ユーザーモード**のときだけ（`config/environment.ts` の
 * `allowedHostNames`）。トークン認証を有効にした構成では `Host` は運用者が付けたホスト名や
 * LBのIPになり得るので検査しない — そこでの識別はトークンが担う。
 *
 * 「ループバックへバインドしているか」だけで決めてはいけない。`127.0.0.1` へバインドして
 * リバースプロキシを前に置くのは本番の一般形で、そこでのブラウザは `Host: app.example.com`
 * を送る。バインド先だけを見て縛ると、**認証込みの真っ当な構成が全リクエスト403**になる。
 * その構成でも縛りたい場合は `AGENTCONTEXT_ALLOWED_HOSTS` に受け入れる名前を列挙する。
 */
import type { FastifyInstance } from 'fastify';

/**
 * ループバック運用で受け入れる `Host`（ポートは除いて比較する）。
 *
 * IPv6 は**角括弧つきだけ**を載せる。HTTPの `Host` は IPv6 リテラルを必ず角括弧で包む
 * （RFC 7230 §5.4 → RFC 3986 §3.2.2）ので、裸の `::1` を許可しても正当なクライアントの
 * 役には立たない。むしろ `hostNameOf('::1')` は「最初のコロンより前」＝空文字を返すため、
 * 許可リストに空文字が混ざり、`Host: :3030` のような値まで通ってしまう。
 */
export const LOOPBACK_HOST_NAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export interface HostCheckOptions {
  /** 受け入れるホスト名（ポートなし・小文字）。空配列を渡すと全拒否になるので注意。 */
  readonly allowedHosts: readonly string[];
}

/**
 * `Host` からポートを外して正規化する。
 * IPv6 リテラルは角括弧つきで来る（`[::1]:3030`）ので、括弧の外側の `:` だけを見る。
 */
export function hostNameOf(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end < 0 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  return colon < 0 ? value : value.slice(0, colon);
}

/**
 * 受け入れてよい `Host` か。ヘッダ欠落は拒否（HTTP/1.1 では必須）。
 *
 * ホスト名が空になる値（`:3030` のようにポートだけ）も拒否する。空文字同士の一致で
 * 素通りする経路を残さないための保険で、許可リスト側にホスト名を持たない項目が
 * 混ざっても穴にならない。
 */
export function isAllowedHost(header: string | undefined, allowedHosts: readonly string[]): boolean {
  if (header === undefined || header.trim() === '') return false;
  const name = hostNameOf(header);
  if (name === '') return false;
  return allowedHosts.some((allowed) => hostNameOf(allowed) === name);
}

/**
 * `Host` 検査フックを登録する。
 *
 * 拒否は 403（認証で直る話ではないので 401 ではない）。応答には受け取った `Host` を載せない
 * （攻撃者の制御下にある文字列をそのまま反射すると、ログやエラー表示の汚染に使われる）。
 */
export function registerHostCheck(app: FastifyInstance, options: HostCheckOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isAllowedHost(request.headers.host, options.allowedHosts)) return;
    void reply.status(403).send({
      error: {
        code: 'FORBIDDEN_HOST',
        message: 'the Host header is not allowed for this server; reach it as localhost or 127.0.0.1',
      },
    });
  });
}
