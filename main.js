const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { AuthManager } = require('./src/auth');
const { CopilotClient } = require('./src/copilot');
const { McpManager } = require('./src/mcp-manager');

const MAX_IMAGE_DIMENSION = 1024;
const JPEG_QUALITY = 80;

// Resize a base64 data URL image to fit within MAX_IMAGE_DIMENSION, returns a new data URL
function resizeImageDataUrl(dataUrl) {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    const size = img.getSize();
    if (size.width <= MAX_IMAGE_DIMENSION && size.height <= MAX_IMAGE_DIMENSION) {
      // Still re-encode as JPEG to compress
      const jpeg = img.toJPEG(JPEG_QUALITY);
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    }
    const scale = MAX_IMAGE_DIMENSION / Math.max(size.width, size.height);
    const newWidth = Math.round(size.width * scale);
    const newHeight = Math.round(size.height * scale);
    const resized = img.resize({ width: newWidth, height: newHeight, quality: 'better' });
    const jpeg = resized.toJPEG(JPEG_QUALITY);
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return dataUrl; // fallback to original if resize fails
  }
}

let mainWindow;
let authManager;
let copilotClient;
let mcpManager;
const chatStore = new Store({ name: 'chat-history' });
const settingsStore = new Store({ name: 'settings' });

// Strip verbose descriptions and deeply nested schemas to reduce token usage
function compactSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const result = { type: schema.type || 'object' };
  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      result.properties[key] = { type: val.type || 'string' };
      if (val.enum) result.properties[key].enum = val.enum;
      if (val.description) result.properties[key].description = val.description.slice(0, 100);
    }
  }
  if (schema.required) result.required = schema.required;
  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'SmallChat',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(async () => {
  authManager = new AuthManager();
  copilotClient = new CopilotClient(authManager);
  mcpManager = new McpManager();

  createWindow();

  // Load MCP servers after the window is ready so the status push always arrives
  const sendMcpStatus = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp:status', mcpManager.getStatus());
    }
  };

  // Migrate from mcp-servers.json on first run
  if (!settingsStore.has('mcpConfig')) {
    const legacyPath = path.join(__dirname, 'mcp-servers.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const raw = fs.readFileSync(legacyPath, 'utf-8');
        settingsStore.set('mcpConfig', JSON.parse(raw));
      } catch { /* ignore bad JSON */ }
    } else {
      settingsStore.set('mcpConfig', { mcpServers: {} });
    }
  }

  // Forward Azure device-code login prompts to the renderer
  mcpManager.onDeviceCode = (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('azure:deviceCode', info);
    }
  };

  // Forward Entra ID device-code prompts from custom LLM auth
  copilotClient.onEntraDeviceCode = (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('entra:deviceCode', info);
    }
  };


  const initMcp = async () => {
    try {
      const config = settingsStore.get('mcpConfig', { mcpServers: {} });
      const disabled = settingsStore.get('disabledMcpServers', []);
      mcpManager.setConfig(config);
      mcpManager.setDisabledServers(disabled);
      await mcpManager.connectAll();
      sendMcpStatus();
    } catch (err) {
      console.error('Failed to load MCP config:', err.message);
    }
  };
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', initMcp);
  } else {
    initMcp();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await mcpManager.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});

// ── Auth IPC ──────────────────────────────────────────────

ipcMain.handle('auth:getStatus', () => {
  return {
    loggedIn: authManager.isLoggedIn(),
    user: authManager.getUser(),
    copilotAccess: authManager.hasCopilotAccess(),
  };
});

ipcMain.handle('auth:login', async (_event, token) => {
  return authManager.login(token);
});

ipcMain.handle('auth:startDeviceFlow', async () => {
  return authManager.startDeviceFlow();
});

ipcMain.handle('auth:pollDeviceFlow', async (_event, { deviceCode, interval }) => {
  return authManager.pollDeviceFlow(deviceCode, interval);
});

ipcMain.handle('auth:cancelDeviceFlow', () => {
  authManager.cancelDeviceFlow();
});

ipcMain.handle('auth:logout', () => {
  authManager.logout();
  return { loggedIn: false };
});

// ── Chat History IPC ──────────────────────────────────────

