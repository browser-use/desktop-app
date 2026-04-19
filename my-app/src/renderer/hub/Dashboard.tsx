import React, { useMemo } from 'react';
import { Group } from '@visx/group';
import { scaleTime, scaleLinear } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { AxisBottom } from '@visx/axis';
import { ParentSize } from '@visx/responsive';
import { STATUS_LABEL } from './constants';
import { generateActivityData, getStatusBreakdown, MOCK_STATS } from './mock-metrics';
import type { AgentSession } from './types';
import type { ActivityPoint } from './mock-metrics';

const CHART_MARGIN = { top: 16, right: 0, bottom: 28, left: 0 };

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function ActivityChart({ width, height }: { width: number; height: number }): React.ReactElement | null {
  const data = useMemo(() => generateActivityData(7), []);

  if (width < 10 || height < 10) return null;

  const innerW = width - CHART_MARGIN.left - CHART_MARGIN.right;
  const innerH = height - CHART_MARGIN.top - CHART_MARGIN.bottom;

  const xScale = scaleTime({
    domain: [
      Math.min(...data.map((d) => d.time)),
      Math.max(...data.map((d) => d.time)),
    ],
    range: [0, innerW],
  });

  const yScale = scaleLinear({
    domain: [0, Math.max(...data.map((d) => d.sessions)) * 1.2],
    range: [innerH, 0],
    nice: true,
  });

  const getX = (d: ActivityPoint) => xScale(d.time) ?? 0;
  const getY = (d: ActivityPoint) => yScale(d.sessions) ?? 0;

  return (
    <svg width={width} height={height}>
      <LinearGradient id="area-gradient" from="rgba(109, 129, 150, 0.25)" to="rgba(109, 129, 150, 0)" />
      <Group left={CHART_MARGIN.left} top={CHART_MARGIN.top}>
        <AreaClosed
          data={data}
          x={getX}
          y={getY}
          yScale={yScale}
          curve={curveMonotoneX}
          fill="url(#area-gradient)"
        />
        <LinePath
          data={data}
          x={getX}
          y={getY}
          curve={curveMonotoneX}
          stroke="var(--color-accent-default)"
          strokeWidth={1.5}
          strokeOpacity={0.8}
        />
        <AxisBottom
          top={innerH}
          scale={xScale}
          numTicks={7}
          tickFormat={(v) => {
            const d = new Date(v as number);
            return d.toLocaleDateString([], { weekday: 'short' });
          }}
          stroke="var(--color-border-subtle)"
          tickStroke="transparent"
          tickLabelProps={() => ({
            fill: 'var(--color-fg-disabled)',
            fontSize: 10,
            fontFamily: 'var(--font-ui)',
            textAnchor: 'middle' as const,
            dy: 4,
          })}
          hideTicks
        />
      </Group>
    </svg>
  );
}

interface DashboardProps {
  sessions: AgentSession[];
  onSwitchToGrid: () => void;
}

export function Dashboard({ sessions, onSwitchToGrid }: DashboardProps): React.ReactElement {
  const runningCount = sessions.filter((s) => s.status === 'running').length;
  const stuckCount = sessions.filter((s) => s.status === 'stuck').length;
  const stoppedCount = sessions.filter((s) => s.status === 'stopped').length;

  const breakdown = useMemo(() => getStatusBreakdown(MOCK_STATS.totalSessions), []);
  const total = breakdown.reduce((sum, b) => sum + b.count, 0);

  const recentSessions = sessions.slice(0, 6);

  return (
    <div className="dashboard">
      <div className="dashboard__stats">
        <div className="dashboard__stat dashboard__stat--live">
          <span className="dashboard__stat-label">Running</span>
          <span className="dashboard__stat-value">
            <span className="dashboard__stat-dot dashboard__stat-dot--running" />
            {runningCount}
          </span>
        </div>
        <div className="dashboard__stat">
          <span className="dashboard__stat-label">Stuck</span>
          <span className="dashboard__stat-value">
            <span className="dashboard__stat-dot dashboard__stat-dot--stuck" />
            {stuckCount}
          </span>
        </div>
        <div className="dashboard__stat">
          <span className="dashboard__stat-label">Completed</span>
          <span className="dashboard__stat-value">{stoppedCount}</span>
        </div>
        <div className="dashboard__stat">
          <span className="dashboard__stat-label">Today</span>
          <span className="dashboard__stat-value">{MOCK_STATS.sessionsToday}</span>
        </div>
        <div className="dashboard__stat">
          <span className="dashboard__stat-label">Tokens used</span>
          <span className="dashboard__stat-value">{formatNumber(MOCK_STATS.totalTokens)}</span>
        </div>
      </div>

      <div className="dashboard__grid">
        <div className="dashboard__chart-card">
          <div className="dashboard__card-header">
            <span className="dashboard__card-title">Sessions (7d)</span>
          </div>
          <div className="dashboard__chart-area">
            <ParentSize>
              {({ width, height }) => <ActivityChart width={width} height={height} />}
            </ParentSize>
          </div>
        </div>

        <div className="dashboard__breakdown-card">
          <div className="dashboard__card-header">
            <span className="dashboard__card-title">Status breakdown</span>
            <span className="dashboard__card-count">{total} total</span>
          </div>
          <div className="dashboard__breakdown-bar">
            {breakdown.map((b) => (
              <div
                key={b.status}
                className={`dashboard__bar-segment dashboard__bar-segment--${b.status}`}
                style={{ flex: b.count }}
                title={`${b.label}: ${b.count}`}
              />
            ))}
          </div>
          <div className="dashboard__breakdown-legend">
            {breakdown.map((b) => (
              <div key={b.status} className="dashboard__legend-item">
                <span className={`dashboard__legend-dot dashboard__legend-dot--${b.status}`} />
                <span className="dashboard__legend-label">{b.label}</span>
                <span className="dashboard__legend-count">{b.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

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
            <div key={session.id} className="dashboard__recent-row">
              <span className={`dashboard__recent-dot dashboard__recent-dot--${session.status}`} />
              <span className="dashboard__recent-status">{STATUS_LABEL[session.status]}</span>
              <span className="dashboard__recent-prompt">{session.prompt}</span>
              <span className="dashboard__recent-elapsed">{formatElapsed(session.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
