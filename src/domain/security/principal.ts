/**
 * ドメイン: Principal（「誰がこのリクエストを出しているか」）
 *
 * ## なぜドメインに置くか
 *
 * テナント境界（`TenantScope`）を**決める主体**がここにある。以前は境界の値そのものを
 * クライアントがボディ／クエリで自己申告しており、`tenantId` を書き換えるだけで
 * 他テナントのデータを読み書き・削除できた。リポジトリ層の `WHERE tenant_id = ?` は
 * 正しく効いていたので、壊れていたのは「境界の実装」ではなく「境界を決める主体」だった。
 *
 * 以降、スコープの唯一の供給源はこの `Principal` であり、リクエスト本文の値は使わない。
 *
 * `roles` は認可（RBAC）の入力。値域と判定は `authorization.ts`（同じディレクトリ）にある。
 * ここでは「どの主体がどのロールを持つか」だけを扱い、ロールが何を許すかは持たない。
 */
import type { AuthorizationRole } from './authorization';
import { AUTHORIZATION_ROLES } from './authorization';
import type { TenantId, WorkspaceId } from '../shared/tenant-scope';
import type { TenantScope } from '../tool/ids';

/** 認証済みの主体。api層は必ずこれ経由で `TenantScope` を得る。 */
export interface Principal {
  /** 主体の識別子（トークンの持ち主・IdPのsub）。監査で「誰が」に使う。 */
  readonly subject: string;
  /** この主体が属するテナント。 */
  readonly tenantId: TenantId;
  /** この主体が属するワークスペース。 */
  readonly workspaceId: WorkspaceId;
  /** 画面表示用の名前（無ければ subject を出す）。 */
  readonly displayName?: string;
  /**
   * 割り当てられたロール（`AUTHORIZATION_ROLES`）。認可はここだけを見る。
   *
   * 型を `string[]` のままにしてあるのは、外部IdPのgroup/roleをそのまま運ぶ経路
   * （`PrincipalMapper`、未実装）を後から足せるようにするため。
   * 未知の名前は判定側（`rolesOf`）が捨てるので、権限が増えることはない。
   */
  readonly roles: readonly string[];
}

/** 認証プロバイダ未設定時の既定テナント（`AGENTCONTEXT_TENANT_ID` の既定と同じ値）。 */
export const DEFAULT_TENANT_ID = 'local';
/** 認証プロバイダ未設定時の既定ワークスペース（`AGENTCONTEXT_WORKSPACE_ID` の既定と同じ値）。 */
export const DEFAULT_WORKSPACE_ID = 'default';
/** 単一ユーザーモードの subject。監査ログで「誰でもない1人」を表す固定値。 */
export const SINGLE_USER_SUBJECT = 'single-user';

/** `Principal` からテナント境界を取り出す。 */
export function principalScope(principal: Principal): TenantScope {
  return { tenantId: principal.tenantId, workspaceId: principal.workspaceId };
}

/**
 * 単一ユーザーモードで付与するロール。**全ロール**。
 *
 * このモードは「資格情報を一切求めない＝そのマシンの利用者が唯一の主体」なので、
 * 権限を絞る相手がいない。絞ると、認可を入れた瞬間に既存のローカル利用が壊れる
 * （削除も承認も運用操作もできなくなる）一方で、守れるものは何も無い。
 */
export const SINGLE_USER_ROLES: readonly AuthorizationRole[] = AUTHORIZATION_ROLES;

/** 単一ユーザーモードの Principal を作る（scope 省略で既定テナント／ワークスペース）。 */
export function singleUserPrincipal(scope?: TenantScope): Principal {
  return {
    subject: SINGLE_USER_SUBJECT,
    tenantId: scope?.tenantId ?? DEFAULT_TENANT_ID,
    workspaceId: scope?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    displayName: 'Local operator',
    roles: [...SINGLE_USER_ROLES],
  };
}
