/**
 * ツール作成画面のキャンバス配置（v51）。
 *
 * React・store・DOM に依存しない純関数だけを置く（同じ入力に同じ出力）。
 * 自動生成のどの経路もノードを横一列に並べていたため、実機で生成した 10 ノードのツールが
 * 幅 2,740px × 高さ 80px になり、画面に収めると文字が読めない大きさまで縮んだ。
 * ここで「処理の段数 = 列」を保ったまま列数で折り返し、縦横の比を画面に近づける。
 */

/** キャンバス座標（React Flow の XYPosition と同形）。 */
export interface CanvasPosition { readonly x: number; readonly y: number }

/** 先頭列の起点。starterグラフと、選択が無いときのパレット追加の基準点。 */
export const ORIGIN: CanvasPosition = { x: 80, y: 120 };
/** 配置間隔（min-width 170px のノードが重ならず、ハンドルのドラッグ接続が届く距離）。 */
export const PLACEMENT_STEP_X = 280;
export const PLACEMENT_STEP_Y = 140;
/** これより近い既存ノードがあれば「重なっている」と判定する箱のサイズ。 */
const NODE_FOOTPRINT_X = 200;
const NODE_FOOTPRINT_Y = 110;
/** 空き探索の幅。24×24=576スロットあり、graphSchemaのノード上限200でも空きが残る。 */
const PLACEMENT_SCAN = 24;

/**
 * 折り返す列数の既定と下限。4 列（幅 ≒ 1,040px）は 1280px 幅の画面でパレット・インスペクターと
 * 並べても収まる。3 列未満にすると「入力 → 加工 → 出力」の最短の流れすら 1 帯に収まらず、
 * 折り返しの斜めの線ばかりになって読む向きが分からなくなる。
 */
export const DEFAULT_LAYOUT_COLUMNS = 4;
export const MIN_LAYOUT_COLUMNS = 3;
/** 帯と帯の間の余白。行の間（140 - ノードの高さ ≒ 60px）より広く取り、帯の切れ目を目で追えるようにする。 */
export const BAND_GAP = 60;

/** 配置に要るノードの形（GraphNodeDto も ToolFlowNode もこの形を満たす。余分な項目は見ない）。 */
export interface LayoutNode { readonly id: string }
/** 配置に要るエッジの形（GraphEdgeDto と同形。キャンバスのエッジは source/target を写して渡す）。 */
export interface LayoutEdge { readonly from: string; readonly to: string }

export interface LayoutOptions {
  /** 1 帯に置く列の数。既定 4、3 未満は 3 に上げる（画面は表示幅から `columnsForWidth` で決めて渡す）。 */
  readonly maxColumns?: number;
}

/** 指定された列数を使える値へ丸める（NaN・無限大・小数は既定か整数へ）。 */
export function normalizeColumns(maxColumns: number | undefined): number {
  if (maxColumns === undefined || !Number.isFinite(maxColumns)) return DEFAULT_LAYOUT_COLUMNS;
  return Math.max(MIN_LAYOUT_COLUMNS, Math.floor(maxColumns));
}

/** キャンバスの表示幅（px）から、ズーム 1 で横に収まる列数を返す。測れない（0 等）ときは下限の 3 列。 */
export function columnsForWidth(width: number): number {
  return normalizeColumns(Number.isFinite(width) ? Math.floor(width / PLACEMENT_STEP_X) : undefined);
}

/** 既存の配置と視覚的に重なるか。 */
function occupied(positions: readonly CanvasPosition[], position: CanvasPosition): boolean {
  return positions.some((placed) =>
    Math.abs(placed.x - position.x) < NODE_FOOTPRINT_X && Math.abs(placed.y - position.y) < NODE_FOOTPRINT_Y);
}

/** 希望位置が占有済みなら下方向へ、列が埋まっていれば右列へずらして空き位置を返す。 */
export function freePosition(positions: readonly CanvasPosition[], desired: CanvasPosition): CanvasPosition {
  for (let column = 0; column < PLACEMENT_SCAN; column += 1) {
    for (let row = 0; row < PLACEMENT_SCAN; row += 1) {
      const candidate = { x: desired.x + column * PLACEMENT_STEP_X, y: desired.y + row * PLACEMENT_STEP_Y };
      if (!occupied(positions, candidate)) return candidate;
    }
  }
  return desired;
}

/**
 * 保存済みDTOの配置を復元する（一部のノードだけが position を持つとき）。
 * `position` があればそれを使い、無いノード（position導入前の保存データ）は
 * 従来の自動グリッドへ退避する（復元済みの配置と重なる場合はずらす）。
 * **全ノード**が position を持たないときは、呼び出し側が `layoutWrapped` で並べる。
 */
