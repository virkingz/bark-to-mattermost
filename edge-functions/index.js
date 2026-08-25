// functions/index.js - EdgeOne Pages 专用

// 从环境变量获取配置（在 Pages 控制台设置）
const MATTERMOST_WEBHOOK_BASE_URL = process.env.MATTERMOST_WEBHOOK_BASE_URL || '';

// 优先级映射
const LEVEL_MAP = {
  "active": "🔴 高优先级",
  "timeSensitive": "🟡 中优先级",
  "passive": "🔵 低优先级"
};

function buildMattermostPayload(barkData) {
  const lines = [];
  const level = barkData.level || "";
  if (level && LEVEL_MAP[level]) {
    lines.push(LEVEL_MAP[level]);
  }
  if (barkData.title) lines.push(`**${barkData.title}**`);
  if (barkData.body) lines.push(barkData.body);
  if (barkData.badge) lines.push(`徽章: ${barkData.badge}`);
  if (barkData.copy) lines.push(`📋 复制: \`${barkData.copy}\``);
  if (barkData.sound) lines.push(`🔊 音效: ${barkData.sound}`);
  if (barkData.group) lines.push(`🏷️ 分组: ${barkData.group}`);

  if (lines.length === 0) return null;
  
  let text = lines.join("\n").replace(/https?:\/\/\S+/g, '').trim();
  if (barkData.markdown) text = barkData.markdown;
  
  return { text };
}

function parseBarkRequest(url, method, bodyData = null) {
  const urlObj = new URL(url);
  const path = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams);
  
  const parts = path.replace(/^\//, '').split('/').filter(p => p);
  if (parts.length === 0) return null;

  const deviceKey = parts[0];
  const barkData = { title: "", body: "", device_key: deviceKey };

  if (query.title) barkData.title = decodeURIComponent(query.title);
  if (query.body) barkData.body = decodeURIComponent(query.body);
  
  ['url', 'group', 'icon', 'copy'].forEach(p => {
    if (query[p]) barkData[p] = decodeURIComponent(query[p]);
  });
  
  ['level', 'badge', 'sound'].forEach(p => {
    if (query[p]) barkData[p] = query[p];
  });

  if (query.autoCopy) barkData.auto_copy = query.autoCopy;
  if (query.isArchive) barkData.isArchive = query.isArchive;

  if (parts.length > 1) {
    const content = decodeURIComponent(parts.slice(1).join('/'));
    if (!barkData.title && !barkData.body) {
      const idx = content.indexOf('/');
      if (idx > 0) {
        barkData.title = content.substring(0, idx);
        barkData.body = content.substring(idx + 1);
      } else {
        barkData.title = content;
      }
    }
  }

  if (bodyData) {
    Object.entries(bodyData).forEach(([key, value]) => {
      const k = key.toLowerCase();
      if (['title', 'body', 'url', 'group', 'icon', 'copy'].includes(k)) {
        barkData[k] = typeof value === 'string' ? decodeURIComponent(value) : String(value);
      } else if (['level', 'badge', 'sound'].includes(k)) {
        barkData[k] = String(value);
      } else if (k === 'autocopy') {
        barkData.auto_copy = String(value);
      }
    });
  }

  return barkData;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ============ EdgeOne Pages 入口 ============
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 健康检查
  if (path === "/" || path === "/health") {
    return jsonResponse({
      status: "running",
      service: "bark-to-mattermost",
      timestamp: Date.now()
    });
  }

  // 检查环境变量
  const baseUrl = process.env.MATTERMOST_WEBHOOK_BASE_URL || 
                  context.env?.MATTERMOST_WEBHOOK_BASE_URL || '';
  
  if (!baseUrl) {
    console.error("MATTERMOST_WEBHOOK_BASE_URL not set");
    return jsonResponse({
      code: 500,
      message: "Configuration error: MATTERMOST_WEBHOOK_BASE_URL not set"
    }, 500);
  }

  try {
    // 获取 body
    let bodyData = null;
    if (method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try { bodyData = await request.json(); } catch (e) { bodyData = {}; }
      }
    }

    // 解析请求
    const barkData = parseBarkRequest(request.url, method, bodyData);
    if (!barkData) {
      return jsonResponse({ code: 400, message: "Invalid request" }, 400);
    }

    const deviceKey = barkData.device_key;
    console.log(`device_key: ${deviceKey}`);

    // 构建 payload
    const payload = buildMattermostPayload(barkData);
    if (!payload) {
      return jsonResponse({ code: 200, message: "empty", timestamp: Date.now() });
    }

    // 发送到 Mattermost
    const webhookUrl = `${baseUrl.replace(/\/$/, '')}/hooks/${deviceKey}`;
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      console.error(`HTTP ${resp.status}`);
      return jsonResponse({
        code: 500,
        message: `Forward failed: HTTP ${resp.status}`,
        timestamp: Date.now()
      }, 500);
    }

    return jsonResponse({
      code: 200,
      message: "success",
      timestamp: Date.now()
    });

  } catch (error) {
    console.error(error.message);
    return jsonResponse({
      code: 500,
      message: `Error: ${error.message}`,
      timestamp: Date.now()
    }, 500);
  }
}
