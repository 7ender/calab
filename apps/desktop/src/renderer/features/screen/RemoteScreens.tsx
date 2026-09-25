import { useEffect, useRef, type ReactNode } from 'react';
import { session } from '../../app/session';
import { useSpike, type RemoteScreenView } from '../../app/store';
import { Section } from '../../app/ui';

/**
 * Remote screen tiles: 320×180 thumbnail, click to expand. The element size
 * drives adaptive stream → the SFU switches layers (watch the stats panel).
 */
export function RemoteScreens(): ReactNode {
  const screens = useSpike((s) => s.rt.remoteScreens);
  const expanded = useSpike((s) => s.rt.expandedScreen);
  const setRt = useSpike((s) => s.setRt);
  if (screens.length === 0) return null;
  return (
    <Section title="Стримы участников" aside={<span className="muted small">клик — развернуть / свернуть</span>}>
      <div className="screens">
        {screens.map((s) => (
          <ScreenTile
            key={s.trackSid}
            view={s}
            expanded={expanded === s.trackSid}
            onToggle={() => setRt({ expandedScreen: expanded === s.trackSid ? null : s.trackSid })}
          />
        ))}
      </div>
    </Section>
  );
}

function ScreenTile(props: { view: RemoteScreenView; expanded: boolean; onToggle: () => void }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const sid = props.view.trackSid;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    session.attachRemoteVideo(sid, el);
    return () => session.detachRemoteVideo(sid, el);
  }, [sid]);
  return (
    <figure className={`screen-tile ${props.expanded ? 'expanded' : ''}`} onClick={props.onToggle}>
      <video ref={ref} muted playsInline autoPlay />
      <figcaption>
        {props.view.name} · опубликовано {props.view.published}
      </figcaption>
    </figure>
  );
}
