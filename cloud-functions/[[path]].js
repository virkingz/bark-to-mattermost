// cloud-functions/[[path]].js - Cloud Functions 版本

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
      type: "cloud-functions",
      timestamp: Date.now()
    });
  }

  // 检查环境变量
  if (!MATTERMOST_WEBHOOK_BASE_URL) {
    return jsonResponse({
      code: 500,
      message: "Error: MATTERMOST_WEBHOOK_BASE_URL not configured"
    }, 500);
  }

  try {
    // 解析路径
    const parts = path.replace(/^\//, '').split('/').filter(p => p.length > 0);
    
    if (parts.length === 0) {
      return jsonResponse({ code: 404, message: "Not found" }, 404);
    }

    const deviceKey = parts[0];
    const query = Object.fromEntries(url.searchParams);
    
    // 获取标题和正文
    let title = query.title || "";
    let body = query.body || "";
    
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

    // 处理 POST body
    let postData = null;
    if (method === "POST") {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          postData = await request.json();
        } catch (e) {}
      }
    }

    // 用 POST 数据覆盖
    if (postData) {
      if (postData.title) title = postData.title;
      if (postData.body) body = postData.body;
    }

    // 构建消息
    const lines = [];
    
    const level = query.level || postData?.level || "";
    if (level === "active") lines.push("🔴 高优先级");
    else if (level === "timeSensitive") lines.push("🟡 中优先级");
    else if (level === "passive") lines.push("🔵 低优先级");
    
    if (title) lines.push(`**${title}**`);
    if (body) lines.push(body);
    
    const group = query.group || postData?.group || "";
    if (group) lines.push(`🏷️ 分组: ${group}`);
    
    const copy = query.copy || postData?.copy || "";
    if (copy) lines.push(`📋 复制: \`${copy}\``);

    if (lines.length === 0) {
      return jsonResponse({
        code: 200,
        message: "empty notification",
        timestamp: Date.now()
      });
    }

    // 发送到 Mattermost
    const webhookUrl = `${MATTERMOST_WEBHOOK_BASE_URL.replace(/\/$/, '')}/hooks/${deviceKey}`;
    const payload = { text: lines.join("\n").trim() };

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return jsonResponse({
        code: 500,
        message: `Forward failed: HTTP ${resp.status}`,
        detail: errorText,
        timestamp: Date.now()
      }, 500);
    }

    return jsonResponse({
      code: 200,
      message: "success",
      timestamp: Date.now()
    });

  } catch (error) {
    return jsonResponse({
      code: 500,
      message: `Error: ${error.message}`,
      timestamp: Date.now()
    }, 500);
  }
}
