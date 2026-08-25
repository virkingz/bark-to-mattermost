// cloud-functions/[[path]].js - 支持企业微信应用消息 和 Mattermost

// ============ 环境变量配置 ============
// 企业微信应用配置 (格式: corpid,corpsecret,agentid,touser,media_id)
// media_id 可选，用于发送图文消息
const QYWX_AM = process.env.QYWX_AM || '';

// Mattermost 配置
const MATTERMOST_WEBHOOK_BASE_URL = process.env.MATTERMOST_WEBHOOK_BASE_URL || '';

// ============ 常量映射 ============
const LEVEL_MAP = {
  "active": "🔴 高优先级",
  "timeSensitive": "🟡 中优先级",
  "passive": "🔵 低优先级"
};

// ============ 响应工具 ============
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ============ 构建消息内容 ============
function buildMessageContent(barkData) {
  const lines = [];
  
  // 优先级
  if (barkData.level && LEVEL_MAP[barkData.level]) {
    lines.push(LEVEL_MAP[barkData.level]);
  }
  
  // 标题
  if (barkData.title) {
    lines.push(`**${barkData.title}**`);
  }
  
  // 正文
  if (barkData.body) {
    lines.push(barkData.body);
  }
  
  // 其他信息
  if (barkData.badge) {
    lines.push(`徽章: ${barkData.badge}`);
  }
  if (barkData.copy) {
    lines.push(`📋 复制: \`${barkData.copy}\``);
  }
  if (barkData.sound) {
    lines.push(`🔊 音效: ${barkData.sound}`);
  }
  if (barkData.group) {
    lines.push(`🏷️ 分组: ${barkData.group}`);
  }
  
  if (lines.length === 0) {
    return null;
  }
  
  let text = lines.join("\n");
  text = text.replace(/https?:\/\/\S+/g, '').trim();
  
  return text;
}

// ============ 解析 Bark 请求 ============
function parseBarkRequest(url, method, bodyData = null) {
  const urlObj = new URL(url);
  const path = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams);
  
  // 移除路径前缀
  let cleanPath = path;
  if (cleanPath.startsWith('/mattermost')) {
    cleanPath = cleanPath.replace('/mattermost', '');
  } else if (cleanPath.startsWith('/wx')) {
    cleanPath = cleanPath.replace('/wx', '');
  }
  
  const parts = cleanPath.replace(/^\//, '').split('/').filter(p => p.length > 0);
  
  let deviceKey = "default";
  let title = query.title || "";
  let body = query.body || "";
  let level = query.level || "";
  let group = query.group || "";
  let copy = query.copy || "";
  let sound = query.sound || "";
  let badge = query.badge || "";
  
  // 从路径解析
  if (parts.length > 0) {
    deviceKey = parts[0];
  }
  
  if (parts.length > 1) {
    const content = decodeURIComponent(parts.slice(1).join('/'));
    if (!title && !body) {
      const idx = content.indexOf('/');
      if (idx > 0) {
        title = content.substring(0, idx);
        body = content.substring(idx + 1);
      } else {
        title = content;
      }
    }
  }
  
  // POST body 覆盖
  if (bodyData) {
    if (bodyData.title) title = bodyData.title;
    if (bodyData.body) body = bodyData.body;
    if (bodyData.level) level = bodyData.level;
    if (bodyData.group) group = bodyData.group;
    if (bodyData.copy) copy = bodyData.copy;
    if (bodyData.sound) sound = bodyData.sound;
    if (bodyData.badge) badge = bodyData.badge;
    if (bodyData.device_key) deviceKey = bodyData.device_key;
  }
  
  return { deviceKey, title, body, level, group, copy, sound, badge };
}

