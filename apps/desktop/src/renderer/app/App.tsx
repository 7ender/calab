import type { ReactNode } from 'react';
import { ScreenPanel } from '../features/screen/ScreenPanel';
import { RemoteScreens } from '../features/screen/RemoteScreens';
import { SourcePicker } from '../features/screen/SourcePicker';
import { StatsPanel } from '../features/stats/StatsPanel';
import { ConnectionPanel } from '../features/voice/ConnectionPanel';
import { MicPanel } from '../features/voice/MicPanel';
import { Participants } from '../features/voice/Participants';
import { useSpike } from './store';

export function App(): ReactNode {
  const error = useSpike((s) => s.rt.error);
  const setRt = useSpike((s) => s.setRt);
  return (
    <div className="app">
      <aside className="col col-controls">
        <ConnectionPanel />
        <MicPanel />
        <ScreenPanel />
      </aside>
      <main className="col col-room">
        {error ? (
          <div className="error" role="alert">
            {error}
            <button className="link" onClick={() => setRt({ error: null })}>
              скрыть
            </button>
          </div>
        ) : null}
        <Participants />
        <RemoteScreens />
      </main>
      <aside className="col col-stats">
        <StatsPanel />
      </aside>
      <SourcePicker />
    </div>
  );
}
