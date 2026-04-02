// ── State ──────────────────────────────────────────────

const state = {
  messages: [],       // { role, content } history sent to API
  attachments: [],    // { name, path, content }
  sending: false,
  currentChatId: null,  // ID of the active chat
  displayMessages: [],  // { role, content, thinking?, attachmentInfo? } for re-rendering
};

// ── DOM refs ──────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const loginOverlay = $('#login-overlay');
const settingsOverlay = $('#settings-overlay');
const appEl = $('#app');
const messagesEl = $('#messages');
const chatInput = $('#chat-input');
const btnSend = $('#btn-send');
const btnAttach = $('#btn-attach');
const btnLogin = $('#btn-login');
const btnLogout = $('#btn-logout');
const btnSettings = $('#btn-settings');
const btnSettingsSave = $('#btn-settings-save');
const btnSettingsCancel = $('#btn-settings-cancel');
const loginError = $('#login-error');
const tokenInput = $('#token-input');
const userInfoEl = $('#user-info');
const mcpBadge = $('#mcp-badge');
const mcpPanel = $('#mcp-panel');
const mcpPanelBody = $('#mcp-panel-body');
const btnCloseMcp = $('#btn-close-mcp');
const btnMcpReconnect = $('#btn-mcp-reconnect');
const attachmentsBar = $('#attachments-bar');
const attachmentsList = $('#attachments-list');
const settingsModel = $('#settings-model');
const settingsModelText = $('#settings-model-text');
const settingsEndpoint = $('#settings-endpoint');
const settingsMode = $('#settings-mode');
const settingsCustomKey = $('#settings-custom-key');
const customApiKeyGroup = $('#custom-api-key-group');
const customApikeyFields = $('#custom-apikey-fields');
const customEntraFields = $('#custom-entra-fields');
const settingsEntraTenant = $('#settings-entra-tenant');
const settingsMcp = $('#settings-mcp');
const mcpJsonError = $('#mcp-json-error');
const jsonHighlight = $('#json-highlight');
const btnGithubLogin = $('#btn-github-login');
const loginStepStart = $('#login-step-start');
const loginStepCode = $('#login-step-code');
const deviceCodeEl = $('#device-code');
const btnCancelDevice = $('#btn-cancel-device');
const btnHistory = $('#btn-history');
const btnNewChat = $('#btn-new-chat');
const historySidebar = $('#history-sidebar');
const historyList = $('#history-list');
const btnCloseHistory = $('#btn-close-history');
const btnCustomLlm = $('#btn-custom-llm');

// ── Init ──────────────────────────────────────────────

// JSON syntax highlighting
function highlightJson(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(
    /("(?:[^"\\]|\\.)*")(\s*:)|"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],])/g,
    (match, key, colon, num, bool, nul, brace) => {
      if (key) return `<span class="json-key">${key}</span>${colon}`;
      if (num !== undefined && num !== '') return `<span class="json-number">${match}</span>`;
      if (bool) return `<span class="json-bool">${match}</span>`;
      if (nul) return `<span class="json-null">${match}</span>`;
      if (brace) return `<span class="json-brace">${match}</span>`;
      return `<span class="json-string">${match}</span>`;
    }
  );
}

function updateJsonHighlight() {
  const text = settingsMcp.value;
  jsonHighlight.innerHTML = highlightJson(text) + '\n';
  // Live validation
  try {
    JSON.parse(text);
    mcpJsonError.hidden = true;
  } catch {
    if (text.trim().length > 0) {
      mcpJsonError.hidden = false;
    } else {
      mcpJsonError.hidden = true;
    }
  }
}

settingsMcp.addEventListener('input', updateJsonHighlight);
settingsMcp.addEventListener('scroll', () => {
  jsonHighlight.scrollTop = settingsMcp.scrollTop;
  jsonHighlight.scrollLeft = settingsMcp.scrollLeft;
});