ipcMain.handle('history:list', () => {
  const chats = chatStore.get('chats', []);
  // Return list sorted by last updated, newest first (without full messages)
  return chats
    .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
});

ipcMain.handle('history:load', (_event, chatId) => {
  const chats = chatStore.get('chats', []);
  return chats.find((c) => c.id === chatId) || null;
});

ipcMain.handle('history:save', (_event, chat) => {
  const chats = chatStore.get('chats', []);
  const idx = chats.findIndex((c) => c.id === chat.id);
  chat.updatedAt = Date.now();
  if (idx >= 0) {
    chats[idx] = chat;
  } else {
    chats.push(chat);
  }
  chatStore.set('chats', chats);
});

ipcMain.handle('history:delete', (_event, chatId) => {
  const chats = chatStore.get('chats', []);
  chatStore.set('chats', chats.filter((c) => c.id !== chatId));
});

ipcMain.handle('history:rename', (_event, { chatId, title }) => {
  const chats = chatStore.get('chats', []);
  const chat = chats.find((c) => c.id === chatId);
  if (chat) {
    chat.title = title;
    chat.updatedAt = Date.now();
    chatStore.set('chats', chats);
  }
});

// ── Chat IPC ──────────────────────────────────────────────

let chatAbortController = null;

ipcMain.handle('chat:abort', () => {
  copilotClient.abort();
  if (chatAbortController) {
    chatAbortController.abort();
    chatAbortController = null;
  }
});

