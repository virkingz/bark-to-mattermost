// edge-functions/index.js// EdgeOne Functions - Bark to Mattermost

// 从环境变量获取配置（在EdgeOne控制台设置）
const MATTERMOST_WEBHOOK_BASE_URL = typeof process !== 'undefined' 
  ? process.env.MATTERMOST_WEBHOOK_BASE_URL 
  : '';

// 优先级映射
const LEVEL_MAP = {
  "active": "🔴 高优先级",
  "timeSensitive": "🟡 中优先级",
  "passive": "🔵 低优先级"
};

// 排除的路径
const EXCLUDED_PATHS = ["/", "/push", "/webhook", "/favicon.ico"];

/**
 * 构建Mattermost消息payload
 */
function buildMattermostPayload(barkData) {
  const title = barkData.title || "";
  const body = barkData.body || "";
  const lines = [];

  // 1. 优先级标识
  const level = barkData.level || "";
  if (level && LEVEL_MAP[level]) {
    lines.push(LEVEL_MAP[level]);
  }

  // 2. 标题
  if (title) {
    lines.push(`**${title}**`);
  }

  // 3. 正文
  if (body) {
    lines.push(body);
  }

  // 4. 徽章
  const badge = barkData.badge || "";
  if (badge) {
    lines.push(`徽章: ${badge}`);
  }

  // 5. 自动复制
  const copyText = barkData.copy || "";
  if (copyText) {
    lines.push(`📋 复制内容: \`${copyText}\``);
  }

  // 6. 声音
  const sound = barkData.sound || "";
  if (sound) {
    lines.push(`🔊 音效: ${sound}`);
  }

  // 7. 分组
  const group = barkData.group || "";
  if (group) {
    lines.push(`🏷️ 分组: ${group}`);
  }

  if (lines.length === 0) {
    return null;
  }

  let textContent = lines.join("\n");
  // 移除所有URL链接
  textContent = textContent.replace(/https?:\/\/\S+/g, '');
  // 清理多余的空行
  textContent = textContent.replace(/\n\s*\n+/g, '\n').trim();

  // 如果指定了markdown，使用markdown内容
  if (barkData.markdown) {
    textContent = barkData.markdown;
  }

  return { text: textContent };
}

/**
 * 解析Bark请求
 */
function parseBarkRequest(url, method, bodyData = null) {
  const urlObj = new URL(url);
  const path = urlObj.pathname;
  const queryParams = Object.fromEntries(urlObj.searchParams);

  // 解析路径
  const parts = path.replace(/^\//, '').split('/').filter(p => p.length > 0);
  
  if (parts.length === 0) {
    return null;
  }

  const deviceKey = parts[0];

  // 初始化bark数据
  const barkData = {
    title: "",
    body: "",
    device_key: deviceKey
  };

  // 处理查询参数
  if (queryParams.title) {
    barkData.title = decodeURIComponent(queryParams.title);
  }
  if (queryParams.body) {
    barkData.body = decodeURIComponent(queryParams.body);
  }

  // 其他参数
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

  // 处理路径参数
  if (parts.length > 1) {
    const pathContent = parts.slice(1).join('/');
    const decodedPath = decodeURIComponent(pathContent);

    // 如果查询参数中没有标题，尝试从路径中解析
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

  // 合并POST body数据
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

/**
 * 创建JSON响应
 */
function createResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

/**
 * 主请求处理函数
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 获取环境变量 - EdgeOne使用process.env
  const baseUrl = typeof process !== 'undefined' 
    ? process.env.MATTERMOST_WEBHOOK_BASE_URL 
    : '';

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

  // 检查环境变量
  if (!baseUrl) {
    console.error("MATTERMOST_WEBHOOK_BASE_URL environment variable not set");
    return createResponse({
      code: 500,
      message: "Server configuration error: MATTERMOST_WEBHOOK_BASE_URL not set"
    }, 500);
  }

  try {
    // 获取body数据
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

    // 解析Bark请求
    const barkData = parseBarkRequest(request.url, method, bodyData);

    if (!barkData) {
      return createResponse({
        code: 400,
        message: "Invalid request"
      }, 400);
    }

    const deviceKey = barkData.device_key;
    console.log(`解析Bark数据: device_key=${deviceKey}, title=${(barkData.title || '').substring(0, 50)}...`);

    // 构建Mattermost payload
    const payload = buildMattermostPayload(barkData);

    // 空通知不发送
    if (!payload) {
      console.log(`空通知，不发送到Mattermost (device_key: ${deviceKey})`);
      return createResponse({
        code: 200,
        message: "success",
        timestamp: Date.now()
      });
    }

    // 构建完整的webhook URL
    const baseUrlClean = baseUrl.replace(/\/$/, '');
    const mattermostUrl = `${baseUrlClean}/hooks/${deviceKey}`;

    console.log(`目标Mattermost URL: ${mattermostUrl}`);

    // 发送到Mattermost
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

// EdgeOne Functions 入口
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
