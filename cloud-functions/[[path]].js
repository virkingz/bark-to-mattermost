// cloud-functions/[[path]].js - 完全对齐 Python WeCom 类逻辑

const QYWX_AM = process.env.QYWX_AM || '';
const MATTERMOST_WEBHOOK_BASE_URL = process.env.MATTERMOST_WEBHOOK_BASE_URL || '';

const LEVEL_MAP = {
  "active": "🔴 高优先级",
  "timeSensitive": "🟡 中优先级",
  "passive": "🔵 低优先级"
};

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
  if (barkData.level && LEVEL_MAP[barkData.level]) {
    lines.push(LEVEL_MAP[barkData.level]);
  }
  if (barkData.title) {
    lines.push(`**${barkData.title}**`);
  }
  if (barkData.body) {
    lines.push(barkData.body);
  }
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
  if (lines.length === 0) return null;
  return lines.join("\n").replace(/https?:\/\/\S+/g, '').trim();
}

// ============ 解析 Bark 请求（增强版） ============
function parseBarkRequest(url, method, bodyData = null) {
  const urlObj = new URL(url);
  const path = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams);

  // 1. 从 POST Body 获取（优先级最高）
  let title = bodyData?.title || bodyData?.push_title || '';
  let body = bodyData?.body || bodyData?.push_body || '';
  let level = bodyData?.level || '';
  let group = bodyData?.group || '';
  let copy = bodyData?.copy || '';
  let deviceKey = bodyData?.device_key || bodyData?.deviceKey || 'default';

  // 2. 如果 Body 没有，从 Query String 获取
  if (!title) title = query.title || '';
  if (!body) body = query.body || '';
  if (!level) level = query.level || '';
  if (!group) group = query.group || '';
  if (!copy) copy = query.copy || '';
  if (deviceKey === 'default') deviceKey = query.device_key || query.deviceKey || 'default';

  // 3. 如果都没有，从 URL Path 解析 (Bark 标准格式)
  let cleanPath = path;
  if (cleanPath.startsWith('/mattermost')) cleanPath = cleanPath.replace('/mattermost', '');
  else if (cleanPath.startsWith('/wx')) cleanPath = cleanPath.replace('/wx', '');

  const parts = cleanPath.replace(/^\//, '').split('/').filter(p => p.length > 0);

  if (!title && !body && parts.length > 0) {
    // 如果 deviceKey 还是默认值，从路径第一个部分取
    if (deviceKey === 'default') {
      deviceKey = parts[0];
    }
    // 剩余部分作为标题和内容
    if (parts.length > 1) {
      const content = decodeURIComponent(parts.slice(1).join('/'));
      const idx = content.indexOf('/');
      if (idx > 0) {
        title = content.substring(0, idx);
        body = content.substring(idx + 1);
      } else {
        title = content;
      }
    }
  }

  // 兼容 Bark 的 /device_key/title 格式（没有 body）
  if (title && !body && parts.length === 2) {
    // title 已经是标题，没有 body
  }

  return { deviceKey, title, body, level, group, copy };
}

