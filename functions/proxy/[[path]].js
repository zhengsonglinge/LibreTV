// functions/proxy/[[path]].js

// --- 配置 (现在从 Cloudflare 环境变量读取) ---
// 在 Cloudflare Pages 设置 -> 函数 -> 环境变量绑定 中设置以下变量:
// CACHE_TTL (例如 86400)
// MAX_RECURSION (例如 5)
// FILTER_DISCONTINUITY (不再需要，设为 false 或移除)
// USER_AGENTS_JSON (例如 ["UA1", "UA2"]) - JSON 字符串数组
// DEBUG (例如 false 或 true)
// --- 配置结束 ---

// --- 常量 (之前在 config.js 中，现在移到这里，因为它们与代理逻辑相关) ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];
// --- 常量结束 ---

const STREAM_SEGMENT_EXTENSIONS = [
    '.ts', '.m4s', '.mp4', '.m4v', '.m4a', '.webm', '.mkv', '.mov', '.flv',
    '.aac', '.mp3', '.ogg', '.wav', '.flac', '.opus'
];

function isDirectStreamSegment(targetUrl, contentType) {
    const lowerType = (contentType || '').toLowerCase();
    if (lowerType.startsWith('video/') || lowerType.startsWith('audio/')) {
        return true;
    }
    try {
        const pathname = new URL(targetUrl).pathname.toLowerCase();
        if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) {
            return false;
        }
        return STREAM_SEGMENT_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
        return false;
    }
}

// --- 二进制安全的响应读取辅助函数 ---
// 判断 Content-Type 是否为文本类（只有文本才可以用 text() 读取）
function isTextContentType(contentType) {
    if (!contentType) return false;
    const lower = contentType.toLowerCase();
    return lower.startsWith('text/') ||
        lower.includes('json') ||
        lower.includes('xml') ||
        lower.includes('javascript') ||
        lower.includes('mpegurl') ||
        lower.includes('x-mpegurl');
}

// 读取响应体：文本用 text()，二进制用 arrayBuffer()，避免图片等被 UTF-8 解码破坏
async function readResponseBody(response, contentType) {
    if (isTextContentType(contentType)) {
        return await response.text();
    }
    const buffer = await response.arrayBuffer();
    // 有些服务器会用 application/octet-stream 返回 M3U8，按内容头识别后转成文本
    const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 16))).trimStart();
    if (head.startsWith('#EXTM3U')) {
        return new TextDecoder().decode(buffer);
    }
    return buffer;
}

// ArrayBuffer <-> Base64（Workers 环境没有 Buffer）
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}


/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /proxy/* 的请求
 */