// ============ 企业微信应用消息 ============
async function sendWecomAppMessage(title, content, barkData) {
  if (!QYWX_AM) {
    throw new Error('QYWX_AM 未配置，请在环境变量中设置');
  }
  
  // 解析配置: corpid,corpsecret,agentid,touser,media_id
  const parts = QYWX_AM.split(',').map(s => s.trim());
  if (parts.length < 4 || parts.length > 5) {
    throw new Error('QYWX_AM 格式错误，应为: corpid,corpsecret,agentid,touser,media_id(可选)');
  }
  
  const [corpid, corpsecret, agentid, touser, media_id] = parts;
  
  // 1. 获取 access_token
  const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${corpsecret}`;
  const tokenResponse = await fetch(tokenUrl, { method: 'GET' });
  
  if (!tokenResponse.ok) {
    throw new Error(`获取 access_token 失败: ${tokenResponse.status}`);
  }
  
  const tokenData = await tokenResponse.json();
  if (tokenData.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${tokenData.errmsg}`);
  }
  
  const accessToken = tokenData.access_token;
  
  // 2. 构建消息内容
  const message = title + "\n\n" + content;
  
  // 3. 发送消息
  let payload;
  const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;
  
  // 如果有 media_id，发送图文消息 (mpnews)
  if (media_id && media_id.length > 0) {
    // 图文消息
    payload = {
      touser: touser || '@all',
      msgtype: 'mpnews',
      agentid: parseInt(agentid),
      mpnews: {
        articles: [
          {
            title: title || '通知',
            thumb_media_id: media_id,
            author: '系统',
            content_source_url: '',
            content: content,
            digest: content.substring(0, 100)
          }
        ]
      },
      safe: 0
    };
  } else {
    // 文本消息
    payload = {
      touser: touser || '@all',
      msgtype: 'text',
      agentid: parseInt(agentid),
      text: {
        content: message
      },
      safe: 0
    };
  }
  
  const response = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    throw new Error(`发送消息失败: ${response.status}`);
  }
  
  const result = await response.json();
  if (result.errcode !== 0) {
    throw new Error(`企业微信 API 错误: ${result.errmsg} (errcode: ${result.errcode})`);
  }
  
  return result;
}

// ============ 发送到 Mattermost ============
async function sendToMattermost(deviceKey, text) {
  if (!MATTERMOST_WEBHOOK_BASE_URL) {
    throw new Error('MATTERMOST_WEBHOOK_BASE_URL 未配置');
  }
  
  const webhookUrl = `${MATTERMOST_WEBHOOK_BASE_URL.replace(/\/$/, '')}/hooks/${deviceKey}`;
  const payload = { text };
  
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  
  return response;
}

// ============ 主请求处理 ============
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ===== 健康检查 =====
  if (path === "/" || path === "/health") {
    return jsonResponse({
      status: "running",
      service: "bark-to-wecom-mattermost",
      version: "2.0.0",
      endpoints: {
        wechat: "GET/POST /wx/{device_key}/{title}/{body} (企业微信应用消息)",
        mattermost: "GET/POST /mattermost/{device_key}/{title}/{body}",
        health: "GET /health"
      },
      config: {
        wecom_app: !!QYWX_AM,
        mattermost: !!MATTERMOST_WEBHOOK_BASE_URL
      },
      timestamp: Date.now()
    });
  }

  // ===== 路由判断 =====
  const isWechat = path.startsWith('/wx');
  const isMattermost = path.startsWith('/mattermost');
  
  if (!isWechat && !isMattermost) {
    return jsonResponse({
      code: 404,
      message: "Not found. Use /wx (企业微信) or /mattermost",
      timestamp: Date.now()
    }, 404);
  }

  try {
    // 获取 POST body
    let bodyData = null;
    if (method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          bodyData = await request.json();
        } catch (e) {
          bodyData = {};
        }
      }
    }

    // 解析请求
    const barkData = parseBarkRequest(request.url, method, bodyData);
    if (!barkData) {
      return jsonResponse({
        code: 400,
        message: "Invalid request format",
        timestamp: Date.now()
      }, 400);
    }

    // 构建消息
    const text = buildMessageContent(barkData);
    if (!text) {
      return jsonResponse({
        code: 200,
        message: "empty notification",
        timestamp: Date.now()
      });
    }

    // ===== 根据路由发送 =====
    let result = null;
    let target = '';

    if (isWechat) {
      // ===== 发送到企业微信应用消息 =====
      target = 'wecom_app';
      
      if (!QYWX_AM) {
        return jsonResponse({
          code: 500,
          message: "企业微信未配置: QYWX_AM 未设置",
          timestamp: Date.now()
        }, 500);
      }
      
      const title = barkData.title || '通知';
      result = await sendWecomAppMessage(title, text, barkData);
      
    } else if (isMattermost) {
      // ===== 发送到 Mattermost =====
      target = 'mattermost';
      
      if (!MATTERMOST_WEBHOOK_BASE_URL) {
        return jsonResponse({
          code: 500,
          message: "Mattermost 未配置: MATTERMOST_WEBHOOK_BASE_URL 未设置",
          timestamp: Date.now()
        }, 500);
      }
      
      const deviceKey = barkData.deviceKey || "default";
      result = await sendToMattermost(deviceKey, text);
    }

    return jsonResponse({
      code: 200,
      message: "success",
      target: target,
      device_key: barkData.deviceKey || "default",
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({
      code: 500,
      message: `Error: ${error.message}`,
      timestamp: Date.now()
    }, 500);
  }
}
