/**
 * ドメイン: 認可（RBAC）の判定モデル
 *
 * ## なぜドメインに置くか
 *
 * 「誰が何をしてよいか」は HTTP でもSQLでもなく**製品の規則**である。
 * `docs/08-security-auth.md` §3.2 のロール×アクション表がその規則であり、
 * ここはその表をそのままコードにしたもの。api層のフックも adapters の
 * `AuthorizationPort` 実装も、判定そのものはこの関数に委ねる（規則の写しを増やさない）。
 *
 * ## 判定は「アクション」が主役
 *
 * §3.2 の表は行が「リソース種別」ではなく**操作の種類**で並んでいる。
 * リソース種別が判定を変えるのは `audit-log`（Operator以上しか読めない）だけなので、
 * 実装も「アクションで決め、`audit-log` だけ別扱い」という形にしてある。
 * 将来ABAC（所有者・環境・データ分類）へ広げるときは `AuthorizationResource` に
 * 条件を足し、この関数の中だけを厚くすればよい。
 *
 * ## 未定義は拒否
 *
 * §3.1 のフェイルセーフに従い、**判定できない組み合わせは拒否**する。
 * 「ロールを1つも持たない Principal」「表に無いリソース×アクション」はすべて deny。
 *
 * ## `Principal` 型を import しない理由
 *
 * `principal.ts` はロールの値域（`AUTHORIZATION_ROLES`）をここから取るので、
 * 型を借り返すと循環参照になる。判定に要るのは `subject` と `roles` だけなので、
 * その最小形（`AuthorizationSubject`）で受ける。`Principal` は構造的にこれを満たす。
 */

/** 認可判定に必要な最小の主体。`Principal` はこれを満たす。 */
export interface AuthorizationSubject {
  readonly subject: string;
  readonly roles: readonly string[];
}

/** ワークスペース単位で割り当てるロール（`docs/08-security-auth.md` §3.2）。 */
export const AUTHORIZATION_ROLES = ['viewer', 'editor', 'publisher', 'operator', 'workspace-admin'] as const;
/** `AUTHORIZATION_ROLES` の要素。 */
export type AuthorizationRole = (typeof AUTHORIZATION_ROLES)[number];

/**
 * 判定の対象となる操作（§3.1 の Action）。
 *
 * `operate` は §3.2 の「運用・実行監視」行に対応する（バックアップ・保持期限・稼働状況）。
 */
export const AUTHORIZATION_ACTIONS = [
  'read', 'create', 'edit', 'execute', 'approve', 'publish', 'operate', 'manage-access', 'delete',
] as const;
/** `AUTHORIZATION_ACTIONS` の要素。 */
export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

/**
 * 判定の対象となるリソース種別。
 *
 * §3.1 の列挙（workspace / connection / secret-ref / tool / skill / agent / workflow /
 * deployment / audit-log）を土台に、この製品が実際に持つ資産を足してある。
 * **判定へ効くのは `audit-log` だけ**で、他は監査ログの「何に対して」を読める形で残すためにある。
 */
export const AUTHORIZATION_RESOURCE_KINDS = [
  'workspace', 'data-source', 'secret-ref', 'tool', 'skill', 'agent', 'harness', 'factory',
  'workflow', 'deployment', 'evaluation', 'promotion', 'run', 'memory', 'session',
  'mcp-server', 'model-settings', 'audit-log',
] as const;
/** `AUTHORIZATION_RESOURCE_KINDS` の要素。 */
export type AuthorizationResourceKind = (typeof AUTHORIZATION_RESOURCE_KINDS)[number];

/** 判定対象のリソース。`id` / `version` は監査へそのまま載せる。 */
export interface AuthorizationResource {
  readonly kind: AuthorizationResourceKind;
  readonly id?: string;
  readonly version?: string;
  /**
   * この資産を作った主体（`Principal.subject`）。
   *
   * §3.2 の delete 行「Editor / Publisher は**自作のみ**」を判定するための情報。
   * **現時点でこれを供給できる経路は無い**（作成者の subject を保存していない）ため、
   * 実質「delete は Workspace Admin のみ」として働く。フェイルセーフ側に倒してある。
   */
  readonly ownerSubject?: string;
}

