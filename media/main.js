(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const sessionsPanelEl = document.getElementById('sessions-panel');
  const skillMenuEl = document.getElementById('skill-menu');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const saveBtn = document.getElementById('saveBtn');
  const sessionsBtn = document.getElementById('sessionsBtn');
  const logBtn = document.getElementById('logBtn');

  let allSkills = [];
  let sessionsPanelOpen = false;
  let thinkingEl = null;

  // ---------- small helpers ----------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- plain chat bubbles (user text, plain errors/warnings) ----------

  function appendMessage(label, text, cls) {
    const div = el('div', 'msg ' + (cls || ''));
    div.appendChild(el('div', 'msg-label', label));
    const body = el('div', 'msg-body');
    body.textContent = text;
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  // ---------- lightweight markdown: headings, lists, bold/inline-code, fenced code blocks ----------

  function renderInline(parent, text) {
    const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIndex = 0;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('**')) {
        parent.appendChild(el('strong', undefined, token.slice(2, -2)));
      } else {
        parent.appendChild(el('code', 'inline-code', token.slice(1, -1)));
      }
      lastIndex = tokenRegex.lastIndex;
    }
    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderMarkdownBlock(container, text) {
    const lines = text.split('\n');
    let i = 0;
    let listEl = null;
    let listType = null;
    let paraBuffer = [];

    function flushPara() {
      if (paraBuffer.length) {
        const p = el('div', 'md-para');
        renderInline(p, paraBuffer.join(' '));
        container.appendChild(p);
        paraBuffer = [];
      }
    }

    function closeList() {
      if (listEl) {
        container.appendChild(listEl);
        listEl = null;
        listType = null;
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === '') {
        flushPara();
        closeList();
        i++;
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        flushPara();
        closeList();
        const level = Math.min(headingMatch[1].length, 6);
        const h = el('div', 'md-heading md-h' + level);
        renderInline(h, headingMatch[2]);
        container.appendChild(h);
        i++;
        continue;
      }

      const numberedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
      const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);

      if (numberedMatch || bulletMatch) {
        flushPara();
        const wantType = numberedMatch ? 'ol' : 'ul';
        if (!listEl || listType !== wantType) {
          closeList();
          listEl = document.createElement(wantType);
          listEl.className = 'md-list';
          listType = wantType;
        }
        const li = document.createElement('li');
        renderInline(li, (numberedMatch || bulletMatch)[1]);
        listEl.appendChild(li);
        i++;
        continue;
      }

      closeList();
      paraBuffer.push(trimmed);
      i++;
    }

    flushPara();
    closeList();
  }

  function renderRichText(container, text) {
    const segments = text.split('```');
    segments.forEach((segment, idx) => {
      if (idx % 2 === 1) {
        const lines = segment.split('\n');
        if (lines[0] && /^[\w+-]{0,20}$/.test(lines[0].trim())) {
          lines.shift();
        }
        const code = lines.join('\n').replace(/\n$/, '');
        const pre = el('pre', 'code-block');
        pre.appendChild(el('code', undefined, code));
        container.appendChild(pre);
      } else if (segment.trim()) {
        const wrap = el('div', 'prose');
        renderMarkdownBlock(wrap, segment.replace(/^\n+|\n+$/g, ''));
        container.appendChild(wrap);
      }
    });
  }

  function appendAssistantText(text) {
    const div = el('div', 'msg assistant');
    div.appendChild(el('div', 'msg-label', 'Assistant'));
    const body = el('div', 'msg-body rich');
    renderRichText(body, text);
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  // ---------- Claude-Code-style tool call lines ----------

  function primaryArg(toolName, args) {
    args = args || {};
    switch (toolName) {
      case 'list_files':
        return args.path || '.';
      case 'read_file':
      case 'write_file':
      case 'replace_in_file':
      case 'delete_file':
        return args.path || '';
      case 'execute_command': {
        const c = args.command || '';
        return c.length > 70 ? c.slice(0, 67) + '...' : c;
      }
      default:
        try {
          return JSON.stringify(args);
        } catch {
          return '';
        }
    }
  }

  function toolVerb(toolName) {
    const verbs = {
      list_files: 'List',
      read_file: 'Read',
      write_file: 'Write',
      replace_in_file: 'Edit',
      delete_file: 'Delete',
      execute_command: 'Run',
    };
    return verbs[toolName] || toolName;
  }

  function prettyToolName(name) {
    if (name && name.indexOf('mcp__') === 0) {
      const parts = name.split('__');
      if (parts.length >= 3) return parts[1] + ': ' + parts.slice(2).join('__');
    }
    return name;
  }

  function appendToolStart(toolName, args) {
    if (toolName === 'update_plan') return; // the plan card below already shows this
    const div = el('div', 'tool-line');
    div.appendChild(el('span', 'tool-bullet', '●'));
    const label = toolName && toolName.indexOf('mcp__') === 0 ? prettyToolName(toolName) : toolVerb(toolName);
    div.appendChild(el('span', 'tool-text', ' ' + label + '(' + primaryArg(toolName, args) + ')'));
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendToolResult(ok, toolName, output) {
    if (toolName === 'update_plan') return; // the plan card already shows this
    output = output || '';
    const div = el('div', 'tool-result-line ' + (ok ? 'ok' : 'err'));
    div.appendChild(el('span', 'tool-result-prefix', '⎿'));

    const lines = output.split('\n');
    const isLong = lines.length > 6 || output.length > 500;
    const preview = isLong ? lines.slice(0, 6).join('\n') + '\n…' : output;

    const textSpan = el('span', 'tool-result-text', preview);
    div.appendChild(textSpan);

    if (isLong) {
      let expanded = false;
      const toggle = el('button', 'tool-result-toggle', 'Show more');
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        textSpan.textContent = expanded ? output : preview;
        toggle.textContent = expanded ? 'Show less' : 'Show more';
      });
      div.appendChild(toggle);
    }

    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendToolDenied(toolName) {
    const div = el('div', 'tool-line denied');
    div.appendChild(el('span', 'tool-bullet', '✕'));
    div.appendChild(el('span', 'tool-text', ' ' + toolName + ' — denied by user'));
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  // ---------- plan tracker (Plan -> Edit -> Run -> Validate -> Iterate) ----------

  function appendPlanUpdate(steps) {
    const div = el('div', 'plan-card');
    div.appendChild(el('div', 'plan-card-title', 'Plan'));
    const list = el('div', 'plan-list');
    for (const s of steps || []) {
      const row = el('div', 'plan-item plan-' + s.status);
      const box = s.status === 'done' ? '☑' : s.status === 'in_progress' ? '◐' : '☐';
      row.appendChild(el('span', 'plan-checkbox', box));
      row.appendChild(el('span', 'plan-text', s.text));
      list.appendChild(row);
    }
    div.appendChild(list);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  // ---------- working / progress indicator ----------

  function showThinkingIndicator() {
    if (thinkingEl) return;
    thinkingEl = el('div', 'thinking-indicator');
    thinkingEl.appendChild(el('span', 'thinking-label', 'Working'));
    const dots = el('span', 'thinking-dots');
    dots.appendChild(el('span', 'dot'));
    dots.appendChild(el('span', 'dot'));
    dots.appendChild(el('span', 'dot'));
    thinkingEl.appendChild(dots);
    messagesEl.appendChild(thinkingEl);
    scrollToBottom();
  }

  function hideThinkingIndicator() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function appendTaskComplete(text) {
    const div = el('div', 'task-complete');
    const header = el('div', 'task-complete-header');
    header.appendChild(el('span', undefined, '✓'));
    header.appendChild(el('span', undefined, 'Task Completed'));
    div.appendChild(header);
    const body = el('div', 'task-complete-body');
    renderRichText(body, text);
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function handleAgentEvent(event) {
    switch (event.type) {
      case 'assistant_text':
        appendAssistantText(event.text);
        break;
      case 'task_complete':
        appendTaskComplete(event.text);
        break;
      case 'plan_update':
        appendPlanUpdate(event.steps);
        break;
      case 'tool_start':
        appendToolStart(event.toolName, event.args);
        break;
      case 'tool_result':
        appendToolResult(event.ok, event.toolName, event.output);
        break;
      case 'tool_denied':
        appendToolDenied(event.toolName);
        break;
      case 'step_limit':
        appendMessage('Paused', event.message, 'warning');
        break;
      case 'error':
        appendMessage('Error', event.message, 'error');
        break;
    }
  }

  // ---------- sending ----------

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    hideSkillMenu();
    vscode.postMessage({ type: 'userMessage', text });
  }

  sendBtn.addEventListener('click', send);
  newChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'saveSession' }));
  logBtn.addEventListener('click', () => vscode.postMessage({ type: 'showLog' }));
  sessionsBtn.addEventListener('click', () => {
    sessionsPanelOpen = !sessionsPanelOpen;
    if (sessionsPanelOpen) {
      vscode.postMessage({ type: 'listSessions' });
    }
    sessionsPanelEl.classList.toggle('hidden', !sessionsPanelOpen);
  });

  // ---------- approvals (plain, or pointing at the diff tab that opened) ----------

  function showApproval(id, toolName, args, diff, networkWarning) {
    const box = el('div', 'approval-box' + (networkWarning ? ' network-warning' : ''));

    if (networkWarning) {
      box.appendChild(
        el(
          'div',
          'network-warning-banner',
          '⚠ This command appears to reach the network. This extension is meant to have no internet access beyond ' +
            'the configured model API — only approve this if you specifically intend it.'
        )
      );
    }

    if (diff) {
      box.appendChild(
        el(
          'div',
          'approval-desc',
          toolVerb(toolName) + '(' + diff.path + ') — review the diff tab that opened in the editor, then decide below.'
        )
      );
    } else {
      box.appendChild(el('div', 'approval-desc', 'Allow "' + toolName + '" with args: ' + JSON.stringify(args)));
    }

    const btnRow = el('div', 'approval-buttons');

    const approveBtn = el('button', 'approve', 'Approve');
    approveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', id, approved: true });
      box.remove();
    });

    const denyBtn = el('button', 'deny', 'Deny');
    denyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', id, approved: false });
      box.remove();
    });

    btnRow.appendChild(approveBtn);
    btnRow.appendChild(denyBtn);
    box.appendChild(btnRow);
    messagesEl.appendChild(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- sessions panel ----------

  function renderSessions(sessions, currentSessionId) {
    sessionsPanelEl.innerHTML = '';

    if (!sessions.length) {
      sessionsPanelEl.appendChild(el('div', 'sessions-empty', 'No saved sessions yet.'));
      return;
    }

    for (const s of sessions) {
      const row = el('div', 'session-row' + (s.id === currentSessionId ? ' active' : ''));

      const info = el('div', 'session-info');
      info.appendChild(el('div', 'session-title', s.title));
      info.appendChild(el('div', 'session-date', new Date(s.updatedAt).toLocaleString()));

      const actions = el('div', 'session-actions');

      const openBtn = el('button', undefined, 'Open');
      openBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'loadSession', id: s.id });
        sessionsPanelOpen = false;
        sessionsPanelEl.classList.add('hidden');
      });

      const delBtn = el('button', 'deny', 'Delete');
      delBtn.addEventListener('click', () => {
        if (delBtn.dataset.confirm === '1') {
          vscode.postMessage({ type: 'deleteSession', id: s.id });
        } else {
          delBtn.dataset.confirm = '1';
          delBtn.textContent = 'Confirm?';
          setTimeout(() => {
            delBtn.dataset.confirm = '0';
            delBtn.textContent = 'Delete';
          }, 3000);
        }
      });

      actions.appendChild(openBtn);
      actions.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(actions);
      sessionsPanelEl.appendChild(row);
    }
  }

  // ---------- "/" skill menu ----------

  function hideSkillMenu() {
    skillMenuEl.classList.add('hidden');
    skillMenuEl.innerHTML = '';
  }

  function showSkillMenu(prefix) {
    const filtered = allSkills.filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!filtered.length) {
      hideSkillMenu();
      return;
    }
    skillMenuEl.innerHTML = '';
    for (const name of filtered) {
      const item = el('div', 'skill-item', '/' + name);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inputEl.value = '/' + name + ' ';
        hideSkillMenu();
        inputEl.focus();
      });
      skillMenuEl.appendChild(item);
    }
    skillMenuEl.classList.remove('hidden');
  }

  inputEl.addEventListener('input', () => {
    const match = inputEl.value.match(/^\/(\S*)$/);
    if (match) {
      showSkillMenu(match[1]);
    } else {
      hideSkillMenu();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      hideSkillMenu();
    }
  });

  // ---------- messages from extension ----------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'userEcho':
        appendMessage('You', msg.text, 'user');
        break;
      case 'thinking':
        sendBtn.disabled = !!msg.value;
        inputEl.disabled = !!msg.value;
        sendBtn.textContent = msg.value ? 'Working...' : 'Send';
        if (msg.value) {
          showThinkingIndicator();
        } else {
          hideThinkingIndicator();
        }
        break;
      case 'reset':
        messagesEl.innerHTML = '';
        thinkingEl = null;
        break;
      case 'error':
        appendMessage('Error', msg.message, 'error');
        break;
      case 'agentEvent':
        handleAgentEvent(msg.event);
        break;
      case 'approvalRequest':
        showApproval(msg.id, msg.toolName, msg.args, msg.diff, msg.networkWarning);
        break;
      case 'skillList':
        allSkills = msg.skills || [];
        break;
      case 'sessionList':
        renderSessions(msg.sessions || [], msg.currentSessionId);
        break;
      case 'sessionSaved':
        appendMessage('Saved', 'Session saved as "' + msg.session.title + '"', 'tool-ok');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