// ============ 企业微信应用消息（完全对齐 Python WeCom 类） ============
async function sendWecomAppMessage(title, content, barkData) {
  if (!QYWX_AM) {
    throw new Error('QYWX_AM 环境变量未配置');
  }

  const parts = QYWX_AM.split(',').map(s => s.trim());
  if (parts.length < 4 || parts.length > 5) {
    throw new Error(`QYWX_AM 格式错误: 需要 4-5 个字段，当前 ${parts.length} 个`);
  }

  const [corpid, corpsecret, agentid, touser, media_id] = parts;
  const finalTouser = touser || '@all';

  // ----- 1. 获取 access_token (对应 Python 的 get_access_token) -----
  const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${corpsecret}`;
  console.log(`[WeCom] 正在获取 access_token...`);

  const tokenResponse = await fetch(tokenUrl, { method: 'GET' });
  if (!tokenResponse.ok) {
    throw new Error(`获取 token HTTP 错误: ${tokenResponse.status}`);
  }
  const tokenData = await tokenResponse.json();
  console.log(`[WeCom] Token 响应: errcode=${tokenData.errcode}, errmsg=${tokenData.errmsg}`);

  if (tokenData.errcode !== 0) {
    throw new Error(`获取 token 失败: ${tokenData.errmsg} (errcode: ${tokenData.errcode})`);
  }
  const accessToken = tokenData.access_token;

  // ----- 2. 构建消息 (对齐 Python send_text 和 send_mpnews) -----
  const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;

  let payload;
  const hasMediaId = media_id && media_id.length > 0;

  if (hasMediaId) {
    // ===== 图文消息 (mpnews) - 对应 send_mpnews =====
    console.log(`[WeCom] 使用 mpnews 类型，media_id: ${media_id}`);
    // 重要：将换行符替换为 <br/>，与 Python 版本一致
    const contentWithBr = content.replace(/\n/g, '<br/>');
    payload = {
      touser: finalTouser,
      msgtype: 'mpnews',
      agentid: parseInt(agentid),
      mpnews: {
        articles: [{
          title: title || '通知',
          thumb_media_id: media_id,
          author: 'Author',
          content_source_url: '',
          content: contentWithBr,
          digest: content.substring(0, 100)
        }]
      },
      safe: 0
    };
  } else {
    // ===== 文本消息 (text) - 对应 send_text =====
    console.log(`[WeCom] 使用 text 类型`);
    const messageText = title + "\n\n" + content;
    payload = {
      touser: finalTouser,
      msgtype: 'text',
      agentid: parseInt(agentid),
      text: { content: messageText },
      safe: 0
    };
  }

  console.log(`[WeCom] 发送消息到: ${finalTouser}, agentid: ${agentid}`);

  // ----- 3. 发送消息 -----
  const sendResponse = await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!sendResponse.ok) {
    throw new Error(`发送消息 HTTP 错误: ${sendResponse.status}`);
  }

  const sendResult = await sendResponse.json();
  console.log(`[WeCom] 发送响应: errcode=${sendResult.errcode}, errmsg=${sendResult.errmsg}`);

  // Python 版本返回的是 errmsg，这里也返回 errmsg
  if (sendResult.errcode !== 0) {
    throw new Error(`发送失败: ${sendResult.errmsg} (errcode: ${sendResult.errcode})`);
  }

  return sendResult.errmsg; // 对应 Python 的 return respone["errmsg"]
}

// ============ 发送到 Mattermost ============
async function sendToMattermost(deviceKey, text) {
  if (!MATTERMOST_WEBHOOK_BASE_URL) {
    throw new Error('MATTERMOST_WEBHOOK_BASE_URL 未配置');
  }
  const webhookUrl = `${MATTERMOST_WEBHOOK_BASE_URL.replace(/\/$/, '')}/hooks/${deviceKey}`;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
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

  // 健康检查
  if (path === "/" || path === "/health") {
    return jsonResponse({
      status: "running",
      service: "bark-to-wecom-mattermost",
      version: "2.0.0",
      endpoints: {
        wechat: "GET/POST /wx/{device_key}/{title}/{body}",
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

  // 路由判断
  const isWechat = path.startsWith('/wx');
  const isMattermost = path.startsWith('/mattermost');

  if (!isWechat && !isMattermost) {
    return jsonResponse({ code: 404, message: "Not found. Use /wx or /mattermost" }, 404);
  }

  try {
    // 获取 POST body
    let bodyData = null;
    if (method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try { bodyData = await request.json(); } catch (e) { bodyData = {}; }
      }
    }

    // 记录原始请求（用于调试）
    console.log(`[请求] method=${method}, path=${path}, query=${url.search}, body=${JSON.stringify(bodyData)}`);

    // 解析 Bark 请求
    const barkData = parseBarkRequest(request.url, method, bodyData);
    console.log(`[解析] deviceKey=${barkData.deviceKey}, title=${barkData.title}, body=${barkData.body.substring(0, 50)}...`);

    // 构建消息
    const text = buildMessageContent(barkData);
    if (!text) {
      return jsonResponse({ code: 200, message: "empty notification", timestamp: Date.now() });
    }

    // ===== 根据路由发送 =====
    let result = null;
    let target = '';

    if (isWechat) {
      target = 'wecom_app';
      if (!QYWX_AM) {
        return jsonResponse({ code: 500, message: "企业微信未配置: QYWX_AM 未设置" }, 500);
      }
      const title = barkData.title || '通知';
      result = await sendWecomAppMessage(title, text, barkData);

    } else if (isMattermost) {
      target = 'mattermost';
      if (!MATTERMOST_WEBHOOK_BASE_URL) {
        return jsonResponse({ code: 500, message: "Mattermost 未配置" }, 500);
      }
      result = await sendToMattermost(barkData.deviceKey || "default", text);
    }

    return jsonResponse({
      code: 200,
      message: "success",
      target: target,
      device_key: barkData.deviceKey || "default",
      wecom_response: result,  // 返回企业微信的 errmsg
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('[错误]', error);
    return jsonResponse({
      code: 500,
      message: `Error: ${error.message}`,
      stack: error.stack,
      timestamp: Date.now()
    }, 500);
  }
}