export function loadedPositions(graphNodes: readonly { readonly position?: CanvasPosition }[]): CanvasPosition[] {
  const saved = graphNodes.map((node) => node.position === undefined ? undefined : { x: node.position.x, y: node.position.y });
  const placed: CanvasPosition[] = saved.filter((position): position is CanvasPosition => position !== undefined);
  return saved.map((position, index) => {
    if (position !== undefined) return position;
    const fallback = freePosition(placed, { x: ORIGIN.x + index * PLACEMENT_STEP_X, y: ORIGIN.y });
    placed.push(fallback);
    return fallback;
  });
}

/**
 * 各ノードの列（入力からの最長距離）。
 *
 * 入次数 0 から辿るトポロジカル順で確定させる。循環は保存前の検査が弾くので本来無いが、
 * 辿り切れずに残った節（循環とその下流）は確定した最深の列のさらに右へ置いて**必ず終わる**。
 * グラフに無いノードを指すエッジは無視する（描画できない線で列をずらさない）。
 */
function depthColumns(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0] as const));
  for (const edge of valid) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const depth = new Map<string, number>();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (const id of queue) depth.set(id, 0);
  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head] as string;
    for (const edge of valid) {
      if (edge.from !== from) continue;
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, (depth.get(from) ?? 0) + 1));
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  const resolved = new Set(queue);
  const deepest = nodes.reduce((max, node) => resolved.has(node.id) ? Math.max(max, depth.get(node.id) ?? 0) : max, -1);
  for (const node of nodes) if (!resolved.has(node.id)) depth.set(node.id, deepest + 1);
  return depth;
}

/**
 * 位置を持たないグラフを左→右へ 1 帯で並べる（折り返さない）。
 *
 * 列はトポロジカルな深さ（入力からの最長距離）、行は同じ深さの中の出現順。
 * 深さを使うのは、結合のように 2 本の枝が合流する形で「合流先が両方の右に来る」ためで、
 * 単純な出現順に並べると枝が重なって読めなくなる。自動生成の経路は `layoutWrapped` を使う。
 */
export function layoutByDepth<N extends LayoutNode, E extends LayoutEdge>(nodes: readonly N[], edges: readonly E[]): CanvasPosition[] {
  const depth = depthColumns(nodes, edges);
  const rows = new Map<number, number>();
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { x: ORIGIN.x + column * PLACEMENT_STEP_X, y: ORIGIN.y + row * PLACEMENT_STEP_Y };
  });
}

/**
 * 段組み＋折り返しで並べる（v51）。戻り値は `nodes` と同じ順の座標。
 *
 * 1. 列 = 処理の段数（`layoutByDepth` と同じ）。同じ段の複数ノード（結合の 2 本の入力）は縦に並べ、
 *    段の中の順は上流の行の平均で決めて線の交差を減らす（上流が無いものは出現順で後ろへ）。
 * 2. `maxColumns` を超えた段は次の帯へ送り、次の帯も**左から右へ**流す（読む向きを変えない）。
 *    帯の高さは、その帯で最も縦に積まれた列の高さ + `BAND_GAP`。
 * 3. エッジを持たないノード（`agent-input` など）は最上段の「引数の帯」に左から並べ、処理の列を奪わない。
 */
export function layoutWrapped<N extends LayoutNode, E extends LayoutEdge>(nodes: readonly N[], edges: readonly E[], options: LayoutOptions = {}): CanvasPosition[] {
  const maxColumns = normalizeColumns(options.maxColumns);
  const ids = new Set(nodes.map((node) => node.id));
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const linked = new Set(valid.flatMap((edge) => [edge.from, edge.to]));
  const placed = new Map<string, CanvasPosition>();

  // 引数の帯: 未接続のノードを左から、maxColumns ごとに折り返して並べる。
  const loose = nodes.filter((node) => !linked.has(node.id));
  loose.forEach((node, index) => placed.set(node.id, {
    x: ORIGIN.x + (index % maxColumns) * PLACEMENT_STEP_X,
    y: ORIGIN.y + Math.floor(index / maxColumns) * PLACEMENT_STEP_Y,
  }));
  const argumentRows = Math.ceil(loose.length / maxColumns);
  let bandTop = ORIGIN.y + (argumentRows === 0 ? 0 : argumentRows * PLACEMENT_STEP_Y + BAND_GAP);

  // 処理の列: 段ごとに集め、上流の行の平均（barycenter）で段の中の順を決める。
  const flow = nodes.filter((node) => linked.has(node.id));
  const depth = depthColumns(flow, valid);
  const columns: string[][] = [];
  for (const node of flow) {
    const column = depth.get(node.id) ?? 0;
    (columns[column] ??= []).push(node.id);
  }
  const rowOf = new Map<string, number>();
  const order = new Map(flow.map((node, index) => [node.id, index] as const));
  const sorted = columns.map((members) => {
    const weight = (id: string): number => {
      const upstream = valid.filter((edge) => edge.to === id)
        .map((edge) => rowOf.get(edge.from))
        .filter((row): row is number => row !== undefined);
      return upstream.length === 0 ? Number.POSITIVE_INFINITY : upstream.reduce((sum, row) => sum + row, 0) / upstream.length;
    };
    const weights = new Map(members.map((id) => [id, weight(id)] as const));
    const ordered = [...members].sort((left, right) =>
      (weights.get(left) as number) - (weights.get(right) as number) || (order.get(left) as number) - (order.get(right) as number));
    ordered.forEach((id, row) => rowOf.set(id, row));
    return ordered;
  });

  for (let first = 0; first < sorted.length; first += maxColumns) {
    const band = sorted.slice(first, first + maxColumns);
    band.forEach((members, offset) => members.forEach((id, row) => placed.set(id, {
      x: ORIGIN.x + offset * PLACEMENT_STEP_X,
      y: bandTop + row * PLACEMENT_STEP_Y,
    })));
    const tallest = band.reduce((max, members) => Math.max(max, members.length), 0);
    bandTop += tallest * PLACEMENT_STEP_Y + BAND_GAP;
  }
  return nodes.map((node) => placed.get(node.id) ?? ORIGIN);
}

