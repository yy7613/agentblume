/**
 * ドメイン: 外向きHTTPリクエストの宛先ポリシー（SSRF対策の純関数）。
 *
 * MCPのHTTPトランスポートとモデル設定の `baseUrl` は、どちらも**利用者が入力したURLへ
 * サーバー自身が接続する**経路である。スキームだけを見ていると、認証を通った利用者が
 * `http://169.254.169.254/...`（クラウドのメタデータ）や `http://10.0.0.5:22/` のような
 * 内部宛リクエストをサーバーに代行させられる（応答が読めなくても、成否や所要時間だけで
 * ポートスキャンに相当する観測ができる）。
 *
 * ここは**宛先の分類**だけを行い、DNS解決も接続も行わない（domainは外部I/Oを持たない）。
 * ホスト名がIPリテラルでない場合の解決後の再検査は adapters 側の責務。
 *
 * ## 既定の方針
 *
 * - **ループバックは常に許可**する。`http://127.0.0.1:3000/mcp` のようなローカルMCPサーバーや
 *   LM Studio は本製品の中心的な使い方であり、ここを塞ぐと機能が成立しない。
 * - **リンクローカル（169.254.0.0/16・fe80::/10）は常に拒否**する。クラウドのメタデータ
 *   エンドポイントが住む範囲で、この製品から到達すべき正当な理由が無い。
 *   `allowPrivateNetwork` を有効にしても解禁しない（他の私設範囲とは危険度が違う）。
 * - **その他の私設範囲（RFC1918 等）は既定で拒否**し、`allowPrivateNetwork` で明示的に解禁する。
 *   「同じLANの別マシンで動かしているサーバーを使いたい」は正当な要求だが、既定で開けておくと
 *   トークンを持つ利用者が社内ネットワークを走査できてしまうため、意図表明を求める。
 */

/** 宛先ホストの分類。 */
export type HostClass = 'loopback' | 'link-local' | 'private' | 'public';

/** 宛先を拒否する理由。**内部の構造やDNS/接続の成否を漏らさない**粒度に留める。 */
export type UrlRejectionReason =
  | 'not-a-url'
  | 'unsupported-scheme'
  | 'embedded-credentials'
  | 'link-local'
  | 'private-network';

export interface UrlPolicy {
  /** 私設範囲（RFC1918 等）への接続を許可するか。リンクローカルはこれとは無関係に常に拒否。 */
  readonly allowPrivateNetwork: boolean;
}

/** 既定のポリシー（ループバックのみ許可）。 */
export const DEFAULT_URL_POLICY: UrlPolicy = { allowPrivateNetwork: false };

/** 利用者向けの説明文。ポリシー違反をUIへ返すときの文言に使う（宛先の詳細は載せない）。 */
export const URL_REJECTION_MESSAGE: Readonly<Record<UrlRejectionReason, string>> = {
  'not-a-url': 'must be a valid URL',
  'unsupported-scheme': 'must use http(s)',
  'embedded-credentials': 'must not embed credentials (user:password@host)',
  'link-local': 'must not target a link-local address (cloud metadata endpoints are never reachable from here)',
  'private-network': 'must not target a private network address; set AGENTCONTEXT_MCP_ALLOW_PRIVATE_NETWORK=true to allow it',
};

/** ホスト名を比較用に正規化する（小文字化・IPv6の角括弧と末尾ドットを除去）。 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** ドット10進のIPv4リテラルなら4オクテットを返す。 */
function ipv4Octets(host: string): readonly number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    // 先頭ゼロ（`010`）は実装によって8進と解釈され得るので受け付けない。
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function classifyIpv4(octets: readonly number[]): HostClass {
  const [a = 0, b = 0] = octets;
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  // 0.0.0.0/8（"このホスト"）・RFC1918・CGNAT・ベンチマーク用・IETF予約は外へ出す理由が無い。
  if (a === 0 || a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  if (a === 192 && b === 0) return 'private';
  if (a >= 224) return 'private';
  return 'public';
}

/**
 * IPv6リテラルの先頭ヘクステットだけを取り出す（完全な展開はしない）。
 * 判定に必要なのは `::1` / `fe80::/10` / `fc00::/7` / `::` の4つだけで、
 * いずれも先頭ヘクステットと「全ゼロか」で決まる。
 */
function ipv6FirstHextet(host: string): number | undefined {
  if (host.startsWith('::')) return 0;
  const head = host.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(head)) return undefined;
  return Number.parseInt(head, 16);
}

function classifyIpv6(host: string): HostClass | undefined {
  // IPv4射影（`::ffff:127.0.0.1`）は実質IPv4なので、IPv4として分類する。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped !== null) {
    const octets = ipv4Octets(mapped[1] ?? '');
    return octets === undefined ? undefined : classifyIpv4(octets);
  }
  if (!host.includes(':')) return undefined;
  if (host === '::1') return 'loopback';
  if (host === '::') return 'private';
  const head = ipv6FirstHextet(host);
  if (head === undefined) return undefined;
  if (head >= 0xfe80 && head <= 0xfebf) return 'link-local';
  if (head >= 0xfc00 && head <= 0xfdff) return 'private';
  return 'public';
}

/** 名前解決を伴わない、名前そのものが内部を指すと分かる接尾辞。 */
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.localdomain', '.internal', '.intranet', '.home.arpa'] as const;

/**
 * ホスト（IPリテラルまたは名前）を分類する。
 *
 * 名前は解決しない。解決結果に依存すると判定がDNSの都合で揺れるため、
 * IPリテラルと「名前だけで内部と分かるもの」だけを内部扱いにし、残りは `public` とする
 * （名前が私設アドレスへ解決される場合の再検査は接続直前に adapters が行う）。
 */
export function classifyHost(host: string): HostClass {
  const normalized = normalizeHost(host);
  if (normalized === '') return 'private';
  if (normalized === 'localhost') return 'loopback';
  const octets = ipv4Octets(normalized);
  if (octets !== undefined) return classifyIpv4(octets);
  const ipv6 = classifyIpv6(normalized);
  if (ipv6 !== undefined) return ipv6;
  if (normalized.endsWith('.localhost')) return 'loopback';
  if (INTERNAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return 'private';
  return 'public';
}

/** 分類済みホストをポリシーに照らす。許可なら `undefined`。 */
export function checkHostClass(hostClass: HostClass, policy: UrlPolicy): UrlRejectionReason | undefined {
  if (hostClass === 'loopback' || hostClass === 'public') return undefined;
  // リンクローカルは opt-in でも開けない（クラウドメタデータの窃取が主目的の範囲）。
  if (hostClass === 'link-local') return 'link-local';
  return policy.allowPrivateNetwork ? undefined : 'private-network';
}

/** ホスト（IPリテラル・名前）をポリシーに照らす。許可なら `undefined`。 */
export function checkHost(host: string, policy: UrlPolicy): UrlRejectionReason | undefined {
  return checkHostClass(classifyHost(host), policy);
}

/**
 * URL文字列をポリシーに照らす。許可なら `undefined`、拒否なら理由を返す。
 *
 * 資格情報の埋め込み（`https://user:pass@host`）も併せて拒否する。URLはDB・ログ・API応答へ
 * そのまま残るため、そこへ秘密を書かせない（モデル設定の `baseUrl` と同じ規約）。
 */
export function checkUrl(raw: string, policy: UrlPolicy): UrlRejectionReason | undefined {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); }
  catch { return 'not-a-url'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'unsupported-scheme';
  if (parsed.username !== '' || parsed.password !== '') return 'embedded-credentials';
  return checkHost(parsed.hostname, policy);
}
