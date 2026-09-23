/**
 * ドメイン: 列の役割を推定するための共有語彙（v50 R3）。
 *
 * `application/factory/profile-data-sources.ts`（結合キーの並び優先度）と
 * `domain/tool-template/instantiate.ts`（「値の列」からコードらしい列を外す）に同じ正規表現が
 * 二重定義されていたのを、ここへ一本化する（application → domain の向き）。
 */

/** コードらしい列名（結合キーとして優先する／「値の列」から外す）。 */
export const CODE_LIKE_COLUMN = /コード|code|id$|_id|番号/i;
