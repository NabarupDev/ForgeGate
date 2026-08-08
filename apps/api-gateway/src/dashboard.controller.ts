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
  <title>ForgeGate - Microservice & Workflow Engine Dashboard</title>
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
      <span class="badge">Microservice Ecosystem</span>
    </div>
    <div style="display: flex; gap: 1rem; align-items: center;">
      <a href="/api/v1/docs" target="_blank" class="btn btn-secondary" style="text-decoration: none;">Open Swagger Docs</a>
      <span id="liveStatus"><span class="status-dot dot-green"></span>Checking Status...</span>
      <button class="btn btn-secondary" onclick="fetchDashboardData()">Refresh</button>
    </div>
  </header>

  <div class="metrics-grid">
    <div class="card">
      <div class="card-title">Active Queue Workflows</div>
      <div class="card-value" id="valActiveWf" style="color: var(--accent-blue);">0</div>
      <div class="card-desc">Active BullMQ workflow jobs</div>
    </div>
    <div class="card">
      <div class="card-title">Waiting Jobs</div>
      <div class="card-value" id="valQueueSize" style="color: var(--accent-cyan);">0</div>
      <div class="card-desc">Enqueued execution queue</div>
    </div>
    <div class="card">
      <div class="card-title">Completed Executions</div>
      <div class="card-value" id="valCompletedJobs" style="color: var(--success);">0</div>
      <div class="card-desc">Processed workflow jobs</div>
    </div>
    <div class="card">
      <div class="card-title">Dead-Letter Queue (DLQ)</div>
      <div class="card-value" id="valDlqCount" style="color: var(--danger);">0</div>
      <div class="card-desc">Exhausted failure queue</div>
    </div>
  </div>

  <div class="section-grid">
    <div class="panel">
      <div class="panel-title">
        <span>Dead Letter Queue (DLQ) Inspector</span>
        <span class="badge" id="dlqBadge" style="background: rgba(16,185,129,0.15); color: #34d399; border-color: rgba(16,185,129,0.3)">All Queues Clean</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Job / Execution ID</th>
            <th>Tenant / Step</th>
            <th>Failure Reason & Category</th>
            <th>Attempts & Rate Limit</th>
            <th>Replay Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="dlqTableBody">
          <tr>
            <td colspan="6" style="text-align: center; color: var(--text-muted);">No jobs currently in Dead Letter Queue</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <div class="panel-title">Microservice Cluster Status</div>
      <table style="font-family: inherit;">
        <tbody id="clusterTable">
          <tr>
            <td><span class="status-dot dot-green"></span>API Gateway</td>
            <td style="color: var(--success);">Healthy</td>
            <td style="color: var(--text-muted);">Port 3000</td>
          </tr>
          <tr>
            <td><span class="status-dot dot-amber"></span>Auth Service</td>
            <td style="color: var(--warning);">Connecting...</td>
            <td style="color: var(--text-muted);">Port 3001</td>
          </tr>
          <tr>
            <td><span class="status-dot dot-amber"></span>Workflow Engine</td>
            <td style="color: var(--warning);">Connecting...</td>
            <td style="color: var(--text-muted);">Port 3002</td>
          </tr>
          <tr>
            <td><span class="status-dot dot-amber"></span>Notification Worker</td>
            <td style="color: var(--warning);">Connecting...</td>
            <td style="color: var(--text-muted);">Port 3003</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top: 1.5rem;">
    <div class="panel-title">Real-Time Event Audit Stream</div>
    <div class="log-stream" id="logStream">
      <div class="log-line"><span class="log-time">[` + new Date().toLocaleTimeString() + `]</span> <span class="log-service">[API-Gateway]</span> Real-time monitoring console initialized</div>
    </div>
  </div>

  <script>
    function addLogLine(service, msg) {
      const stream = document.getElementById('logStream');
      const time = new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.className = 'log-line';
      div.innerHTML = '<span class="log-time">[' + time + ']</span> <span class="log-service">[' + service + ']</span> ' + msg;
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
    }

    async function fetchDashboardData() {
      try {
        const res = await fetch('/api/v1/health');
        const data = await res.json();
        
        const overall = data.status || 'degraded';
        const liveStatusEl = document.getElementById('liveStatus');
        if (overall === 'healthy') {
          liveStatusEl.innerHTML = '<span class="status-dot dot-green"></span>System Operational';
        } else {
          liveStatusEl.innerHTML = '<span class="status-dot dot-amber"></span>System Degraded';
        }

        const s = data.services || {};
        const getRow = (name, port, sObj) => {
          const isUp = sObj && sObj.status === 'up';
          const dot = isUp ? 'dot-green' : 'dot-red';
          const txt = isUp ? 'Healthy' : 'Down';
          const clr = isUp ? 'var(--success)' : 'var(--danger)';
          return '<tr><td><span class="status-dot ' + dot + '"></span>' + name + '</td><td style="color: ' + clr + ';">' + txt + '</td><td style="color: var(--text-muted);">' + port + '</td></tr>';
        };

        document.getElementById('clusterTable').innerHTML = 
          getRow('API Gateway', 'Port 3000', { status: 'up' }) +
          getRow('Auth Service', 'Port 3001', s.authService) +
          getRow('Workflow Engine', 'Port 3002', s.workflowService) +
          getRow('Notification Worker', 'Port 3003', s.notificationService);

        // Fetch Queue Metrics
        const mRes = await fetch('/api/v1/workflows/metrics/queue');
        if (mRes.ok) {
          const mData = await mRes.json();
          document.getElementById('valActiveWf').innerText = mData.activeJobs || 0;
          document.getElementById('valQueueSize').innerText = mData.waitingJobs || 0;
          document.getElementById('valCompletedJobs').innerText = mData.completedJobs || 0;
          document.getElementById('valDlqCount').innerText = mData.dlqCount || 0;
        }

        // Fetch DLQ Jobs
        const dlqRes = await fetch('/api/v1/workflows/dlq/jobs');
        if (dlqRes.ok) {
          const jobs = await dlqRes.json();
          const tbody = document.getElementById('dlqTableBody');
          const badge = document.getElementById('dlqBadge');

          if (!jobs || jobs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No jobs currently in Dead Letter Queue</td></tr>';
            badge.style.background = 'rgba(16,185,129,0.15)';
            badge.style.color = '#34d399';
            badge.style.borderColor = 'rgba(16,185,129,0.3)';
            badge.innerText = 'All Queues Clean';
          } else {
            badge.style.background = 'rgba(239,68,68,0.15)';
            badge.style.color = '#f87171';
            badge.style.borderColor = 'rgba(239,68,68,0.3)';
            badge.innerText = jobs.length + ' Jobs Require Attention';

            tbody.innerHTML = jobs.map(j => {
              const execId = j.executionId || (j.data && j.data.executionId) || 'N/A';
              const tenantId = j.tenantId || (j.data && j.data.tenantId) || 'N/A';
              const stepId = j.failedStepId || (j.data && j.data.failedStepId) || 'unknown';
              const category = j.failureCategory || (j.data && j.data.failureCategory) || 'PERMANENT';
              const httpStatus = j.httpStatus || (j.data && j.data.httpStatus);
              const statusStr = httpStatus ? ' (HTTP ' + httpStatus + ')' : '';
              const errMsg = j.finalErrorMessage || j.failedReason || (j.data && j.data.finalErrorMessage) || 'Exhausted retries';
              const retryCount = j.retryCount || (j.data && j.data.retryCount) || 1;
              const isRateLimited = j.isRateLimited || (j.data && j.data.isRateLimited);
              const rateDeferrals = j.rateLimitDeferralCount || (j.data && j.data.rateLimitDeferralCount) || 0;
              const isReplayed = j.replayed || (j.data && j.data.replayed);

              const statusBadge = isReplayed
                ? '<span class="badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;border-color:rgba(59,130,246,0.3);">Replayed</span>'
                : '<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171;border-color:rgba(239,68,68,0.3);">Dead-Lettered</span>';
              
              const rateLimitText = isRateLimited
                ? '<br/><span style="color:var(--warning);font-size:0.75rem;">Rate Limited (' + rateDeferrals + ' defers)</span>'
                : '';

              const actionBtn = isReplayed
                ? '<button class="btn btn-secondary" disabled style="opacity:0.5;cursor:not-allowed;">Replayed</button>'
                : '<button class="btn" onclick="replayDlq(\'' + j.id + '\')">Replay Job</button>';

              return '<tr>' +
                '<td><strong>' + j.id + '</strong><br/><span style="color:var(--text-muted);font-size:0.75rem;">' + execId + '</span></td>' +
                '<td>' + tenantId + '<br/><span style="color:var(--accent-cyan);font-size:0.75rem;">Step: ' + stepId + '</span></td>' +
                '<td><strong style="color:var(--danger);">' + category + '</strong>' + statusStr + '<br/><span style="color:var(--text-muted);font-size:0.75rem;">' + errMsg + '</span></td>' +
                '<td>Attempts: ' + retryCount + rateLimitText + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + actionBtn + '</td>' +
              '</tr>';
            }).join('');
          }
        }
      } catch (e) {
        addLogLine('Dashboard', 'Polled health update error: ' + e.message);
      }
    }

    async function replayDlq(jobId) {
      try {
        const res = await fetch('/api/v1/workflows/dlq/' + jobId + '/retry', { method: 'POST' });
        if (res.ok) {
          addLogLine('DLQ-Replay', 'Successfully replayed DLQ Job ' + jobId);
          fetchDashboardData();
        } else {
          alert('Failed to replay DLQ Job');
        }
      } catch (e) {
        alert('Replay error: ' + e.message);
      }
    }

    fetchDashboardData();
    setInterval(fetchDashboardData, 4000);
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  }
}
