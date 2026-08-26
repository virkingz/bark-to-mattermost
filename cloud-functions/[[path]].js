// cloud-functions/[[path]].js - Bark 转企业微信群机器人（纯文本，无加粗）

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

// ============ 解析 Bark 请求 ============
function parseBarkRequest(url, method, bodyData = null) {
  const urlObj = new URL(url);
  const path = urlObj.pathname;
  const query = Object.fromEntries(urlObj.searchParams);

  const parts = path.replace(/^\//, '').split('/').filter(p => p.length > 0);

  let deviceKey = '';
  let title = '';
  let body = '';
  let level = query.level || '';
  let group = query.group || '';
  let copy = query.copy || '';
  let badge = query.badge || '';
  let sound = query.sound || '';

  if (bodyData) {
    if (bodyData.title) title = bodyData.title;
    if (bodyData.body) body = bodyData.body;
    if (bodyData.level) level = bodyData.level;
    if (bodyData.group) group = bodyData.group;
    if (bodyData.copy) copy = bodyData.copy;
    if (bodyData.badge) badge = bodyData.badge;
    if (bodyData.sound) sound = bodyData.sound;
    if (bodyData.device_key) deviceKey = bodyData.device_key;
  }

  if (parts.length > 0) {
    deviceKey = parts[0];
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
  }

  if (query.title) title = decodeURIComponent(query.title);
  if (query.body) body = decodeURIComponent(query.body);
  if (query.device_key) deviceKey = query.device_key;

  return { deviceKey, title, body, level, group, copy, badge, sound };
}

// ============ 构建消息内容（无加粗） ============
function buildMessageContent(barkData) {
  const lines = [];

  if (barkData.level && LEVEL_MAP[barkData.level]) {
    lines.push(LEVEL_MAP[barkData.level]);
  }
  if (barkData.title) {
    lines.push(barkData.title);
  }
  if (barkData.body) {
    lines.push(barkData.body);
  }
  if (barkData.badge) {
    lines.push(`徽章: ${barkData.badge}`);
  }
  if (barkData.copy) {
    lines.push(`📋 复制: ${barkData.copy}`);
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

// ============ 发送到企业微信群机器人 ============
async function sendWechatBot(deviceKey, content) {
  if (!deviceKey) {
    throw new Error('缺少 device_key');
  }

  const webhookUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${deviceKey}`;

  const payload = {
    msgtype: 'text',
    text: {
      content: content
    }
  };

  console.log(`[Bot] 发送消息到: ${deviceKey.substring(0, 10)}...`);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  console.log(`[Bot] 响应: errcode=${result.errcode}, errmsg=${result.errmsg}`);

  if (result.errcode !== 0) {
    throw new Error(`发送失败: ${result.errmsg} (errcode: ${result.errcode})`);
  }

  return result;
}

// ============ 主请求处理 ============
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/" || path === "/health") {
    return jsonResponse({
      status: "running",
      service: "bark-to-wechat-bot",
      version: "2.0.0",
      usage: {
        url_format: "/{webhook_key}/{title}/{body}",
        example: "/693axxx6-7aoc-4bc4-97a0-0ec2sifa5aaa/测试标题/测试内容?level=active"
      },
      timestamp: Date.now()
    });
  }

  try {
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

    const barkData = parseBarkRequest(request.url, method, bodyData);
    console.log(`[Bark] deviceKey: ${barkData.deviceKey.substring(0, 10)}...`);

    if (!barkData.deviceKey) {
      return jsonResponse({
        code: 400,
        message: "缺少 device_key，请在 URL 中提供企业微信 Webhook key",
        example: `${url.origin}/693axxx6-7aoc-4bc4-97a0-0ec2sifa5aaa/测试标题/测试内容`
      }, 400);
    }

    const text = buildMessageContent(barkData);
    if (!text) {
      return jsonResponse({
        code: 200,
        message: "empty notification",
        timestamp: Date.now()
      });
    }

    const result = await sendWechatBot(barkData.deviceKey, text);

    return jsonResponse({
      code: 200,
      message: "success",
      device_key: barkData.deviceKey.substring(0, 10) + '...',
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('[错误]', error);
    return jsonResponse({
      code: 500,
      message: `Error: ${error.message}`,
      timestamp: Date.now()
    }, 500);
  }
}
