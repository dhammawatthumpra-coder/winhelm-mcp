/**
 * WinHelm v1.4.1 Product Shell — Design Tokens & CSS Stylesheet
 * 
 * Calm, authoritative, Windows-compatible design system.
 * Zero external runtime dependencies.
 */

export function getDesignTokensCss(): string {
  return `
    :root {
      /* Spacing Scale (8-point harmonic) */
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-10: 40px;

      /* Typography Scale */
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "Segoe UI Mono", Menlo, Consolas, monospace;
      --text-xs: 11px;
      --text-sm: 13px;
      --text-base: 14px;
      --text-md: 16px;
      --text-lg: 18px;
      --text-xl: 22px;

      /* Borders & Radius */
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-full: 9999px;

      --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Dark Theme (Default) */
    [data-theme="dark"], :root {
      --bg-canvas: #0f141c;
      --bg-surface: #161d2a;
      --bg-surface-elevated: #1e2638;
      --bg-subtle: #232d42;

      --border-subtle: #28334a;
      --border-strong: #3b4968;

      --text-primary: #f0f4fc;
      --text-secondary: #9db0ce;
      --text-muted: #6b7d9b;

      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.5);
      --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.65);

      /* Semantic Status Tokens */
      --status-ready-bg: rgba(34, 197, 94, 0.12);
      --status-ready-text: #4ade80;
      --status-ready-border: rgba(34, 197, 94, 0.35);

      --status-attention-bg: rgba(234, 179, 8, 0.12);
      --status-attention-text: #facc15;
      --status-attention-border: rgba(234, 179, 8, 0.35);

      --status-offline-bg: rgba(239, 68, 68, 0.12);
      --status-offline-text: #f87171;
      --status-offline-border: rgba(239, 68, 68, 0.35);

      --status-info-bg: rgba(59, 130, 246, 0.12);
      --status-info-text: #60a5fa;
      --status-info-border: rgba(59, 130, 246, 0.35);

      --status-neutral-bg: rgba(148, 163, 184, 0.12);
      --status-neutral-text: #cbd5e1;
      --status-neutral-border: rgba(148, 163, 184, 0.3);

      --accent-primary: #3b82f6;
      --accent-primary-hover: #2563eb;
      --accent-primary-text: #ffffff;

      --code-bg: #090d14;
    }

    /* Light Theme */
    [data-theme="light"] {
      --bg-canvas: #f4f6fa;
      --bg-surface: #ffffff;
      --bg-surface-elevated: #ffffff;
      --bg-subtle: #f1f4f9;

      --border-subtle: #e2e8f0;
      --border-strong: #cbd5e1;

      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #94a3b8;

      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
      --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.12);

      --status-ready-bg: #ecfdf5;
      --status-ready-text: #15803d;
      --status-ready-border: #86efac;

      --status-attention-bg: #fefce8;
      --status-attention-text: #a16207;
      --status-attention-border: #fde047;

      --status-offline-bg: #fef2f2;
      --status-offline-text: #b91c1c;
      --status-offline-border: #fca5a5;

      --status-info-bg: #eff6ff;
      --status-info-text: #1d4ed8;
      --status-info-border: #93c5fd;

      --status-neutral-bg: #f8fafc;
      --status-neutral-text: #475569;
      --status-neutral-border: #cbd5e1;

      --accent-primary: #2563eb;
      --accent-primary-hover: #1d4ed8;
      --accent-primary-text: #ffffff;

      --code-bg: #f8fafc;
    }

    /* Global Reset & Base */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-sans);
      font-size: var(--text-base);
      line-height: 1.5;
      color: var(--text-primary);
      background-color: var(--bg-canvas);
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    button, input, select, textarea {
      font: inherit;
      color: inherit;
    }

    a {
      color: var(--accent-primary);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }

    /* Accessible Visible Focus */
    :focus-visible {
      outline: 2px solid var(--accent-primary);
      outline-offset: 2px;
    }

    /* Layout Structure */
    .app-header {
      height: 56px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 var(--space-4);
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .brand-logo {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-weight: 700;
      font-size: var(--text-md);
      color: var(--text-primary);
    }

    .brand-icon {
      width: 24px;
      height: 24px;
      border-radius: var(--radius-sm);
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-size: 13px;
      font-weight: 800;
    }

    .brand-badge {
      font-size: var(--text-xs);
      color: var(--text-muted);
      font-weight: 600;
      background: var(--bg-subtle);
      padding: 2px 6px;
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .admin-pill {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 4px 12px;
      border-radius: var(--radius-full);
      border: 1px solid var(--border-strong);
      background: var(--bg-surface-elevated);
      font-size: var(--text-xs);
      font-weight: 600;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .admin-pill:hover {
      background: var(--bg-subtle);
    }
    .admin-pill.unlocked {
      border-color: var(--status-ready-border);
      color: var(--status-ready-text);
      background: var(--status-ready-bg);
    }

    .icon-btn {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .icon-btn:hover {
      background: var(--bg-subtle);
      color: var(--text-primary);
    }

    /* App Shell Body */
    .app-body {
      display: flex;
      flex: 1;
    }

    .sidebar {
      width: 230px;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      padding: var(--space-4) var(--space-2);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .nav-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: var(--text-sm);
      font-weight: 500;
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: all var(--transition-fast);
    }
    .nav-item:hover {
      background: var(--bg-subtle);
      color: var(--text-primary);
    }
    .nav-item.active {
      background: var(--accent-primary);
      color: var(--accent-primary-text);
      font-weight: 600;
    }
    .nav-item.active .nav-badge {
      background: rgba(255, 255, 255, 0.3);
      color: #ffffff;
    }

    .nav-item-left {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .nav-badge {
      background: var(--status-attention-bg);
      color: var(--status-attention-text);
      border: 1px solid var(--status-attention-border);
      padding: 1px 6px;
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 700;
    }

    .sidebar-footer {
      border-top: 1px solid var(--border-subtle);
      padding-top: var(--space-3);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .sidebar-external-link {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: var(--text-xs);
      color: var(--text-muted);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
    }
    .sidebar-external-link:hover {
      color: var(--text-primary);
      background: var(--bg-subtle);
    }

    /* Main Content */
    .main-content {
      flex: 1;
      padding: var(--space-6);
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
    }

    .panel {
      display: none;
    }
    .panel.active {
      display: block;
    }

    .panel-header {
      margin-bottom: var(--space-5);
    }

    .panel-title {
      font-size: var(--text-xl);
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: var(--space-1);
    }

    .panel-desc {
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    /* Banners */
    .banner {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-5);
      font-size: var(--text-sm);
      border: 1px solid transparent;
      gap: var(--space-3);
    }

    .banner-warning {
      background: var(--status-attention-bg);
      color: var(--status-attention-text);
      border-color: var(--status-attention-border);
    }

    .banner-danger {
      background: var(--status-offline-bg);
      color: var(--status-offline-text);
      border-color: var(--status-offline-border);
    }

    .banner-info {
      background: var(--status-info-bg);
      color: var(--status-info-text);
      border-color: var(--status-info-border);
    }

    .banner-content {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .banner-btn {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      padding: 4px 12px;
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .banner-btn:hover {
      background: var(--bg-subtle);
    }

    /* Cards & Grids */
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }

    .card-grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: var(--space-4);
      margin-bottom: var(--space-6);
    }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-3);
    }

    .card-label {
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .card-value {
      font-size: var(--text-lg);
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: var(--space-2);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .card-sub {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      margin-bottom: var(--space-3);
      flex: 1;
    }

    .card-action-link {
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--accent-primary);
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
    }

    /* Status Dot & Pills */
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: var(--radius-full);
      display: inline-block;
    }
    .status-dot.green { background: #22c55e; }
    .status-dot.yellow { background: #eab308; }
    .status-dot.red { background: #ef4444; }
    .status-dot.gray { background: #94a3b8; }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 600;
      border: 1px solid transparent;
    }

    .status-ready {
      background: var(--status-ready-bg);
      color: var(--status-ready-text);
      border-color: var(--status-ready-border);
    }

    .status-attention {
      background: var(--status-attention-bg);
      color: var(--status-attention-text);
      border-color: var(--status-attention-border);
    }

    .status-offline {
      background: var(--status-offline-bg);
      color: var(--status-offline-text);
      border-color: var(--status-offline-border);
    }

    .status-neutral {
      background: var(--status-neutral-bg);
      color: var(--status-neutral-text);
      border-color: var(--status-neutral-border);
    }

    /* Approvals Card */
    .approval-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      margin-bottom: var(--space-4);
      box-shadow: var(--shadow-md);
    }
    .approval-card.high-risk {
      border-left: 4px solid var(--status-attention-text);
    }

    .approval-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-3);
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .approval-meta-left {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .risk-tag {
      font-size: var(--text-xs);
      font-weight: 700;
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      text-transform: uppercase;
    }
    .risk-tag.high {
      background: var(--status-attention-bg);
      color: var(--status-attention-text);
      border: 1px solid var(--status-attention-border);
    }
    .risk-tag.medium {
      background: var(--status-info-bg);
      color: var(--status-info-text);
      border: 1px solid var(--status-info-border);
    }
    .risk-tag.low {
      background: var(--status-ready-bg);
      color: var(--status-ready-text);
      border: 1px solid var(--status-ready-border);
    }

    .approval-details-grid {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: var(--space-2) var(--space-4);
      font-size: var(--text-sm);
      margin-bottom: var(--space-4);
    }

    .detail-label {
      color: var(--text-muted);
      font-weight: 500;
    }

    .detail-value {
      color: var(--text-primary);
      word-break: break-all;
    }
    .detail-value code {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
    }

    .mandatory-confirm-box {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--status-attention-border);
      padding: var(--space-3);
      border-radius: var(--radius-md);
      margin-bottom: var(--space-4);
      font-size: var(--text-xs);
    }
    .mandatory-confirm-box label {
      display: block;
      font-weight: 600;
      color: var(--status-attention-text);
      margin-bottom: var(--space-2);
    }
    .mandatory-confirm-input {
      width: 100%;
      max-width: 280px;
      padding: 6px 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
    }

    .approval-actions {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }

    .btn-approve {
      background: #16a34a;
      color: #ffffff;
      border: none;
      padding: 8px 18px;
      border-radius: var(--radius-md);
      font-weight: 600;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .btn-approve:hover {
      background: #15803d;
    }

    .btn-deny {
      background: #dc2626;
      color: #ffffff;
      border: none;
      padding: 8px 18px;
      border-radius: var(--radius-md);
      font-weight: 600;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .btn-deny:hover {
      background: #b91c1c;
    }

    .btn-secondary {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: var(--radius-md);
      font-weight: 500;
      cursor: pointer;
    }
    .btn-secondary:hover {
      background: var(--bg-subtle);
      color: var(--text-primary);
    }

    .btn-primary {
      background: var(--accent-primary);
      border: 1px solid transparent;
      color: var(--accent-primary-text);
      padding: 6px 14px;
      border-radius: var(--radius-md);
      font-weight: 600;
      cursor: pointer;
    }
    .btn-primary:hover {
      background: var(--accent-primary-hover);
    }

    /* Policy Axis Selector */
    .policy-group-title {
      font-size: var(--text-sm);
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: var(--space-2);
    }

    .policy-axis-card {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      margin-bottom: var(--space-2);
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .policy-axis-card:hover {
      background: var(--bg-subtle);
    }
    .policy-axis-card.selected {
      border-color: var(--accent-primary);
      background: var(--bg-surface-elevated);
    }

    .policy-radio {
      margin-top: 3px;
    }

    .policy-axis-text strong {
      display: block;
      font-size: var(--text-sm);
      color: var(--text-primary);
      margin-bottom: 2px;
    }
    .policy-axis-text span {
      font-size: var(--text-xs);
      color: var(--text-secondary);
    }

    /* Activity Timeline */
    .filter-pills-bar {
      display: flex;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
      flex-wrap: wrap;
    }

    .filter-pill {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      padding: 4px 12px;
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .filter-pill:hover, .filter-pill.active {
      background: var(--accent-primary);
      color: var(--accent-primary-text);
      border-color: var(--accent-primary);
    }

    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .timeline-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .timeline-item-left {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .timeline-time {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .timeline-badge {
      font-size: var(--text-xs);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      background: var(--bg-subtle);
      color: var(--text-secondary);
      font-weight: 600;
    }

    /* Tables */
    .data-table-container {
      overflow-x: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--text-sm);
      text-align: left;
    }

    .data-table th {
      background: var(--bg-subtle);
      padding: var(--space-3);
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      border-bottom: 1px solid var(--border-subtle);
    }

    .data-table td {
      padding: var(--space-3);
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-primary);
    }

    .data-table tr:last-child td {
      border-bottom: none;
    }

    /* Form Fields */
    input[type="text"], input[type="password"], select, textarea {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 6px 10px;
      font-size: var(--text-sm);
    }

    /* Modals with Dialog Semantics */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(2px);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: var(--space-4);
    }
    .modal-overlay.open {
      display: flex;
    }

    .modal-dialog {
      background: var(--bg-surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      max-width: 520px;
      width: 100%;
      box-shadow: var(--shadow-lg);
      overflow: hidden;
    }

    .modal-header {
      padding: var(--space-4);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title {
      font-size: var(--text-md);
      font-weight: 700;
    }

    .modal-body {
      padding: var(--space-5);
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    .modal-footer {
      padding: var(--space-3) var(--space-4);
      background: var(--bg-subtle);
      border-top: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
    }

    /* Responsive */
    @media (max-width: 900px) {
      .sidebar {
        width: 72px;
        padding: var(--space-3) var(--space-2);
      }
      .nav-item-left span:last-child {
        display: none;
      }
      .sidebar-footer span {
        display: none;
      }
      .card-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 640px) {
      .mobile-menu-btn {
        display: block;
      }
      .sidebar {
        display: none;
        position: fixed;
        top: 56px;
        left: 0;
        bottom: 0;
        width: 240px;
        z-index: 99;
        box-shadow: var(--shadow-lg);
      }
      .sidebar.mobile-open {
        display: flex;
      }
      .sidebar .nav-item-left span:last-child {
        display: inline;
      }
      .card-grid, .card-grid-2 {
        grid-template-columns: 1fr;
      }
      .approval-actions {
        flex-direction: column;
        width: 100%;
      }
      .btn-approve, .btn-deny, .btn-secondary {
        width: 100%;
        text-align: center;
      }
    }
  `;
}
