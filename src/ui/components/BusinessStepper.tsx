import { Fragment } from 'react';

/** 手順の 1 段。 */
export interface BusinessStep<Id extends string> {
  readonly id: Id;
  /** 読み上げ用の名前（aria-label）にも使う素のラベル。 */
  readonly label: string;
  /** ここで何をするか（見た目だけ）。 */
  readonly caption: string;
  /** 分かっている件数など（見た目だけ）。 */
  readonly badge?: string;
}

/**
 * 業務画面の手順（ADR-0039）。**設定する順**に番号つきの四角を並べ、間に矢印を置く。
 *
 * 四角がそのままタブなので、順序を示すものと操作するものが二重にならない。
 * 読み上げ用の名前は素のラベル（aria-label）にして、番号・説明・件数は見た目だけに留める。
 * どのタブを最初に開くかは画面が決める（設定表へいきなり着地させないため、手順の先頭とは限らない）。
 * 見た目は styles.css の `business-step*`（業務を足しても共有 CSS は触らない）。
 */
export function BusinessStepper<Id extends string>({ steps, active, onSelect, label }: {
  readonly steps: readonly BusinessStep<Id>[];
  readonly active: Id;
  readonly onSelect: (id: Id) => void;
  /** 手順全体の名前（tablist の aria-label）。 */
  readonly label: string;
}) {
  return <div className="business-steps" role="tablist" aria-label={label}>
    {steps.map((step, index) => <Fragment key={step.id}>
      <button type="button" role="tab" aria-selected={active === step.id} aria-label={step.label}
        className={`business-step${active === step.id ? ' active' : ''}`} onClick={() => onSelect(step.id)}>
        <span className="business-step-no" aria-hidden="true">{index + 1}</span>
        <span className="business-step-head">
          <span className="business-step-label">{step.label}</span>
          {step.badge !== undefined && <span className="business-step-badge">{step.badge}</span>}
        </span>
        <span className="business-step-caption">{step.caption}</span>
      </button>
      {index < steps.length - 1 && <span className="business-step-arrow" aria-hidden="true">→</span>}
    </Fragment>)}
  </div>;
}