(async function init() {
  const authStatus = await window.api.auth.getStatus();
  const mode = await window.api.settings.getMode();
  if (authStatus.loggedIn) {
    showApp(authStatus.user, authStatus.copilotAccess);
  } else if (mode === 'custom') {
    showApp(null, false);
  } else {
    loginOverlay.hidden = false;
    appEl.hidden = true;
  }
})();

// ── Auth ──────────────────────────────────────────────

// GitHub OAuth Device Flow (primary)
btnGithubLogin.addEventListener('click', async () => {
  btnGithubLogin.disabled = true;
  loginError.hidden = true;

  try {
    const flow = await window.api.auth.startDeviceFlow();
    deviceCodeEl.textContent = flow.user_code;
    loginStepStart.hidden = true;
    loginStepCode.hidden = false;

    // Open verification URL in browser
    window.api.shell.openExternal(flow.verification_uri);

    // Poll in background
    const result = await window.api.auth.pollDeviceFlow(flow.device_code, flow.interval);
    if (result.error) {
      throw new Error(result.error);
    }
    if (result.copilotAccess) {
      await window.api.settings.setMode('copilot');
    } else {
      await window.api.settings.setMode('models');
    }
    showApp(result.user, result.copilotAccess);
  } catch (err) {
    loginError.textContent = err.message || 'Login failed.';
    loginError.hidden = false;
    loginStepStart.hidden = false;
    loginStepCode.hidden = true;
    btnGithubLogin.disabled = false;
  }
});

btnCancelDevice.addEventListener('click', async () => {
  await window.api.auth.cancelDeviceFlow();
  loginStepStart.hidden = false;
  loginStepCode.hidden = true;
  btnGithubLogin.disabled = false;
});

// PAT fallback (for GitHub Models free tier)
btnLogin.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;

  btnLogin.disabled = true;
  btnLogin.textContent = 'Signing in...';
  loginError.hidden = true;

  const result = await window.api.auth.login(token);
  if (result.error) {
    loginError.textContent = result.error;
    loginError.hidden = false;
    btnLogin.disabled = false;
    btnLogin.textContent = 'Sign In with Token';
  } else {
    await window.api.settings.setMode(result.copilotAccess ? 'copilot' : 'models');
    showApp(result.user, result.copilotAccess);
  }
});

tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnLogin.click();
});

btnLogout.addEventListener('click', async () => {
  await window.api.auth.logout();
  // If in custom mode, reset to copilot so next launch shows login
  const mode = await window.api.settings.getMode();
  if (mode === 'custom') {
    await window.api.settings.setMode('copilot');
  }
  state.messages = [];
  state.attachments = [];
  state.displayMessages = [];
  state.currentChatId = null;
  state.currentChatCreatedAt = undefined;
  messagesEl.innerHTML = '';
  historySidebar.hidden = true;
  loginOverlay.hidden = false;
  appEl.hidden = true;
  tokenInput.value = '';
  loginStepStart.hidden = false;
  loginStepCode.hidden = true;
  btnGithubLogin.disabled = false;
  btnLogin.disabled = false;
  btnLogin.textContent = 'Sign In with Token';
});

function showApp(user, copilotAccess) {
  loginOverlay.hidden = true;
  appEl.hidden = false;
  if (user) {
    userInfoEl.textContent = (user.login || '') + (copilotAccess ? ' ✦ Copilot' : '');
  } else {
    userInfoEl.textContent = 'Custom LLM';
  }
  chatInput.focus();
}

// Custom LLM shortcut from login screen
btnCustomLlm.addEventListener('click', async (e) => {
  e.preventDefault();
  await window.api.settings.setMode('custom');
  showApp(null, false);
});

// ── Settings ──────────────────────────────────────────

