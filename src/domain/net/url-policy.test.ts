import { describe, expect, it } from 'vitest';
import { checkHost, checkUrl, classifyHost, DEFAULT_URL_POLICY, URL_REJECTION_MESSAGE, type UrlPolicy } from './url-policy';

const allowPrivate: UrlPolicy = { allowPrivateNetwork: true };

describe('classifyHost', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.13.9.1', 'loopback'],
    ['localhost', 'loopback'],
    ['LocalHost', 'loopback'],
    ['app.localhost', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
  ])('%s はループバック', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it.each([
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['FEBF::abcd', 'link-local'],
    ['::ffff:169.254.169.254', 'link-local'],
  ])('%s はリンクローカル', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it.each([
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['0.0.0.0', 'private'],
    ['198.18.0.1', 'private'],
    ['192.0.0.1', 'private'],
    ['239.1.2.3', 'private'],
    ['::', 'private'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['printer.local', 'private'],
    ['db.internal', 'private'],
    ['host.home.arpa', 'private'],
    ['::ffff:10.0.0.5', 'private'],
    ['', 'private'],
  ])('%s は私設扱い', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it.each([
    ['example.com', 'public'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['172.15.0.1', 'public'],
    ['2606:4700::1111', 'public'],
    ['example.com.', 'public'],
  ])('%s は公開扱い', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it('先頭ゼロのオクテットはIPv4リテラルとして扱わない（8進解釈の回避）', () => {
    // `010.0.0.1` を 10.0.0.1 と解釈する実装があるため、リテラルとしては受け付けず名前扱いにする。
    expect(classifyHost('010.0.0.1')).toBe('public');
  });

  it.each([
    ['1:2:3:4:5:6:7', 'public'],
    ['1::2::3', 'public'],
    ['gggg::1', 'public'],
    ['::ffff:999.1.1.1', 'public'],
  ])('IPv6として展開できない %s は名前として扱う（判定を落とさない）', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe('checkUrl', () => {
  it('ループバックは既定でも許可される（ローカルMCPサーバー・LM Studio）', () => {
    expect(checkUrl('http://127.0.0.1:3000/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
    expect(checkUrl('http://localhost:1234/v1', DEFAULT_URL_POLICY)).toBeUndefined();
  });

  it('公開インターネット宛は許可される', () => {
    expect(checkUrl('https://example.com/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
  });

  it('クラウドメタデータは opt-in しても拒否される', () => {
    expect(checkUrl('http://169.254.169.254/latest/meta-data/', DEFAULT_URL_POLICY)).toBe('link-local');
    expect(checkUrl('http://169.254.169.254/latest/meta-data/', allowPrivate)).toBe('link-local');
  });

  it('私設範囲は既定で拒否され、opt-in で許可される', () => {
    expect(checkUrl('http://10.0.0.5:8080/mcp', DEFAULT_URL_POLICY)).toBe('private-network');
    expect(checkUrl('http://10.0.0.5:8080/mcp', allowPrivate)).toBeUndefined();
    expect(checkUrl('http://192.168.1.20:1234/v1', allowPrivate)).toBeUndefined();
  });

  /**
   * **`classifyHost` を直接呼ぶテストでは検出できない穴**の回帰。
   *
   * `new URL()` はIPv6リテラルを必ず16進形へ正規化する
   * （`[::ffff:169.254.169.254]` → `[::ffff:a9fe:a9fe]`）。分類器がドット10進の表記しか
   * 見ていないと、`classifyHost('::ffff:169.254.169.254')` は正しく link-local を返すのに
   * `checkUrl('http://[::ffff:169.254.169.254]/')` は素通しする、という食い違いが起きる。
   * 実際にそうなっており、クラウドメタデータへ到達できていた。
   * よってこの系統の検査は**必ず `checkUrl` 経由**で書く。
   */
  describe('IPv4を埋め込んだIPv6（URLの正規化を経由して判定する）', () => {
    it.each([
      // IPv4射影（RFC4291）。利用者が書く表記と、new URL() が作る表記の両方。
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      'http://[0:0:0:0:0:ffff:169.254.169.254]/latest/meta-data/',
      // IPv4変換（RFC2765）。
      'http://[::ffff:0:169.254.169.254]/',
      // 旧IPv4互換（RFC4291で非推奨だが表記としては通る）。
      'http://[::169.254.169.254]/',
      'http://[::a9fe:a9fe]/',
    ])('%s は opt-in しても link-local として拒否される', (url) => {
      expect(checkUrl(url, DEFAULT_URL_POLICY)).toBe('link-local');
      expect(checkUrl(url, allowPrivate)).toBe('link-local');
    });

    it.each([
      'http://[::ffff:10.0.0.5]/mcp',
      'http://[::ffff:a00:5]/mcp',
      'http://[::ffff:192.168.1.20]/mcp',
    ])('%s は私設扱い（既定で拒否・opt-in で許可）', (url) => {
      expect(checkUrl(url, DEFAULT_URL_POLICY)).toBe('private-network');
      expect(checkUrl(url, allowPrivate)).toBeUndefined();
    });

    it('射影されたループバックと公開アドレスは従来どおり通る', () => {
      expect(checkUrl('http://[::ffff:127.0.0.1]:3000/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
      expect(checkUrl('http://[::1]:3000/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
      expect(checkUrl('http://[::ffff:8.8.8.8]/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
      expect(checkUrl('http://[2606:4700::1111]/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
    });

    it('未指定アドレス（::）とユニークローカルは私設のまま', () => {
      expect(checkUrl('http://[::]:8080/mcp', DEFAULT_URL_POLICY)).toBe('private-network');
      expect(checkUrl('http://[fd00::1]:8080/mcp', DEFAULT_URL_POLICY)).toBe('private-network');
      expect(checkUrl('http://[fe80::1]:8080/mcp', DEFAULT_URL_POLICY)).toBe('link-local');
    });
  });

  it.each([
    ['ftp://example.com/x', 'unsupported-scheme'],
    ['file:///etc/passwd', 'unsupported-scheme'],
    ['not a url', 'not-a-url'],
    ['https://user:pass@example.com/mcp', 'embedded-credentials'],
  ])('%s は %s で拒否される', (raw, reason) => {
    expect(checkUrl(raw, DEFAULT_URL_POLICY)).toBe(reason);
  });

  it('拒否理由はすべて説明文を持つ（UIへ出す文言の抜けを防ぐ）', () => {
    for (const reason of ['not-a-url', 'unsupported-scheme', 'embedded-credentials', 'link-local', 'private-network'] as const) {
      expect(URL_REJECTION_MESSAGE[reason]).toBeTruthy();
    }
  });

  it('説明文は宛先やDNS/接続の成否を含まない（内部構造を漏らさない）', () => {
    for (const message of Object.values(URL_REJECTION_MESSAGE)) {
      expect(message).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    }
  });
});

describe('checkHost', () => {
  it('DNS解決後のアドレス再検査に使える', () => {
    expect(checkHost('10.1.2.3', DEFAULT_URL_POLICY)).toBe('private-network');
    expect(checkHost('127.0.0.1', DEFAULT_URL_POLICY)).toBeUndefined();
    expect(checkHost('169.254.169.254', allowPrivate)).toBe('link-local');
  });
});