/** 認可の判定結果。拒否の理由は 403 のメッセージへそのまま出せる粒度にする（秘密は含めない）。 */
export type AuthorizationDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string };

/** `'tool:create'` のような表記（`docs/04-api-spec.md` §3 の「認可アクション」列と同じ書式）。 */
export type AuthorizationPermission = `${AuthorizationResourceKind}:${AuthorizationAction}`;

/** リソース種別とアクションから `tool:create` 形式の表記を作る。 */
export function permissionOf(kind: AuthorizationResourceKind, action: AuthorizationAction): AuthorizationPermission {
  return `${kind}:${action}`;
}

/** 文字列がロール名か（設定ファイル・トークン定義の検証に使う）。 */
export function isAuthorizationRole(value: string): value is AuthorizationRole {
  return (AUTHORIZATION_ROLES as readonly string[]).includes(value);
}

/** `Principal.roles`（自由文字列）から既知のロールだけを取り出す。未知の名前は黙って捨てず、判定から外れるだけ。 */
export function rolesOf(principal: AuthorizationSubject): readonly AuthorizationRole[] {
  return principal.roles.filter(isAuthorizationRole);
}

/**
 * 1ロールがそのアクションを許すか（§3.2 の表の1マス）。
 *
 * | リソース \ ロール | viewer | editor | publisher | operator | workspace-admin |
 * |---|:---:|:---:|:---:|:---:|:---:|
 * | read | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | create / edit | — | ✅ | ✅ | ✅ | ✅ |
 * | execute | — | ✅ | ✅ | ✅ | ✅ |
 * | approve | — | — | ✅ | ✅ | ✅ |
 * | publish | — | — | ✅ | — | ✅ |
 * | operate | — | — | — | ✅ | ✅ |
 * | manage-access | — | — | — | — | ✅ |
 * | delete | — | 自作のみ | 自作のみ | — | ✅ |
 * | audit-log:read | — | — | — | ✅ | ✅ |
 */
function roleAllows(
  role: AuthorizationRole,
  action: AuthorizationAction,
  resource: AuthorizationResource | undefined,
  subject: string,
): boolean {
  // 監査ログだけはリソース種別が判定を変える（読めるのは運用側だけ・書き換えは誰にもできない）。
  if (resource?.kind === 'audit-log') return action === 'read' && (role === 'operator' || role === 'workspace-admin');

  switch (action) {
    case 'read':
      return true;
    case 'create':
    case 'edit':
    case 'execute':
      return role !== 'viewer';
    case 'approve':
      return role === 'publisher' || role === 'operator' || role === 'workspace-admin';
    case 'publish':
      // 公開は「外へ出す」操作。運用担当（operator）は監視と掃除の担当で、公開の権限は持たない。
      return role === 'publisher' || role === 'workspace-admin';
    case 'operate':
      return role === 'operator' || role === 'workspace-admin';
    case 'manage-access':
      return role === 'workspace-admin';
    case 'delete':
      if (role === 'workspace-admin') return true;
      // 「自作のみ」。所有者が分からないときは拒否する（§3.1 フェイルセーフ）。
      if (role !== 'editor' && role !== 'publisher') return false;
      return resource?.ownerSubject !== undefined && resource.ownerSubject === subject;
    default:
      return false;
  }
}

/** 拒否メッセージ。**必要な権限だけ**を伝える（保持しているロールや他人の情報は出さない）。 */
function denyReason(action: AuthorizationAction, resource: AuthorizationResource | undefined): string {
  const target = resource === undefined ? action : permissionOf(resource.kind, action);
  return `this operation requires the '${target}' permission`;
}

/**
 * 認可の判定本体。**いずれか1つのロールが許せば許可**（ロールは加算的）。
 *
 * ロールを1つも持たない（または未知の名前しか持たない）Principal は常に拒否になる。
 */
export function decideAuthorization(
  principal: AuthorizationSubject,
  action: AuthorizationAction,
  resource?: AuthorizationResource,
): AuthorizationDecision {
  const roles = rolesOf(principal);
  const allowed = roles.some((role) => roleAllows(role, action, resource, principal.subject));
  return allowed ? { kind: 'allow' } : { kind: 'deny', reason: denyReason(action, resource) };
}