btnSettings.addEventListener('click', async () => {
  const model = await window.api.settings.getModel();
  const endpoint = await window.api.settings.getEndpoint();
  const mode = await window.api.settings.getMode();
  const mcpConfig = await window.api.mcp.getConfig();
  const customKey = await window.api.settings.getCustomApiKey();
  const authType = await window.api.settings.getCustomAuthType();
  const tenantId = await window.api.settings.getEntraTenantId();
  settingsMode.value = mode;
  await filterModelsByMode(mode);
  if (mode === 'custom') {
    settingsModelText.value = model;
    settingsCustomKey.value = customKey || '';
    settingsEntraTenant.value = tenantId || '';
    const authRadio = document.querySelector(`input[name="custom-auth-type"][value="${authType}"]`);
    if (authRadio) authRadio.checked = true;
    toggleCustomAuthFields(authType);
  } else {
    settingsModel.value = model;
  }
  settingsEndpoint.value = endpoint;
  settingsMcp.value = JSON.stringify(mcpConfig, null, 2);
  mcpJsonError.hidden = true;
  updateJsonHighlight();
  settingsOverlay.hidden = false;
});

settingsMode.addEventListener('change', () => {
  const mode = settingsMode.value;
  filterModelsByMode(mode);
  if (mode === 'custom') {
    settingsEndpoint.placeholder = 'http://localhost:11434/v1/chat/completions';
  } else if (mode === 'models') {
    settingsEndpoint.placeholder = 'https://models.github.ai/inference/chat/completions';
  } else {
    settingsEndpoint.placeholder = 'https://api.githubcopilot.com/chat/completions';
  }
});

async function filterModelsByMode(mode) {
  // Show/hide custom-specific fields
  const isCustom = mode === 'custom';
  customApiKeyGroup.hidden = !isCustom;
  settingsModelText.hidden = !isCustom;
  settingsModel.hidden = isCustom;

  if (isCustom) {
    const authType = document.querySelector('input[name="custom-auth-type"]:checked')?.value || 'apikey';
    toggleCustomAuthFields(authType);
    return;
  }

  // Remove old dynamic copilot groups
  for (const g of settingsModel.querySelectorAll('optgroup[data-mode="copilot"]')) {
    g.remove();
  }

  if (mode === 'copilot') {
    // Fetch available models from Copilot API
    const models = await window.api.settings.getCopilotModels();
    if (models.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'GitHub Copilot';
      group.dataset.mode = 'copilot';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        group.appendChild(opt);
      }
      settingsModel.prepend(group);
    } else {
      // Fallback if API fails
      const group = document.createElement('optgroup');
      group.label = 'GitHub Copilot';
      group.dataset.mode = 'copilot';
      for (const [id, name] of [['gpt-4o', 'GPT-4o'], ['gpt-4o-mini', 'GPT-4o Mini'], ['o3-mini', 'o3-mini']]) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        group.appendChild(opt);
      }
      settingsModel.prepend(group);
    }
  }

  for (const group of settingsModel.querySelectorAll('optgroup')) {
    const groupMode = group.dataset.mode;
    if (groupMode) {
      group.hidden = groupMode !== mode;
      for (const opt of group.querySelectorAll('option')) {
        opt.hidden = groupMode !== mode;
      }
    }
  }
  // Select first visible option if current is hidden
  if (settingsModel.selectedOptions[0]?.hidden) {
    const firstVisible = settingsModel.querySelector('option:not([hidden])');
    if (firstVisible) settingsModel.value = firstVisible.value;
  }
}

function toggleCustomAuthFields(authType) {
  customApikeyFields.hidden = authType !== 'apikey';
  customEntraFields.hidden = authType !== 'entra';
}

// Auth type radio toggle
document.querySelectorAll('input[name="custom-auth-type"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    toggleCustomAuthFields(e.target.value);
  });
});