/** 設計アシスタントが足したノードを、上流ノードのどれだけ右に置くか（ADR-0051 の「右に 1 つ」）。 */
const DESIGN_CHAT_OFFSET_X = 220;

/**
 * 設計アシスタントが返したグラフの配置を決める（v47）。
 *
 * サーバーは変えなかったノードの position を写して返すので、基本はそれをそのまま使い、
 * 人が並べた形を崩さない。position が無いのは**新しく足されたノード**で、
 * サーバーの changes には `after` が無いため、エッジを辿って上流を引き、その右へ置く
 * （上流も新しい場合があるので、置けたものから繰り返し決める）。
 * 上流が無いノード（source を足した等）は既存の最右列のさらに右へ縦に並べる。
 *
 * v51: 右へ足し続けると横一列に伸びるので、右端の上限（`ORIGIN.x + maxColumns × STEP_X`）を
 * 越える位置は、今あるノードの最下端の下に新しい帯を作ってその左端へ送る（既存ノードは動かさない）。
 */
export function designChatPositions<N extends LayoutNode & { readonly position?: CanvasPosition }, E extends LayoutEdge>(
  graph: { readonly nodes: readonly N[]; readonly edges: readonly E[] },
  previous: readonly { readonly id: string; readonly position: CanvasPosition }[],
  options: LayoutOptions = {},
): ReadonlyMap<string, CanvasPosition> {
  const kept = new Map(previous.map((node) => [node.id, node.position] as const));
  const placed = new Map<string, CanvasPosition>();
  const pending: string[] = [];
  for (const node of graph.nodes) {
    // position を落として返されても、既に画面にあるノードなら前の配置を保つ。
    const position = node.position ?? kept.get(node.id);
    if (position === undefined) pending.push(node.id); else placed.set(node.id, position);
  }
  const rightLimit = ORIGIN.x + normalizeColumns(options.maxColumns) * PLACEMENT_STEP_X;
  // 新しい帯の上端は「適用前から見えているノード」の最下端で決め、足したノードで下へずれ続けないようにする。
  const bottom = [...placed.values()].reduce((max, position) => Math.max(max, position.y), Number.NEGATIVE_INFINITY);
  const nextBand: CanvasPosition = { x: ORIGIN.x, y: bottom === Number.NEGATIVE_INFINITY ? ORIGIN.y : bottom + PLACEMENT_STEP_Y + BAND_GAP };
  const wrap = (desired: CanvasPosition): CanvasPosition => desired.x > rightLimit ? nextBand : desired;
  // 上流が決まったものから右へ置く。1 周で 1 つも置けなくなったら、残りは上流が無い（か循環している）。
  // 鎖が下流から順に並んでいると 1 周で 1 つしか決まらないので、最大でもノード数だけ周回する。
  const rounds = pending.length;
  for (let round = 0; round < rounds && pending.length > 0; round += 1) {
    let progressed = false;
    for (const id of [...pending]) {
      const upstream = graph.edges.filter((edge) => edge.to === id)
        .map((edge) => placed.get(edge.from))
        .filter((position): position is CanvasPosition => position !== undefined);
      if (upstream.length === 0) continue;
      // 2 入力（join / union）はどちらの枝よりも右に来るよう、最も右の上流を基準にする。
      const anchor = upstream.reduce((right, position) => position.x > right.x ? position : right);
      placed.set(id, freePosition([...placed.values()], wrap({ x: anchor.x + DESIGN_CHAT_OFFSET_X, y: anchor.y })));
      pending.splice(pending.indexOf(id), 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  const rightmost = [...placed.values()].reduce((right, position) => Math.max(right, position.x), ORIGIN.x - PLACEMENT_STEP_X);
  for (const id of pending) {
    // 同じ列を指すので freePosition が行をずらし、結果として縦に並ぶ。
    placed.set(id, freePosition([...placed.values()], wrap({ x: rightmost + PLACEMENT_STEP_X, y: ORIGIN.y })));
  }
  return placed;
}
