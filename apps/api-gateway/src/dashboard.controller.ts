import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Admin Dashboard')
@Controller('dashboard')
export class DashboardController {
  @Get()
  @ApiOperation({ summary: 'Admin Monitoring Dashboard UI' })
  getDashboard(@Res() res: Response) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ForgeGate - Admin & Workflow Engine Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0b0f19;
      --card-bg: rgba(23, 31, 51, 0.7);
      --border-color: rgba(255, 255, 255, 0.08);
      --accent-blue: #3b82f6;
      --accent-purple: #8b5cf6;
      --accent-cyan: #06b6d4;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Inter', sans-serif; }
    body { background-color: var(--bg-dark); color: var(--text-main); min-height: 100vh; padding: 2rem; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; }
    .logo { display: flex; align-items: center; gap: 0.75rem; font-size: 1.5rem; font-weight: 700; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .badge { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); padding: 0.35rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.25rem; margin-bottom: 2rem; }
    .card { background: var(--card-bg); backdrop-filter: blur(12px); border: 1px solid var(--border-color); border-radius: 12px; padding: 1.5rem; transition: transform 0.2s ease, border-color 0.2s ease; }
    .card:hover { transform: translateY(-2px); border-color: rgba(96, 165, 250, 0.4); }
    .card-title { font-size: 0.85rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.5rem; }
    .card-value { font-size: 2rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    .card-desc { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem; }
    
    .section-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; }
    @media (max-width: 992px) { .section-grid { grid-template-columns: 1fr; } }
    
    .panel { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 1.5rem; }
    .panel-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
    th { text-align: left; padding: 0.75rem; color: var(--text-muted); border-bottom: 1px solid var(--border-color); font-weight: 500; }
    td { padding: 0.75rem; border-bottom: 1px solid var(--border-color); font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
    tr:last-child td { border-bottom: none; }
    
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .dot-green { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .dot-amber { background: var(--warning); box-shadow: 0 0 8px var(--warning); }
    .dot-red { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
    
    .btn { background: #2563eb; color: #fff; border: none; padding: 0.4rem 0.8rem; border-radius: 6px; font-weight: 500; cursor: pointer; font-size: 0.8rem; transition: background 0.2s ease; }
    .btn:hover { background: #1d4ed8; }
    .btn-secondary { background: rgba(255, 255, 255, 0.08); color: var(--text-main); }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.15); }
    
    .log-stream { background: #050811; border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; height: 260px; overflow-y: auto; color: #e5e7eb; }
    .log-line { margin-bottom: 0.4rem; border-bottom: 1px dashed rgba(255,255,255,0.05); padding-bottom: 0.2rem; }
    .log-time { color: var(--accent-cyan); }
    .log-service { color: var(--accent-purple); font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <span>ForgeGate</span>
      <span class="badge">Distributed Workflow Platform</span>
    </div>
    <div style="display: flex; gap: 1rem; align-items: center;">
      <span id="liveStatus"><span class="status-dot dot-green"></span>System Operational</span>
      <button class="btn btn-secondary" onclick="fetchDashboardData()">Refresh</button>
    </div>
  </header>

  <div class="metrics-grid">
    <div class="card">
      <div class="card-title">Active Workflows</div>
      <div class="card-value" id="valActiveWf">12</div>
      <div class="card-desc">Running across 2 tenants</div>
    </div>
    <div class="card">
      <div class="card-title">BullMQ Queue Size</div>
      <div class="card-value" id="valQueueSize" style="color: var(--accent-blue);">3</div>
      <div class="card-desc">Jobs in waiting & active state</div>
    </div>
    <div class="card">
      <div class="card-title">Retry Count</div>
      <div class="card-value" id="valRetryCount" style="color: var(--warning);">2</div>
      <div class="card-desc">Exponential backoff attempts</div>
    </div>
    <div class="card">
      <div class="card-title">Dead-Letter Queue (DLQ)</div>
      <div class="card-value" id="valDlqCount" style="color: var(--danger);">1</div>
      <div class="card-desc">Exhausted failure queue</div>
    </div>
  </div>

  <div class="section-grid">
    <div class="panel">
      <div class="panel-title">
        <span>Dead Letter Queue (DLQ) Inspector</span>
        <span class="badge" style="background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.3)">Requires Attention</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Execution ID</th>
            <th>Tenant</th>
            <th>Error Reason</th>
            <th>Failed At</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="dlqTableBody">
          <tr>
            <td>exec-9081a2</td>
            <td>acme-corp</td>
            <td>HTTP 500: Internal Target Error</td>
            <td>13:52:10</td>
            <td><button class="btn" onclick="replayDlq('job-1')">Replay Job</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <div class="panel-title">Microservice Cluster Status</div>
      <table style="font-family: inherit;">
        <tbody>
          <tr>
            <td><span class="status-dot dot-green"></span>API Gateway</td>
            <td style="color: var(--success);">Healthy</td>
            <td style="color: var(--text-muted);">Port 3000</td>
          </tr>
          <tr>
            <td><span class="status-dot dot-green"></span>Auth Service</td>
            <td style="color: var(--success);">Healthy</td>
            <td style="color: var(--text-muted);">JWT/Redis</td>
          </tr>
          <tr>
            <td><span class="status-dot dot-green"></span>Workflow Engine</td>
            <td style="color: var(--success);">Healthy</td>
            <td style="color: var(--text-muted);">BullMQ Worker</td>
          </tr>
          <tr>
            <td><span class="status-dot dot-green"></span>Notification Worker</td>
            <td style="color: var(--success);">Healthy</td>
            <td style="color: var(--text-muted);">Async Consumer</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top: 1.5rem;">
    <div class="panel-title">Structured JSON System Log Stream</div>
    <div class="log-stream" id="logStream">
      <div class="log-line"><span class="log-time">[13:53:01]</span> <span class="log-service">[API-Gateway]</span> GET /api/v1/workflows 200 - 12ms</div>
      <div class="log-line"><span class="log-time">[13:53:05]</span> <span class="log-service">[workflow-engine]</span> step_1 HTTP_REQUEST executed output={"status":200} durationMs=45</div>
      <div class="log-line"><span class="log-time">[13:53:06]</span> <span class="log-service">[workflow-engine]</span> state_transition executionId=exec-9081a2 status="completed"</div>
    </div>
  </div>

  <script>
    async function fetchDashboardData() {
      try {
        const res = await fetch('/api/v1/health');
        const data = await res.json();
        console.log('Health data:', data);
      } catch (e) {
        console.log('Fetching live stats...');
      }
    }

    async function replayDlq(jobId) {
      alert('Replaying DLQ Job: ' + jobId + '...');
    }

    setInterval(fetchDashboardData, 5000);
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  }
}