btnSettingsSave.addEventListener('click', async () => {
  // Validate MCP JSON before saving anything
  let mcpConfig;
  try {
    mcpConfig = JSON.parse(settingsMcp.value);
    mcpJsonError.hidden = true;
  } catch {
    mcpJsonError.hidden = false;
    return;
  }

  const newMode = settingsMode.value;
  const currentMode = await window.api.settings.getMode();
  if (newMode !== currentMode) {
    const result = await window.api.settings.setMode(newMode);
    if (newMode !== 'custom') {
      settingsModel.value = result.model;
    }
    settingsEndpoint.value = result.endpoint;
  }

  if (newMode === 'custom') {
    const customModel = settingsModelText.value.trim();
    if (customModel) await window.api.settings.setModel(customModel);
    const authType = document.querySelector('input[name="custom-auth-type"]:checked')?.value || 'apikey';
    await window.api.settings.setCustomAuthType(authType);
    if (authType === 'apikey') {
      await window.api.settings.setCustomApiKey(settingsCustomKey.value.trim());
    } else {
      await window.api.settings.setEntraTenantId(settingsEntraTenant.value.trim());
    }
  } else {
    await window.api.settings.setModel(settingsModel.value);
  }
  const endpoint = settingsEndpoint.value.trim();
  if (endpoint) await window.api.settings.setEndpoint(endpoint);

  // Save MCP config and reconnect servers
  await window.api.mcp.saveConfig(mcpConfig);

  settingsOverlay.hidden = true;
});

btnSettingsCancel.addEventListener('click', () => {
  settingsOverlay.hidden = true;
});

// ── MCP panel ─────────────────────────────────────────

mcpBadge.addEventListener('click', () => {
  mcpPanel.hidden = !mcpPanel.hidden;
});

btnCloseMcp.addEventListener('click', () => {
  mcpPanel.hidden = true;
});

// Close panels when clicking outside
document.addEventListener('click', (e) => {
  if (!mcpPanel.hidden && !mcpPanel.contains(e.target) && !mcpBadge.contains(e.target)) {
    mcpPanel.hidden = true;
  }
  if (!historySidebar.hidden && !historySidebar.contains(e.target) && !btnHistory.contains(e.target)) {
    historySidebar.hidden = true;
  }
  if (!settingsOverlay.hidden && e.target === settingsOverlay) {
    settingsOverlay.hidden = true;
  }
});

btnMcpReconnect.addEventListener('click', async () => {
  btnMcpReconnect.disabled = true;
  btnMcpReconnect.textContent = 'Reconnecting...';
  const status = await window.api.mcp.reconnect();
  updateMcpStatus(status);
  btnMcpReconnect.disabled = false;
  btnMcpReconnect.textContent = 'Reconnect All';
});

function updateMcpStatus(status) {
  const names = Object.keys(status || {});
  const connectedCount = names.filter((n) => status[n].status === 'connected').length;
  const enabledCount = names.filter((n) => !status[n].disabled).length;

  mcpBadge.textContent = `MCP: ${connectedCount}/${enabledCount}`;
  mcpBadge.classList.toggle('connected', connectedCount > 0);

  mcpPanelBody.innerHTML = '';
  if (names.length === 0) {
    mcpPanelBody.innerHTML = '<p style="color:var(--text-muted)">No MCP servers configured.<br>Go to Settings to add servers.</p>';
    return;
  }

  for (const name of names) {
    const s = status[name];
    const section = document.createElement('div');
    section.className = 'server-section';

    const isOk = s.status === 'connected';
    const isDisabled = s.disabled;

    const header = document.createElement('div');
    header.className = 'server-name';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !isDisabled;
    toggle.title = isDisabled ? 'Enable this server' : 'Disable this server';
    toggle.style.cssText = 'margin-right:8px;cursor:pointer;accent-color:#4c4;';
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      await window.api.mcp.toggleServer(name, toggle.checked);
      toggle.disabled = false;
    });

    const dot = document.createElement('span');
    dot.className = `status-dot ${isDisabled ? '' : isOk ? 'ok' : 'err'}`;
    if (isDisabled) dot.style.background = 'var(--text-muted)';

    const label = document.createElement('span');
    label.textContent = name;

    header.appendChild(toggle);
    header.appendChild(dot);
    header.appendChild(label);
    section.appendChild(header);

    if (isDisabled) {
      const disabledDiv = document.createElement('div');
      disabledDiv.className = 'tool-item';
      disabledDiv.style.color = 'var(--text-muted)';
      disabledDiv.textContent = 'disabled';
      section.appendChild(disabledDiv);
    } else if (isOk && s.tools.length > 0) {
      for (const t of s.tools) {
        const item = document.createElement('div');
        item.className = 'tool-item';
        item.textContent = `${t.name}${t.description ? ' — ' + t.description : ''}`;
        section.appendChild(item);
      }
    } else if (!isOk) {
      const errDiv = document.createElement('div');
      errDiv.className = 'tool-item';
      errDiv.style.color = 'var(--error)';
      errDiv.textContent = s.status;
      section.appendChild(errDiv);
    }

    mcpPanelBody.appendChild(section);
  }
}

