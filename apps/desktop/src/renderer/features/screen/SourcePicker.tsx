import type { ReactNode } from 'react';
import { session } from '../../app/session';
import { useSpike } from '../../app/store';

/** Own picker over desktopCapturer thumbnails (screens + windows) plus synthetic test sources. */
export function SourcePicker(): ReactNode {
  const open = useSpike((s) => s.rt.pickerOpen);
  const sources = useSpike((s) => s.rt.sources);
  const screenAccess = useSpike((s) => s.rt.sysInfo?.screenAccess);
  if (!open) return null;
  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind === 'window');
  const noThumbs = sources.length > 0 && sources.every((s) => !s.thumbnail);

  return (
    <div className="modal-backdrop" onClick={() => session.closePicker()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="section-head">
          <h2>Что показать</h2>
          <button onClick={() => session.closePicker()}>Закрыть</button>
        </header>
        {noThumbs || screenAccess === 'denied' ? (
          <p className="hint">
            macOS не дал доступ к записи экрана.{' '}
            <button className="link" onClick={() => void window.calaba.system.openPrivacySettings('screen')}>
              Открыть «Запись экрана»
            </button>{' '}
            (после разрешения нужен перезапуск). Тестовые источники работают без разрешения.
          </p>
        ) : null}
        <h3>Тестовые источники (воспроизводимый замер)</h3>
        <div className="grid">
          <button className="tile" onClick={() => void session.startScreen({ kind: 'test', pattern: 'static' })}>
            <div className="thumb placeholder">static</div>
            <span>Статичный текст (код)</span>
          </button>
          <button className="tile" onClick={() => void session.startScreen({ kind: 'test', pattern: 'scroll' })}>
            <div className="thumb placeholder">scroll</div>
            <span>Скролл текста</span>
          </button>
        </div>
        {sources.length === 0 ? <p className="muted">Загрузка источников…</p> : null}
        {screens.length > 0 ? <h3>Экраны</h3> : null}
        <div className="grid">
          {screens.map((s) => (
            <SourceTile key={s.id} id={s.id} name={s.name} thumbnail={s.thumbnail} />
          ))}
        </div>
        {windows.length > 0 ? <h3>Окна</h3> : null}
        <div className="grid">
          {windows.map((s) => (
            <SourceTile key={s.id} id={s.id} name={s.name} thumbnail={s.thumbnail} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SourceTile(props: { id: string; name: string; thumbnail: string }): ReactNode {
  return (
    <button
      className="tile"
      title={props.name}
      onClick={() => void session.startScreen({ kind: 'desktop', id: props.id, name: props.name })}
    >
      {props.thumbnail ? <img className="thumb" src={props.thumbnail} alt="" /> : <div className="thumb placeholder">?</div>}
      <span>{props.name}</span>
    </button>
  );
}
