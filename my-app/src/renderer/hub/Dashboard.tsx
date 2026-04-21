import React, { useMemo } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { ParentSize } from '@visx/responsive';
import { STATUS_LABEL } from './constants';
import { TaskInput } from './TaskInput';
import { DashboardBackground } from './DashboardBackground';
import type { AgentSession } from './types';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Cumulative count of sessions in `status` across sessions created within `windowMs`.
// X-axis is session-index rank, so points spread evenly across the sparkline width.
function buildStatusSeries(sessions: AgentSession[], status: string, windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  const sorted = sessions.filter((s) => s.createdAt >= cutoff).sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length === 0) return [0, 0];
  const out: number[] = [0];
  let count = 0;
  for (const s of sorted) {
    if (s.status === status) count += 1;
    out.push(count);
  }
  return out;
}

// Strictly monotonic cumulative total of sessions created within `windowMs`.
function buildTotalSeries(sessions: AgentSession[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  const sorted = sessions.filter((s) => s.createdAt >= cutoff).sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length === 0) return [0, 0];
  return [0, ...sorted.map((_, i) => i + 1)];
}

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

interface SparklineProps {
  values: number[];
  gradientId: string;
  width: number;
  height: number;
  color: string;
  fillFrom: string;
  fillTo: string;
}

function Sparkline({ values, gradientId, width, height, color, fillFrom, fillTo }: SparklineProps): React.ReactElement | null {
  const data = values.length > 0 ? values : [0, 0];
  const xScale = useMemo(
    () => scaleLinear({ domain: [0, data.length - 1], range: [0, width] }),
    [data.length, width],
  );
  const yScale = useMemo(
    () => scaleLinear({
      domain: [Math.min(...data), Math.max(...data, 1) * 1.1],
      range: [height - 2, 2],
    }),
    [data, height],
  );

  return (
    <svg width={width} height={height} className="sparkline">
      <LinearGradient id={gradientId} from={fillFrom} to={fillTo} />
      <Group>
        <AreaClosed
          data={data}
          x={(_, i) => xScale(i) ?? 0}
          y={(d) => yScale(d) ?? 0}
          yScale={yScale}
          curve={curveMonotoneX}
          fill={`url(#${gradientId})`}
        />
        <LinePath
          data={data}
          x={(_, i) => xScale(i) ?? 0}
          y={(d) => yScale(d) ?? 0}
          curve={curveMonotoneX}
          stroke={color}
          strokeWidth={1.5}
          strokeOpacity={0.9}
        />
      </Group>
    </svg>
  );
}

const SPARK_COLORS = {
  running:   { line: '#9ECE6A', from: 'rgba(158, 206, 106, 0.30)', to: 'rgba(158, 206, 106, 0)' },
  completed: { line: '#E0AF68', from: 'rgba(224, 175, 104, 0.32)', to: 'rgba(224, 175, 104, 0)' },
  today:     { line: '#7AA2F7', from: 'rgba(122, 162, 247, 0.32)', to: 'rgba(122, 162, 247, 0)' },
};

interface DashboardProps {
  sessions: AgentSession[];
  onSwitchToGrid: () => void;
  onSelectSession?: (id: string) => void;
  onSubmitTask: (prompt: string) => void;
}

export function Dashboard({ sessions, onSwitchToGrid, onSelectSession, onSubmitTask }: DashboardProps): React.ReactElement {
  const runningCount = sessions.filter((s) => s.status === 'running').length;
  const idleCount = sessions.filter((s) => s.status === 'idle').length;

  const runningSeries = useMemo(() => buildStatusSeries(sessions, 'running', HOUR), [sessions]);
  const idleSeries = useMemo(() => buildStatusSeries(sessions, 'idle', DAY), [sessions]);
  const totalSeries = useMemo(() => buildTotalSeries(sessions, 7 * DAY), [sessions]);

  const recentSessions = sessions.slice(0, 6);

  return (
    <div className="dashboard">
      <DashboardBackground />
      <div className="dashboard__hero">
        <TaskInput onSubmit={onSubmitTask} />
      </div>

      <div className="dashboard__cards">
        <div className="dashboard__stat-card">
          <div className="dashboard__stat-card-head">
            <span className="dashboard__stat-card-label">Running now</span>
          </div>
          <span className="dashboard__stat-card-value">{runningCount}</span>
          <div className="dashboard__stat-card-spark">
            <ParentSize>{({ width }) => <Sparkline values={runningSeries} gradientId="spark-running" width={width} height={64} color={SPARK_COLORS.running.line} fillFrom={SPARK_COLORS.running.from} fillTo={SPARK_COLORS.running.to} />}</ParentSize>
          </div>
        </div>

        <div className="dashboard__stat-card">
          <div className="dashboard__stat-card-head">
            <span className="dashboard__stat-card-label">Idle</span>
          </div>
          <span className="dashboard__stat-card-value">{idleCount}</span>
          <div className="dashboard__stat-card-spark">
            <ParentSize>{({ width }) => <Sparkline values={idleSeries} gradientId="spark-completed" width={width} height={64} color={SPARK_COLORS.completed.line} fillFrom={SPARK_COLORS.completed.from} fillTo={SPARK_COLORS.completed.to} />}</ParentSize>
          </div>
        </div>

        <div className="dashboard__stat-card">
          <div className="dashboard__stat-card-head">
            <span className="dashboard__stat-card-label">Total sessions</span>
          </div>
          <span className="dashboard__stat-card-value">{sessions.length}</span>
          <div className="dashboard__stat-card-spark">
            <ParentSize>{({ width }) => <Sparkline values={totalSeries} gradientId="spark-today" width={width} height={64} color={SPARK_COLORS.today.line} fillFrom={SPARK_COLORS.today.from} fillTo={SPARK_COLORS.today.to} />}</ParentSize>
          </div>
        </div>
      </div>

      {recentSessions.length > 0 && (
        <div className="dashboard__recent">
          <div className="dashboard__card-header">
            <span className="dashboard__card-title">Recent sessions</span>
            <button className="dashboard__view-all" onClick={onSwitchToGrid}>
              View all
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="dashboard__recent-list">
            {recentSessions.map((session) => (
              <div
                key={session.id}
                className="dashboard__recent-row"
                onClick={() => onSelectSession?.(session.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onSelectSession?.(session.id); }}
              >
                <span className={`dashboard__recent-dot dashboard__recent-dot--${session.status}`} />
                <span className="dashboard__recent-status">{STATUS_LABEL[session.status]}</span>
                {session.group && <span className="dashboard__recent-group">{session.group}</span>}
                <span className="dashboard__recent-prompt">{session.prompt}</span>
                <span className="dashboard__recent-elapsed">{formatElapsed(session.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