// Listen for MCP status from main process
window.api.onMcpStatus((status) => updateMcpStatus(status));

// Listen for Azure device-code prompts
const azureLoginOverlay = $('#azure-login-overlay');
const azureDeviceCode = $('#azure-device-code');
const azureVerifyLink = $('#azure-verify-link');

window.api.onAzureDeviceCode((info) => {
  // info has: message, userCode, verificationUri
  azureDeviceCode.textContent = info.userCode;
  azureVerifyLink.textContent = info.verificationUri;
  azureVerifyLink.onclick = (e) => {
    e.preventDefault();
    window.api.shell.openExternal(info.verificationUri);
  };
  azureLoginOverlay.hidden = false;

  // Auto-hide after token is acquired (MCP status update means connection succeeded)
  const hideOnStatus = () => { azureLoginOverlay.hidden = true; };
  window.api.onMcpStatus(hideOnStatus);
});

// Listen for Entra ID device-code prompts (custom LLM auth)
window.api.onEntraDeviceCode((info) => {
  azureDeviceCode.textContent = info.userCode;
  azureVerifyLink.textContent = info.verificationUri;
  azureVerifyLink.onclick = (e) => {
    e.preventDefault();
    window.api.shell.openExternal(info.verificationUri);
  };
  azureLoginOverlay.hidden = false;
  // Auto-hide once a chat chunk arrives (means token was acquired)
  const hide = () => { azureLoginOverlay.hidden = true; };
  window.api.onChatChunk(hide);
  window.api.onChatProgress(hide);
});

// Also fetch initial status
(async () => {
  const status = await window.api.mcp.getStatus();
  updateMcpStatus(status);
})();

// ── Attachments ───────────────────────────────────────

btnAttach.addEventListener('click', async () => {
  const files = await window.api.dialog.openFiles();
  for (const f of files) {
    if (!state.attachments.find((a) => a.path === f.path)) {
      state.attachments.push(f);
    }
  }
  renderAttachments();
});

function renderAttachments() {
  attachmentsList.innerHTML = '';
  if (state.attachments.length === 0) {
    attachmentsBar.hidden = true;
    return;
  }
  attachmentsBar.hidden = false;
  for (let i = 0; i < state.attachments.length; i++) {
    const a = state.attachments[i];
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    if (a.type === 'image' && a.dataUrl) {
      chip.innerHTML = `<img src="${a.dataUrl}" class="attachment-thumb" alt="${escapeHtml(a.name)}"> ${escapeHtml(a.name)} <span class="remove" data-idx="${i}">\u2715</span>`;
    } else {
      chip.innerHTML = `\ud83d\udcc4 ${escapeHtml(a.name)} <span class="remove" data-idx="${i}">\u2715</span>`;
    }
    attachmentsList.appendChild(chip);
  }
}