export async function onRequest(context) {
    const { request, env, next, waitUntil } = context; // next 和 waitUntil 可能需要
    const url = new URL(request.url);

    // --- 从环境变量读取配置 ---
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400'); // 默认 24 小时
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5'); // 默认 5 层
    // 广告过滤已移至播放器处理，代理不再执行
    let USER_AGENTS = [ // 提供一个基础的默认值
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    try {
        // 尝试从环境变量解析 USER_AGENTS_JSON
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsedAgents = JSON.parse(agentsJson);
            if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
                USER_AGENTS = parsedAgents;
            } else {
                 logDebug("环境变量 USER_AGENTS_JSON 格式无效或为空，使用默认值");
            }
        }
    } catch (e) {
        logDebug(`解析环境变量 USER_AGENTS_JSON 失败: ${e.message}，使用默认值`);
    }
    // --- 配置读取结束 ---


    // --- 辅助函数 ---

    // 输出调试日志 (需要设置 DEBUG: true 环境变量)
    function logDebug(message) {
        if (DEBUG_ENABLED) {
            console.log(`[Proxy Func] ${message}`);
        }
    }

    // 从请求路径中提取目标 URL
    function getTargetUrlFromPath(pathname) {
        // 路径格式: /proxy/经过编码的URL
        // 例如: /proxy/https%3A%2F%2Fexample.com%2Fplaylist.m3u8
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            // 解码
            let decodedUrl = decodeURIComponent(encodedUrl);

             // 简单检查解码后是否是有效的 http/https URL
             if (!decodedUrl.match(/^https?:\/\//i)) {
                 // 也许原始路径就没有编码？如果看起来像URL就直接用
                 if (encodedUrl.match(/^https?:\/\//i)) {
                     decodedUrl = encodedUrl;
                     logDebug(`Warning: Path was not encoded but looks like URL: ${decodedUrl}`);
                 } else {
                    logDebug(`无效的目标URL格式 (解码后): ${decodedUrl}`);
                    return null;
                 }
             }
             return decodedUrl;

        } catch (e) {
            logDebug(`解码目标URL时出错: ${encodedUrl} - ${e.message}`);
            return null;
        }
    }

    // 创建标准化的响应
    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        // 关键：添加 CORS 跨域头，允许前端 JS 访问代理后的响应
        responseHeaders.set("Access-Control-Allow-Origin", "*"); // 允许任何来源访问
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS"); // 允许的方法
        responseHeaders.set("Access-Control-Allow-Headers", "*"); // 允许所有请求头

        // 处理 CORS 预检请求 (OPTIONS) - 放在这里确保所有响应都处理
         if (request.method === "OPTIONS") {
             // 使用下面的 onOptions 函数可以更规范，但在这里处理也可以
             return new Response(null, {
                 status: 204, // No Content
                 headers: responseHeaders // 包含上面设置的 CORS 头
             });
         }

        return new Response(body, { status, headers: responseHeaders });
    }

    // 创建 M3U8 类型的响应
    function createM3u8Response(content) {
        return createResponse(content, 200, {
            "Content-Type": "application/vnd.apple.mpegurl", // M3U8 的标准 MIME 类型
            "Cache-Control": `public, max-age=${CACHE_TTL}` // 允许浏览器和CDN缓存
        });
    }

    // 获取随机 User-Agent
    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    // 获取 URL 的基础路径 (用于解析相对路径)
    function getBaseUrl(urlStr) {
        try {
            const parsedUrl = new URL(urlStr);
            // 如果路径是根目录，或者没有斜杠，直接返回 origin + /
            if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
                return `${parsedUrl.origin}/`;
            }
            const pathParts = parsedUrl.pathname.split('/');
            pathParts.pop(); // 移除文件名或最后一个路径段
            return `${parsedUrl.origin}${pathParts.join('/')}/`;
        } catch (e) {
            logDebug(`获取 BaseUrl 时出错: ${urlStr} - ${e.message}`);
            // 备用方法：找到最后一个斜杠
            const lastSlashIndex = urlStr.lastIndexOf('/');
            // 确保不是协议部分的斜杠 (http://)
            return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
        }
    }


    // 将相对 URL 转换为绝对 URL
    function resolveUrl(baseUrl, relativeUrl) {
        // 如果已经是绝对 URL，直接返回
        if (relativeUrl.match(/^https?:\/\//i)) {
            return relativeUrl;
        }
        try {
            // 使用 URL 对象来处理相对路径
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            logDebug(`解析 URL 失败: baseUrl=${baseUrl}, relativeUrl=${relativeUrl}, error=${e.message}`);
            // 简单的备用方法
            if (relativeUrl.startsWith('/')) {
                // 处理根路径相对 URL
                const urlObj = new URL(baseUrl);
                return `${urlObj.origin}${relativeUrl}`;
            }
            // 处理同级目录相对 URL
            return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`; // 确保baseUrl以 / 结尾
        }
    }

    // 将目标 URL 重写为内部代理路径 (/proxy/...)
    function rewriteUrlToProxy(targetUrl, options = {}) {
        const params = [];
        if (options.adFilter) params.push('adfilter=1');
        if (options.directSeg) params.push('direct_seg=1');
        const suffix = params.length > 0 ? `?${params.join('&')}` : '';
        return `/proxy/${encodeURIComponent(targetUrl)}${suffix}`;
    }

    // 发起上游请求（保留 Response 流，供流式透传或文本读取）
    async function fetchUpstreamResponse(targetUrl) {
        const targetHost = new URL(targetUrl).hostname;
        const headers = new Headers({
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            // 尝试传递一些原始请求的头信息
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            // 尝试设置 Referer 为目标网站的域名，或者传递原始 Referer
            'Referer': targetHost.endsWith('doubanio.com')
                ? 'https://movie.douban.com/'
                : request.headers.get('Referer') || new URL(targetUrl).origin
        });
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
            headers.set('Range', rangeHeader);
        }

        try {
            // 直接请求目标 URL
            logDebug(`开始直接请求: ${targetUrl}`);
            // Cloudflare Functions 的 fetch 默认支持重定向
            const response = await fetch(targetUrl, { headers, redirect: 'follow' });

            if (!response.ok) {
                 const errorBody = await response.text().catch(() => '');
                 logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
                 throw new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 150)}`);
            }

            return response;
        } catch (error) {
             logDebug(`请求彻底失败: ${targetUrl}: ${error.message}`);
            // 抛出更详细的错误
            throw new Error(`请求目标URL失败 ${targetUrl}: ${error.message}`);
        }
    }

    // 获取远程内容及其类型
    async function fetchContentWithType(targetUrl) {
        const response = await fetchUpstreamResponse(targetUrl);
        // 读取响应内容（文本/二进制分开处理）
        const contentType = response.headers.get('Content-Type') || '';
        const content = await readResponseBody(response, contentType);
        const contentLength = typeof content === 'string' ? content.length : content.byteLength;
        logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${contentLength}`);
        return { content, contentType, responseHeaders: response.headers };
    }

    // 判断是否是 M3U8 内容
    function isM3u8Content(content, contentType) {
        // 检查 Content-Type
        if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
            return true;
        }
        // 检查内容本身是否以 #EXTM3U 开头
        return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
    }

    // 判断是否是媒体文件 (根据扩展名和 Content-Type) - 这部分在此代理中似乎未使用，但保留
    function isMediaFile(url, contentType) {
        if (contentType) {
            for (const mediaType of MEDIA_CONTENT_TYPES) {
                if (contentType.toLowerCase().startsWith(mediaType)) {
                    return true;
                }
            }
        }
        const urlLower = url.toLowerCase();
        for (const ext of MEDIA_FILE_EXTENSIONS) {
            if (urlLower.endsWith(ext) || urlLower.includes(`${ext}?`)) {
                return true;
            }
        }
        return false;
    }

    // 处理 M3U8 中的 #EXT-X-KEY 行 (加密密钥)
    function processKeyLine(line, baseUrl, options = {}) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${options.directSeg ? absoluteUri : rewriteUrlToProxy(absoluteUri)}"`;
        });
    }

    // 处理 M3U8 中的 #EXT-X-MAP 行 (初始化片段)
    function processMapLine(line, baseUrl, options = {}) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${options.directSeg ? absoluteUri : rewriteUrlToProxy(absoluteUri)}"`;
        });
    }

    function isAdSegmentUrl(rawUrl) {
        if (!rawUrl) return false;
        try {
            const parsed = new URL(rawUrl, 'https://placeholder.invalid/');
            const tail = parsed.pathname.split('/').filter(Boolean).slice(-3);
            return tail.some(segment => {
                const base = segment.replace(/\.(?:ts|m4s|mp4|m4v|aac|m4a|cmfv|cmfa)$/i, '');
                return /^(?:ad|ads|adv|advert|adverts|adjump|adserver|adservice|guanggao|preroll|midroll|postroll)$/i.test(base)
                    || /^(?:ad|ads|adv|advert)[-_]?(?:pre|mid|post)?(?:roll|jump|clip|seg)?\d*$/i.test(base);
            });
        } catch {
            return false;
        }
    }

    function getSegmentSignature(rawUrl) {
        try {
            const parsed = new URL(rawUrl, 'https://placeholder.invalid/');
            const host = parsed.hostname === 'placeholder.invalid' ? '' : parsed.hostname.toLowerCase();
            const parts = parsed.pathname.split('/').filter(Boolean);
            const fileName = parts.pop() || '';
            const dir = parts.join('/');
            const stem = fileName.replace(/\.(?:ts|m4s|mp4|m4v|aac|m4a|cmfv|cmfa)$/i, '');
            const prefixMatch = stem.match(/^([a-zA-Z_-]+)\d+$/);
            const filePrefix = prefixMatch ? prefixMatch[1].toLowerCase() : '';
            return {
                dirKey: `${host}/${dir}`,
                prefixKey: `${host}/${dir}|${filePrefix}`
            };
        } catch {
            return { dirKey: '', prefixKey: '' };
        }
    }

    function filterAdsFromM3U8(m3u8Content, baseUrl) {
        if (!m3u8Content || typeof m3u8Content !== 'string') return m3u8Content || '';
        if (m3u8Content.includes('#EXT-X-STREAM-INF')) return m3u8Content;

        const lines = m3u8Content.split(/\r?\n/);
        const headerLines = [];
        const footerLines = [];
        const blocks = [];
        let currentBlock = null;
        let pendingSegmentLines = [];
        let pendingDuration = 0;
        let seenSegmentOrDisc = false;

        const ensureBlock = () => {
            if (!currentBlock) {
                currentBlock = {
                    segments: [],
                    totalDuration: 0,
                    hasExplicitAd: false,
                    dirCounts: new Map(),
                    prefixCounts: new Map(),
                    leadingTags: [],
                    lastKeyLine: '',
                    lastMapLine: ''
                };
                blocks.push(currentBlock);
            }
            return currentBlock;
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === '#EXT-X-ENDLIST') {
                footerLines.push(line);
                continue;
            }
            if (trimmed === '#EXT-X-DISCONTINUITY') {
                seenSegmentOrDisc = true;
                if (currentBlock && currentBlock.segments.length > 0) currentBlock = null;
                ensureBlock();
                continue;
            }
            if (trimmed.startsWith('#')) {
                if (!seenSegmentOrDisc && !trimmed.startsWith('#EXTINF') && !trimmed.startsWith('#EXT-X-BYTERANGE') && !trimmed.startsWith('#EXT-X-KEY') && !trimmed.startsWith('#EXT-X-MAP')) {
                    headerLines.push(line);
                    continue;
                }
                seenSegmentOrDisc = true;
                const block = ensureBlock();
                if (trimmed.startsWith('#EXTINF')) {
                    const m = trimmed.match(/^#EXTINF:\s*([\d.]+)/i);
                    pendingDuration = m ? parseFloat(m[1]) || 0 : 0;
                    pendingSegmentLines.push(line);
                } else if (trimmed.startsWith('#EXT-X-KEY')) {
                    block.lastKeyLine = line;
                    pendingSegmentLines.push(line);
                } else if (trimmed.startsWith('#EXT-X-MAP')) {
                    block.lastMapLine = line;
                    pendingSegmentLines.push(line);
                } else if (block.segments.length === 0 && pendingSegmentLines.length === 0) {
                    block.leadingTags.push(line);
                } else {
                    pendingSegmentLines.push(line);
                }
                continue;
            }

            seenSegmentOrDisc = true;
            const block = ensureBlock();
            const absUrl = resolveUrl(baseUrl, trimmed);
            const sig = getSegmentSignature(absUrl);
            const explicitAd = isAdSegmentUrl(absUrl);
            if (explicitAd) block.hasExplicitAd = true;
            block.segments.push({ uri: trimmed, duration: pendingDuration, lines: [...pendingSegmentLines, line], explicitAd, sig });
            block.totalDuration += pendingDuration;
            block.dirCounts.set(sig.dirKey, (block.dirCounts.get(sig.dirKey) || 0) + 1);
            block.prefixCounts.set(sig.prefixKey, (block.prefixCounts.get(sig.prefixKey) || 0) + 1);
            pendingSegmentLines = [];
            pendingDuration = 0;
        }

        const nonEmptyBlocks = blocks.filter(b => b.segments.length > 0);
        if (nonEmptyBlocks.length === 0) return m3u8Content;

        const globalDirDur = new Map();
        const globalPrefixDur = new Map();
        let totalDuration = 0;
        for (const block of nonEmptyBlocks) {
            totalDuration += block.totalDuration;
            for (const seg of block.segments) {
                const d = seg.duration || 1;
                globalDirDur.set(seg.sig.dirKey, (globalDirDur.get(seg.sig.dirKey) || 0) + d);
                globalPrefixDur.set(seg.sig.prefixKey, (globalPrefixDur.get(seg.sig.prefixKey) || 0) + d);
            }
        }

        const pickMax = (map) => {
            let best = '';
            let bestVal = -1;
            for (const [k, v] of map.entries()) {
                if (v > bestVal) { bestVal = v; best = k; }
            }
            return best;
        };

        const mainDirKey = pickMax(globalDirDur);
        const mainPrefixKey = pickMax(globalPrefixDur);

        const blockIsAd = nonEmptyBlocks.map((block, idx) => {
            if (block.hasExplicitAd) return true;
            if (nonEmptyBlocks.length < 2 || totalDuration < 120) return false;
            const isForeign = (mainDirKey && pickMax(block.dirCounts) !== mainDirKey)
                || (mainPrefixKey && pickMax(block.prefixCounts) !== mainPrefixKey);
            const isShort = block.totalDuration > 0 && block.totalDuration <= 65 && block.segments.length <= 20;
            if (isForeign && isShort) return true;

            const isSandwiched = idx > 0 && idx < nonEmptyBlocks.length - 1;
            if (isSandwiched && block.totalDuration >= 3 && block.totalDuration <= 35 && block.segments.length <= 12) {
                if (nonEmptyBlocks[idx - 1].totalDuration > block.totalDuration * 1.5
                    && nonEmptyBlocks[idx + 1].totalDuration > block.totalDuration * 1.5) {
                    return true;
                }
            }
            return false;
        });

        const output = [...headerLines];
        let dropped = 0;
        let kept = 0;
        let needDisc = false;
        let emitted = false;
        let activeKeyLine = '';
        let activeMapLine = '';

        nonEmptyBlocks.forEach((block, idx) => {
            if (blockIsAd[idx]) {
                dropped += block.segments.length;
                if (emitted) needDisc = true;
                return;
            }
            const hadAdBefore = needDisc;
            if (emitted) {
                output.push('#EXT-X-DISCONTINUITY');
                needDisc = false;
            }
            if (block.leadingTags.length > 0) output.push(...block.leadingTags);
            const startsWithKey = block.segments[0]?.lines.some(l => l.trim().startsWith('#EXT-X-KEY'));
            if (emitted && activeKeyLine && !startsWithKey && hadAdBefore) output.push(activeKeyLine);
            const startsWithMap = block.segments[0]?.lines.some(l => l.trim().startsWith('#EXT-X-MAP'));
            if (emitted && activeMapLine && !startsWithMap && hadAdBefore) output.push(activeMapLine);

            for (const seg of block.segments) {
                if (seg.explicitAd) { dropped += 1; continue; }
                output.push(...seg.lines);
                kept += 1;
            }
            if (block.lastKeyLine) activeKeyLine = block.lastKeyLine;
            if (block.lastMapLine) activeMapLine = block.lastMapLine;
            emitted = true;
        });

        if (footerLines.length > 0) output.push(...footerLines);
        if (kept === 0 && dropped > 0) return m3u8Content;
        return output.join('\n');
    }

    // 处理媒体 M3U8 播放列表 (包含视频/音频片段)
    function processMediaPlaylist(url, content, options = {}) {
        // 防御：若拿到二进制内容，先按 UTF-8 解码
        if (typeof content !== 'string') {
            content = new TextDecoder().decode(content);
        }
        const baseUrl = getBaseUrl(url);
        if (options.adFilter) {
            content = filterAdsFromM3U8(content, baseUrl);
        }
        const lines = content.split('\n');
        const output = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 保留最后的空行
            if (!line && i === lines.length - 1) {
                output.push(line);
                continue;
            }
            if (!line) continue; // 跳过中间的空行

            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl, options));
                continue;
            }
            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl, options));
                continue;
            }
            if (line.startsWith('#EXTINF')) {
                output.push(line);
                continue;
            }
            if (!line.startsWith('#')) {
                const absoluteUrl = resolveUrl(baseUrl, line);
                logDebug(`重写媒体片段: 原始='${line}', 绝对='${absoluteUrl}'`);
                output.push(options.directSeg ? absoluteUrl : rewriteUrlToProxy(absoluteUrl));
                continue;
            }
            // 其他 M3U8 标签直接添加
            output.push(line);
        }
        return output.join('\n');
    }

    // 递归处理 M3U8 内容
    async function processM3u8Content(targetUrl, content, recursionDepth = 0, env, options = {}) {
        if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
            logDebug(`检测到主播放列表: ${targetUrl}`);
            return await processMasterPlaylist(targetUrl, content, options);
        }
        logDebug(`检测到媒体播放列表: ${targetUrl}`);
        return processMediaPlaylist(targetUrl, content, options);
    }

    // 处理主 M3U8 播放列表：保留多码率档位供前端 hls.js / 原生 HLS 执行 ABR 自适应码率切换
    async function processMasterPlaylist(url, content, options = {}) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line && i === lines.length - 1) {
                output.push(line);
                continue;
            }
            if (!line) continue;

            if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                output.push(line.replace(/URI="([^"]+)"/, (match, uri) => {
                    const absoluteUri = resolveUrl(baseUrl, uri);
                    return `URI="${rewriteUrlToProxy(absoluteUri, options)}"`;
                }));
                continue;
            }

            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl, options));
                continue;
            }

            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl, options));
                continue;
            }

            if (!line.startsWith('#')) {
                const absoluteUrl = resolveUrl(baseUrl, line);
                output.push(rewriteUrlToProxy(absoluteUrl, options));
                continue;
            }

            output.push(line);
        }

        return output.join('\n');
    }

    // --- 主要请求处理逻辑 ---

    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);
        const m3u8Options = {
            adFilter: url.searchParams.get('adfilter') === '1',
            directSeg: url.searchParams.get('direct_seg') === '1'
        };

        if (!targetUrl) {
            logDebug(`无效的代理请求路径: ${url.pathname}`);
            return createResponse("无效的代理请求。路径应为 /proxy/<经过编码的URL>", 400);
        }

        logDebug(`收到代理请求: ${targetUrl}`);

        // 视频/音频分片直接流式透传，跳过 KV 读写与 arrayBuffer 整包缓冲，显著降低首字节延迟
        if (isDirectStreamSegment(targetUrl, '')) {
            const upstreamResponse = await fetchUpstreamResponse(targetUrl);
            const streamHeaders = new Headers(upstreamResponse.headers);
            streamHeaders.delete('content-encoding');
            streamHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            streamHeaders.set("Access-Control-Allow-Origin", "*");
            streamHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
            streamHeaders.set("Access-Control-Allow-Headers", "*");
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                headers: streamHeaders
            });
        }

        // --- 缓存检查 (KV) ---
        const cacheKey = `proxy_raw_v2:${targetUrl}`; // 使用原始内容的缓存键（v2: 二进制安全，避免命中旧坏缓存）
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV;
            if (!kvNamespace) throw new Error("KV 命名空间未绑定");
        } catch (e) {
            logDebug(`KV 命名空间 'LIBRETV_PROXY_KV' 访问出错或未绑定: ${e.message}`);
            kvNamespace = null;
        }

        if (kvNamespace) {
            try {
                const cachedDataJson = await kvNamespace.get(cacheKey); // 直接获取字符串
                if (cachedDataJson) {
                    logDebug(`[缓存命中] 原始内容: ${targetUrl}`);
                    const cachedData = JSON.parse(cachedDataJson); // 解析 JSON
                    const content = cachedData.binary
                        ? base64ToArrayBuffer(cachedData.body)
                        : cachedData.body;
                    let headers = {};
                    try { headers = JSON.parse(cachedData.headers); } catch(e){} // 解析头部
                    const contentType = headers['content-type'] || headers['Content-Type'] || '';

                    if (isM3u8Content(content, contentType)) {
                        logDebug(`缓存内容是 M3U8，重新处理: ${targetUrl}`);
                        const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, m3u8Options);
                        return createM3u8Response(processedM3u8);
                    } else {
                        logDebug(`从缓存返回非 M3U8 内容: ${targetUrl}`);
                        const cachedHeaders = new Headers(headers);
                        // fetch 已解压，原始长度/编码头不再适用
                        cachedHeaders.delete('content-encoding');
                        cachedHeaders.delete('content-length');
                        return createResponse(content, 200, cachedHeaders);
                    }
                } else {
                     logDebug(`[缓存未命中] 原始内容: ${targetUrl}`);
                 }
            } catch (kvError) {
                 logDebug(`从 KV 读取或解析缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 出错则继续执行，不影响功能
            }
        }

        // --- 实际请求 ---
        const upstreamResponse = await fetchUpstreamResponse(targetUrl);
        const contentType = upstreamResponse.headers.get('Content-Type') || '';
        if (isDirectStreamSegment(targetUrl, contentType)) {
            const streamHeaders = new Headers(upstreamResponse.headers);
            streamHeaders.delete('content-encoding');
            streamHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            streamHeaders.set("Access-Control-Allow-Origin", "*");
            streamHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
            streamHeaders.set("Access-Control-Allow-Headers", "*");
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                headers: streamHeaders
            });
        }
        const content = await readResponseBody(upstreamResponse, contentType);
        const responseHeaders = upstreamResponse.headers;

        // --- 写入缓存 (KV) ---
        if (kvNamespace) {
             try {
                 const headersToCache = {};
                 responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; });
                 const isBinary = content instanceof ArrayBuffer;
                 // KV 单值限制 25MB，过大的二进制内容不缓存
                 if (isBinary && content.byteLength > 10 * 1024 * 1024) {
                     logDebug(`内容过大，跳过 KV 缓存: ${targetUrl}`);
                 } else {
                     const cacheValue = {
                         body: isBinary ? arrayBufferToBase64(content) : content,
                         binary: isBinary,
                         headers: JSON.stringify(headersToCache)
                     };
                     // 注意 KV 写入限制
                     waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: CACHE_TTL }));
                     logDebug(`已将原始内容写入缓存: ${targetUrl}`);
                 }
            } catch (kvError) {
                 logDebug(`向 KV 写入缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 写入失败不影响返回结果
            }
        }

        // --- 处理响应 ---
        if (isM3u8Content(content, contentType)) {
            logDebug(`内容是 M3U8，开始处理: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, m3u8Options);
            return createM3u8Response(processedM3u8);
        } else {
            logDebug(`内容不是 M3U8 (类型: ${contentType})，直接返回: ${targetUrl}`);
            const finalHeaders = new Headers(responseHeaders);
            // fetch 已解压，原始长度/编码头不再适用（图片等二进制内容尤其重要）
            finalHeaders.delete('content-encoding');
            finalHeaders.delete('content-length');
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            // 添加 CORS 头，确保非 M3U8 内容也能跨域访问（例如图片、字幕文件等）
            finalHeaders.set("Access-Control-Allow-Origin", "*");
            finalHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
            finalHeaders.set("Access-Control-Allow-Headers", "*");
            return createResponse(content, 200, finalHeaders);
        }

    } catch (error) {
        logDebug(`处理代理请求时发生严重错误: ${error.message} \n ${error.stack}`);
        return createResponse(`代理处理错误: ${error.message}`, 500);
    }
}

// 处理 OPTIONS 预检请求的函数
export async function onOptions(context) {
    // 直接返回允许跨域的头信息
    return new Response(null, {
        status: 204, // No Content
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*", // 允许所有请求头
            "Access-Control-Max-Age": "86400", // 预检请求结果缓存一天
        },
    });
}
