import type { ReactNode } from 'react';

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode }): ReactNode {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{props.title}</h2>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function fmt(v: number | null | undefined, digits = 0, unit = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}${unit}`;
}
