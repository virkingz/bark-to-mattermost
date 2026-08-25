// index.js - EdgeOne Pages Functions 兼容格式

// 从环境变量获取配置
const MATTERMOST_WEBHOOK_BASE_URL = process.env.MATTERMOST_WEBHOOK_BASE_URL || '';

// 优先级映射
const LEVEL_MAP = {
  "active": "🔴 高优先级",
  "timeSensitive": "🟡 中优先级",
  "passive": "🔵 低优先级"
};

// 排除的路径
const EXCLUDED_PATHS = ["/", "/push", "/webhook", "/favicon.ico"];

function buildMattermostPayload(barkData) {
  const title = barkData.title || "";
  const body = barkData.body || "";
  const lines = [];

  const level = barkData.level || "";
  if (level && LEVEL_MAP[level]) {
    lines.push(LEVEL_MAP[level]);
  }

  if (title) {
    lines.push(`**${title}**`);
  }

  if (body) {
    lines.push(body);
  }

  const badge = barkData.badge || "";
  if (badge) {
    lines.push(`徽章: ${badge}`);
  }

  const copyText = barkData.copy || "";
  if (copyText) {
    lines.push(`📋 复制内容: \`${copyText}\``);
  }

  const sound = barkData.sound || "";
  if (sound) {
    lines.push(`🔊 音效: ${sound}`);
  }

  const group = barkData.group || "";
  if (group) {
    lines.push(`🏷️ 分组: ${group}`);
  }

  if (lines.length === 0) {
    return null;
  }

  let textContent = lines.join("\n");
  textContent = textContent.replace(/https?:\/\/\S+/g, '');
  textContent = textContent.replace(/\n\s*\n+/g, '\n').trim();

  if (barkData.markdown) {
    textContent = barkData.markdown;
  }

  return { text: textContent };
}

function parseBarkRequest(url, method, bodyData = null) {
  const urlObj = new URL(url);
  const path = urlObj.pathname;
  const queryParams = Object.fromEntries(urlObj.searchParams);

  const parts = path.replace(/^\//, '').split('/').filter(p => p.length > 0);
  
  if (parts.length === 0) {
    return null;
  }

  const deviceKey = parts[0];

  const barkData = {
    title: "",
    body: "",
    device_key: deviceKey
  };

  if (queryParams.title) {
    barkData.title = decodeURIComponent(queryParams.title);
  }
  if (queryParams.body) {
    barkData.body = decodeURIComponent(queryParams.body);
  }

  const stringParams = ['url', 'group', 'icon', 'copy'];
  for (const param of stringParams) {
    if (queryParams[param]) {
      barkData[param] = decodeURIComponent(queryParams[param]);
    }
  }

  const simpleParams = ['level', 'badge', 'sound'];
  for (const param of simpleParams) {
    if (queryParams[param]) {
      barkData[param] = queryParams[param];
    }
  }

  if (queryParams.autoCopy) {
    barkData.auto_copy = queryParams.autoCopy;
  }
  if (queryParams.isArchive) {
    barkData.isArchive = queryParams.isArchive;
  }

  if (parts.length > 1) {
    const pathContent = parts.slice(1).join('/');
    const decodedPath = decodeURIComponent(pathContent);

    if (!barkData.title && !barkData.body) {
      if (decodedPath.includes('/')) {
        const idx = decodedPath.indexOf('/');
        barkData.title = decodedPath.substring(0, idx);
        barkData.body = decodedPath.substring(idx + 1);
      } else {
        barkData.title = decodedPath;
      }
    }
  }

  if (bodyData) {
    for (const [key, value] of Object.entries(bodyData)) {
      const lowerKey = key.toLowerCase();
      if (['title', 'body', 'url', 'group', 'icon', 'copy'].includes(lowerKey)) {
        barkData[lowerKey] = typeof value === 'string' ? decodeURIComponent(value) : String(value);
      } else if (['level', 'badge', 'sound'].includes(lowerKey)) {
        barkData[lowerKey] = String(value);
      } else if (lowerKey === 'autocopy') {
        barkData.auto_copy = String(value);
      }
    }
  }

  return barkData;
}

function createResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// EdgeOne Pages Functions 入口 - 使用 export 方式
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 获取环境变量 - EdgeOne Pages 使用 context.env
  const baseUrl = context.env?.MATTERMOST_WEBHOOK_BASE_URL || process.env?.MATTERMOST_WEBHOOK_BASE_URL || '';

  // 健康检查
  if (path === "/" || path === "/health") {
    return createResponse({
      status: "running",
      service: "bark-to-mattermost",
      timestamp: Date.now()
    });
  }

  // 排除路径
  if (EXCLUDED_PATHS.includes(path)) {
    return createResponse({
      code: 404,
      message: "Not found"
    }, 404);
  }

  if (!baseUrl) {
    console.error("MATTERMOST_WEBHOOK_BASE_URL environment variable not set");
    return createResponse({
      code: 500,
      message: "Server configuration error: MATTERMOST_WEBHOOK_BASE_URL not set"
    }, 500);
  }

  try {
    let bodyData = null;
    if (method === "POST") {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          bodyData = await request.json();
        } catch (e) {
          bodyData = {};
        }
      }
    }

    const barkData = parseBarkRequest(request.url, method, bodyData);

    if (!barkData) {
      return createResponse({
        code: 400,
        message: "Invalid request"
      }, 400);
    }

    const deviceKey = barkData.device_key;
    console.log(`解析Bark数据: device_key=${deviceKey}`);

    const payload = buildMattermostPayload(barkData);

    if (!payload) {
      console.log(`空通知，不发送 (device_key: ${deviceKey})`);
      return createResponse({
        code: 200,
        message: "success",
        timestamp: Date.now()
      });
    }

    const baseUrlClean = baseUrl.replace(/\/$/, '');
    const mattermostUrl = `${baseUrlClean}/hooks/${deviceKey}`;

    const response = await fetch(mattermostUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`HTTP错误: ${response.status} - ${errorText}`);
      return createResponse({
        code: 500,
        message: `转发失败: HTTP ${response.status}`,
        detail: errorText,
        timestamp: Date.now()
      }, 500);
    }

    console.log(`转发成功: ${response.status}`);
    return createResponse({
      code: 200,
      message: "success",
      timestamp: Date.now()
    });

  } catch (error) {
    console.error(`处理请求失败: ${error.message}`);
    return createResponse({
      code: 500,
      message: `服务器错误: ${error.message}`,
      timestamp: Date.now()
    }, 500);
  }
}