attachmentsList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove')) {
    const idx = parseInt(e.target.dataset.idx, 10);
    state.attachments.splice(idx, 1);
    renderAttachments();
  }
});

// ── Chat ──────────────────────────────────────────────

btnSend.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Paste handler (images & files) ────────────────────

chatInput.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    // Pasted image (screenshot, copied image)
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = await window.api.image.compress(reader.result);
        const ext = item.type.split('/')[1] || 'png';
        const name = `pasted-image-${Date.now()}.${ext}`;
        if (!state.attachments.find((a) => a.name === name)) {
          state.attachments.push({ name, type: 'image', dataUrl });
          renderAttachments();
        }
      };
      reader.readAsDataURL(blob);
      return; // only handle first image
    }
  }
});

// ── Drag-and-drop handler ─────────────────────────────

const dropZone = $('#app');

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (const file of files) {
    if (state.attachments.find((a) => a.name === file.name && a.path === file.path)) continue;

    const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];
    if (imageTypes.includes(file.type)) {
      // Read image as data URL directly in renderer
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = await window.api.image.compress(reader.result);
        state.attachments.push({ name: file.name, type: 'image', dataUrl });
        renderAttachments();
      };
      reader.readAsDataURL(file);
    } else if (file.path) {
      // Text file — read via main process
      const attachment = await window.api.file.read(file.path);
      if (!state.attachments.find((a) => a.path === attachment.path)) {
        state.attachments.push(attachment);
        renderAttachments();
      }
    }
  }
});

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !state.sending) return;

  // If currently sending, abort
  if (state.sending) {
    await window.api.chat.abort();
    return;
  }

  // Auto-create a new chat if none is active
  if (!state.currentChatId) {
    state.currentChatId = 'chat-' + Date.now();
  }

  // Add user message to UI
  const attachInfo = state.attachments.length > 0
    ? state.attachments.map((a) => ({ name: a.name, type: a.type, dataUrl: a.dataUrl }))
    : null;
  appendMessage('user', text, attachInfo);
  state.displayMessages.push({ role: 'user', content: text, attachmentInfo: attachInfo });

  // Add to conversation history
  state.messages.push({ role: 'user', content: text });

  const attachments = [...state.attachments];
  state.attachments = [];
  renderAttachments();

  chatInput.value = '';
  chatInput.style.height = 'auto';

  state.sending = true;
  btnSend.textContent = 'Stop';
  btnSend.classList.add('btn-stop');
  btnSend.disabled = false;

  // Show typing indicator and listen for progress updates
  const typingEl = showTyping();
  const progressHandler = (data) => updateTypingStatus(typingEl, data);
  const chunkHandler = (chunk) => updateTypingStream(typingEl, chunk);
  window.api.onChatProgress(progressHandler);
  window.api.onChatChunk(chunkHandler);

  const result = await window.api.chat.send({
    messages: [...state.messages],
    attachments,
  });

  removeTyping(typingEl);
  state.sending = false;
  btnSend.textContent = 'Send';
  btnSend.classList.remove('btn-stop');
  btnSend.disabled = false;

  if (result.error) {
    if (result.error.includes('aborted') || result.error.includes('abort') || result.error === 'Cancelled') {
      appendMessage('error', 'Request cancelled.');
    } else {
      appendMessage('error', result.error);
    }
  } else {
    appendMessage('assistant', result.content, null, result.thinking);
    state.messages.push({ role: 'assistant', content: result.content });
    state.displayMessages.push({ role: 'assistant', content: result.content, thinking: result.thinking });
  }

  // Auto-save to history
  await saveCurrentChat();

  chatInput.focus();
}

// ── UI helpers ────────────────────────────────────────