ipcMain.handle('chat:send', async (event, { messages, attachments }) => {
  const isCustomMode = copilotClient.getMode() === 'custom';
  if (!isCustomMode && !authManager.isLoggedIn()) {
    return { error: 'Not logged in. Please set your GitHub token first.' };
  }

  // Ensure system message is first
  if (!messages.length || messages[0].role !== 'system') {
    messages.unshift({
      role: 'system',
      content: 'You are a helpful assistant. You have access to MCP tools for Power BI and other services, and built-in filesystem tools (fs_read_file, fs_write_file, fs_list_directory, fs_create_directory) to read and write files on the user\'s computer. Use tools when the user asks to interact with external systems or the filesystem. Be concise.',
    });
  }

  // Build content with attachments
  const lastMsg = messages[messages.length - 1];
  if (attachments && attachments.length > 0) {
    const textAttachments = attachments.filter((a) => a.type !== 'image');
    const imageAttachments = attachments.filter((a) => a.type === 'image');

    // Append text file contents inline
    if (textAttachments.length > 0) {
      const attachmentText = textAttachments
        .map((a) => `\n---\n**Attached file: ${a.name}**\n\`\`\`\n${a.content}\n\`\`\``)
        .join('\n');
      lastMsg.content = lastMsg.content + attachmentText;
    }

    // Convert to multimodal content array if there are images
    if (imageAttachments.length > 0) {
      const parts = [{ type: 'text', text: lastMsg.content }];
      for (const img of imageAttachments) {
        const compressedUrl = resizeImageDataUrl(img.dataUrl);
        parts.push({
          type: 'image_url',
          image_url: { url: compressedUrl },
        });
      }
      lastMsg.content = parts;
    }
  }

  // Gather MCP tools — compact schemas to stay within token limits
  const mcpTools = mcpManager.getAllTools();
  const openAiTools = mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.qualifiedName,
      description: (t.description || '').slice(0, 200),
      parameters: compactSchema(t.inputSchema),
    },
  }));

  // Add built-in filesystem tools
  openAiTools.push(
    {
      type: 'function',
      function: {
        name: 'fs_read_file',
        description: 'Read the contents of a file at the given path.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs_write_file',
        description: 'Write content to a file. Creates the file and parent directories if they do not exist. Overwrites existing files.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' }, content: { type: 'string', description: 'File content to write' } }, required: ['path', 'content'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs_list_directory',
        description: 'List files and subdirectories in a directory.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute directory path' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs_create_directory',
        description: 'Create a directory (and parent directories if needed).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute directory path' } }, required: ['path'] },
      },
    }
  );

  try {
    chatAbortController = new AbortController();
    const abortSignal = chatAbortController.signal;

    // Helper to send progress updates to the renderer
    const sendProgress = (msg, detail) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat:progress', { status: msg, detail: detail || null });
      }
    };

    // Callback for streaming content chunks
    const onChunk = (chunk) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat:chunk', chunk);
      }
    };

    // Initial LLM call
    sendProgress('Thinking...');
    let response = await copilotClient.chat(messages, openAiTools.length > 0 ? openAiTools : undefined, onChunk);

    // Tool-call loop: run MCP tools and feed results back
    while (response.toolCalls && response.toolCalls.length > 0) {
      if (abortSignal.aborted) throw new Error('Request was cancelled');

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls,
      });

      // Execute each tool call
      for (const tc of response.toolCalls) {
        const toolDisplayName = tc.function.name.replace(/__/g, ' → ');
        let args;
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments || '{}')
            : (tc.function.arguments || {});
        } catch (parseErr) {
          sendProgress(`✗ ${toolDisplayName}`, `Bad arguments: ${parseErr.message}`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: could not parse tool arguments – ${parseErr.message}`,
          });
          continue;
        }

        // Show tool name + arguments summary
        const argsSummary = Object.entries(args).map(([k, v]) => {
          const val = typeof v === 'string' ? (v.length > 80 ? v.slice(0, 80) + '…' : v) : JSON.stringify(v);
          return `  ${k}: ${val}`;
        }).join('\n');
        sendProgress(`Calling: ${toolDisplayName}`, argsSummary);

        if (abortSignal.aborted) throw new Error('Request was cancelled');

        let result;
        // Handle built-in filesystem tools
        if (tc.function.name === 'fs_read_file') {
          try {
            result = fs.readFileSync(args.path, 'utf-8');
          } catch (err) {
            result = `Error reading file: ${err.message}`;
          }
        } else if (tc.function.name === 'fs_write_file') {
          try {
            const dir = path.dirname(args.path);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(args.path, args.content, 'utf-8');
            result = `File written successfully: ${args.path}`;
          } catch (err) {
            result = `Error writing file: ${err.message}`;
          }
        } else if (tc.function.name === 'fs_list_directory') {
          try {
            const entries = fs.readdirSync(args.path, { withFileTypes: true });
            result = entries.map((e) => (e.isDirectory() ? `[DIR]  ${e.name}` : `       ${e.name}`)).join('\n');
          } catch (err) {
            result = `Error listing directory: ${err.message}`;
          }
        } else if (tc.function.name === 'fs_create_directory') {
          try {
            fs.mkdirSync(args.path, { recursive: true });
            result = `Directory created: ${args.path}`;
          } catch (err) {
            result = `Error creating directory: ${err.message}`;
          }
        } else {
          // MCP tool call
          result = await mcpManager.callTool(tc.function.name, args, abortSignal);
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });

        // Show result summary
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const resultPreview = resultStr.length > 120 ? resultStr.slice(0, 120) + '…' : resultStr;
        sendProgress(`✓ ${toolDisplayName}`, resultPreview);
      }

      // Call LLM again with tool results
      sendProgress('Thinking...');
      response = await copilotClient.chat(messages, openAiTools.length > 0 ? openAiTools : undefined, onChunk);
    }

    return { content: response.content, thinking: response.thinking || null };
  } catch (err) {
    if (err.name === 'AbortError' || chatAbortController?.signal?.aborted) {
      return { error: 'Cancelled' };
    }
    return { error: err.message };
  } finally {
    chatAbortController = null;
  }
});

// ── File picker IPC ───────────────────────────────────────

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Text Files', extensions: ['txt', 'md', 'json', 'js', 'ts', 'py', 'yaml', 'yml', 'xml', 'csv', 'html', 'css', 'sql', 'sh', 'ps1', 'bicep', 'tf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];

  const fs = require('fs');
  return result.filePaths.map((fp) => ({
    name: path.basename(fp),
    path: fp,
    content: fs.readFileSync(fp, 'utf-8'),
  }));
});

// ── File read IPC (for paste / drag-drop) ─────────────────

ipcMain.handle('file:read', async (_event, filePath) => {
  const fs = require('fs');
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

  if (imageExts.includes(ext)) {
    const buf = fs.readFileSync(filePath);
    const base64 = buf.toString('base64');
    const mime = ext === '.jpg' ? 'image/jpeg'
      : ext === '.svg' ? 'image/svg+xml'
      : `image/${ext.slice(1)}`;
    const rawDataUrl = `data:${mime};base64,${base64}`;
    const dataUrl = resizeImageDataUrl(rawDataUrl);
    return { name, path: filePath, type: 'image', dataUrl };
  }
  return { name, path: filePath, type: 'text', content: fs.readFileSync(filePath, 'utf-8') };
});

ipcMain.handle('image:compress', (_event, dataUrl) => {
  return resizeImageDataUrl(dataUrl);
});

// ── MCP IPC ───────────────────────────────────────────────

ipcMain.handle('mcp:getStatus', () => {
  return mcpManager.getStatus();
});

ipcMain.handle('mcp:reconnect', async () => {
  await mcpManager.disconnectAll();
  const config = settingsStore.get('mcpConfig', { mcpServers: {} });
  const disabled = settingsStore.get('disabledMcpServers', []);
  mcpManager.setConfig(config);
  mcpManager.setDisabledServers(disabled);
  await mcpManager.connectAll();
  return mcpManager.getStatus();
});

ipcMain.handle('mcp:toggleServer', async (_event, { serverName, enabled }) => {
  const disabled = settingsStore.get('disabledMcpServers', []);
  const set = new Set(disabled);
  if (enabled) {
    set.delete(serverName);
  } else {
    set.add(serverName);
  }
  settingsStore.set('disabledMcpServers', [...set]);

  // Reconnect with updated disabled list
  await mcpManager.disconnectAll();
  const config = settingsStore.get('mcpConfig', { mcpServers: {} });
  mcpManager.setConfig(config);
  mcpManager.setDisabledServers([...set]);
  await mcpManager.connectAll();
  const status = mcpManager.getStatus();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mcp:status', status);
  }
  return status;
});

ipcMain.handle('mcp:getConfig', () => {
  return settingsStore.get('mcpConfig', { mcpServers: {} });
});

ipcMain.handle('mcp:saveConfig', async (_event, config) => {
  settingsStore.set('mcpConfig', config);
  // Reconnect with new config
  await mcpManager.disconnectAll();
  const disabled = settingsStore.get('disabledMcpServers', []);
  mcpManager.setConfig(config);
  mcpManager.setDisabledServers(disabled);
  await mcpManager.connectAll();
  const status = mcpManager.getStatus();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mcp:status', status);
  }
  return status;
});

// ── Settings IPC ──────────────────────────────────────────

ipcMain.handle('settings:getModel', () => {
  return copilotClient.getModel();
});

ipcMain.handle('settings:setModel', (_event, model) => {
  copilotClient.setModel(model);
});

ipcMain.handle('settings:getEndpoint', () => {
  return copilotClient.getEndpoint();
});

ipcMain.handle('settings:setEndpoint', (_event, endpoint) => {
  copilotClient.setEndpoint(endpoint);
});

ipcMain.handle('settings:getMode', () => {
  return copilotClient.getMode();
});

ipcMain.handle('settings:setMode', (_event, mode) => {
  copilotClient.setMode(mode);
  return { model: copilotClient.getModel(), endpoint: copilotClient.getEndpoint() };
});

ipcMain.handle('settings:getCopilotModels', async () => {
  try {
    return await copilotClient.getCopilotModels();
  } catch {
    return [];
  }
});

ipcMain.handle('settings:getCustomApiKey', () => {
  return copilotClient.getCustomApiKey();
});

ipcMain.handle('settings:setCustomApiKey', (_event, key) => {
  copilotClient.setCustomApiKey(key);
});

ipcMain.handle('settings:getCustomAuthType', () => {
  return copilotClient.getCustomAuthType();
});

ipcMain.handle('settings:setCustomAuthType', (_event, type) => {
  copilotClient.setCustomAuthType(type);
});

ipcMain.handle('settings:getEntraTenantId', () => {
  return copilotClient.getEntraTenantId();
});

ipcMain.handle('settings:setEntraTenantId', (_event, tenantId) => {
  copilotClient.setEntraTenantId(tenantId);
});

// ── Open external link ────────────────────────────────────

ipcMain.handle('shell:openExternal', (_event, url) => {
  // Only open HTTPS URLs to prevent arbitrary command execution
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});