function appendMessage(role, content, attachmentInfo, thinking) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  if (role === 'user') {
    // Add edit button for user messages
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit-msg';
    editBtn.title = 'Edit & resend';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => {
      if (state.sending) return;
      // Find the index of this user message in displayMessages
      const allUserDivs = [...messagesEl.querySelectorAll('.message.user')];
      const msgIndex = allUserDivs.indexOf(div);
      if (msgIndex < 0) return;

      // Map user message div index to displayMessages index
      let userCount = -1;
      let displayIdx = -1;
      for (let i = 0; i < state.displayMessages.length; i++) {
        if (state.displayMessages[i].role === 'user') userCount++;
        if (userCount === msgIndex) { displayIdx = i; break; }
      }
      if (displayIdx < 0) return;

      // Truncate state back to before this message
      state.displayMessages = state.displayMessages.slice(0, displayIdx);
      // Find corresponding position in messages (skip system)
      let apiUserCount = -1;
      let apiIdx = -1;
      for (let i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'user') apiUserCount++;
        if (apiUserCount === msgIndex) { apiIdx = i; break; }
      }
      if (apiIdx >= 0) {
        state.messages = state.messages.slice(0, apiIdx);
      }

      // Remove this message and all following from DOM
      const allMsgs = [...messagesEl.querySelectorAll('.message')];
      const domIdx = allMsgs.indexOf(div);
      for (let i = allMsgs.length - 1; i >= domIdx; i--) {
        allMsgs[i].remove();
      }

      // Put text back in input
      chatInput.value = content;
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
      chatInput.focus();
    });
    div.appendChild(editBtn);
  }

  if (role === 'assistant' && content && typeof marked !== 'undefined') {
    // Show thinking/reasoning in a collapsible block
    if (thinking) {
      const details = document.createElement('details');
      details.className = 'thinking-block';
      const summary = document.createElement('summary');
      summary.textContent = 'Reasoning';
      details.appendChild(summary);
      const thinkContent = document.createElement('div');
      thinkContent.className = 'thinking-content';
      thinkContent.innerHTML = marked.parse(thinking);
      details.appendChild(thinkContent);
      div.appendChild(details);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'markdown-body';
    contentDiv.innerHTML = marked.parse(content);
    div.appendChild(contentDiv);
  } else {
    const textSpan = document.createElement('span');
    textSpan.textContent = content;
    div.appendChild(textSpan);
  }

  if (attachmentInfo && attachmentInfo.length > 0) {
    const info = document.createElement('div');
    info.className = 'tool-info';
    const imageAttachments = attachmentInfo.filter((a) => a.type === 'image' && a.dataUrl);
    const textAttachments = attachmentInfo.filter((a) => a.type !== 'image');

    if (textAttachments.length > 0) {
      const textLine = document.createElement('div');
      textLine.textContent = '📎 ' + textAttachments.map((a) => a.name).join(', ');
      info.appendChild(textLine);
    }
    if (imageAttachments.length > 0) {
      const imgRow = document.createElement('div');
      imgRow.className = 'attachment-images';
      for (const img of imageAttachments) {
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.alt = img.name;
        imgEl.className = 'msg-attachment-thumb';
        imgRow.appendChild(imgEl);
      }
      info.appendChild(imgRow);
    }
    div.appendChild(info);
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el._logLines = [];
  el.innerHTML = `
    <div class="typing-log"></div>
    <div class="typing-stream"></div>
    <div class="typing-dots"><span></span><span></span><span></span></div>
  `;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function updateTypingStatus(el, data) {
  if (!el) return;
  const logEl = el.querySelector('.typing-log');
  if (!logEl) return;

  const status = data.status || data;
  const detail = data.detail || null;

  // Build a log line
  let line = status;
  if (detail) line += '\n' + detail;

  el._logLines.push(line);

  // Render all log lines
  logEl.innerHTML = '';
  for (const entry of el._logLines) {
    const p = document.createElement('div');
    p.className = 'typing-log-entry';
    p.textContent = entry;
    logEl.appendChild(p);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateTypingStream(el, chunk) {
  if (!el) return;
  const streamEl = el.querySelector('.typing-stream');
  if (!streamEl) return;

  if (chunk.type === 'content' && chunk.full) {
    streamEl.innerHTML = typeof marked !== 'undefined' ? marked.parse(chunk.full) : escapeHtml(chunk.full);
  } else if (chunk.type === 'thinking' && chunk.full) {
    streamEl.innerHTML = '<em style="color:var(--text-muted)">' + escapeHtml(chunk.full.slice(-200)) + '</em>';
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeTyping(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Chat History ──────────────────────────────────────

btnHistory.addEventListener('click', async () => {
  historySidebar.hidden = !historySidebar.hidden;
  if (!historySidebar.hidden) await renderHistory();
});

btnCloseHistory.addEventListener('click', () => {
  historySidebar.hidden = true;
});

btnNewChat.addEventListener('click', () => {
  startNewChat();
});

function startNewChat() {
  state.currentChatId = null;
  state.messages = [];
  state.displayMessages = [];
  state.attachments = [];
  messagesEl.innerHTML = '';
  renderAttachments();
  chatInput.focus();
  // Highlight nothing in sidebar
  for (const el of historyList.querySelectorAll('.history-item')) {
    el.classList.remove('active');
  }
}

async function saveCurrentChat() {
  if (!state.currentChatId || state.messages.length === 0) return;
  // Generate title from first user message
  const firstUserMsg = state.messages.find((m) => m.role === 'user');
  const title = firstUserMsg
    ? firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '…' : '')
    : 'New Chat';

  await window.api.history.save({
    id: state.currentChatId,
    title,
    createdAt: state.currentChatCreatedAt || Date.now(),
    updatedAt: Date.now(),
    messages: state.messages,
    displayMessages: state.displayMessages,
  });
  if (!state.currentChatCreatedAt) state.currentChatCreatedAt = Date.now();
  // Refresh sidebar if open
  if (!historySidebar.hidden) await renderHistory();
}

async function renderHistory() {
  historyList.innerHTML = '';
  const chats = await window.api.history.list();

  if (chats.length === 0) {
    historyList.innerHTML = '<p class="history-empty">No conversations yet.</p>';
    return;
  }

  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'history-item' + (chat.id === state.currentChatId ? ' active' : '');
    item.dataset.id = chat.id;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-title';
    titleSpan.textContent = chat.title || 'Untitled';
    titleSpan.title = chat.title || 'Untitled';

    const dateSpan = document.createElement('span');
    dateSpan.className = 'history-date';
    dateSpan.textContent = formatDate(chat.updatedAt || chat.createdAt);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'history-delete btn-icon';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete chat';

    item.appendChild(titleSpan);
    item.appendChild(dateSpan);
    item.appendChild(deleteBtn);

    // Click to load chat
    item.addEventListener('click', (e) => {
      if (e.target === deleteBtn) return;
      loadChat(chat.id);
    });

    // Delete
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.history.delete(chat.id);
      if (state.currentChatId === chat.id) startNewChat();
      await renderHistory();
    });

    historyList.appendChild(item);
  }
}

async function loadChat(chatId) {
  const chat = await window.api.history.load(chatId);
  if (!chat) return;

  state.currentChatId = chat.id;
  state.currentChatCreatedAt = chat.createdAt;
  state.messages = chat.messages || [];
  state.displayMessages = chat.displayMessages || [];
  state.attachments = [];
  renderAttachments();

  // Re-render all messages
  messagesEl.innerHTML = '';
  for (const msg of state.displayMessages) {
    appendMessage(msg.role, msg.content, msg.attachmentInfo || null, msg.thinking || null);
  }

  // Highlight active in sidebar
  for (const el of historyList.querySelectorAll('.history-item')) {
    el.classList.toggle('active', el.dataset.id === chatId);
  }

  historySidebar.hidden = true;
  chatInput.focus();
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
