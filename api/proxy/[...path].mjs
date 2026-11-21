// /api/proxy/[...path].mjs - Vercel Serverless Function (ES Module)

import fetch from 'node-fetch';
import { URL } from 'url'; // 使用 Node.js 内置 URL 处理

// --- 配置 (从环境变量读取) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // 默认 24 小时
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10); // 默认 5 层

// --- User Agent 处理 ---
// 默认 User Agent 列表
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
// 尝试从环境变量读取并解析 USER_AGENTS_JSON
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        // 检查解析结果是否为非空数组
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents; // 使用环境变量中的数组
            console.log(`[代理日志] 已从环境变量加载 ${USER_AGENTS.length} 个 User Agent。`);
        } else {
            console.warn("[代理日志] 环境变量 USER_AGENTS_JSON 不是有效的非空数组，使用默认值。");
        }
    } else {
        console.log("[代理日志] 未设置环境变量 USER_AGENTS_JSON，使用默认 User Agent。");
    }
} catch (e) {
    // 如果 JSON 解析失败，记录错误并使用默认值
    console.error(`[代理日志] 解析环境变量 USER_AGENTS_JSON 出错: ${e.message}。使用默认 User Agent。`);
}

// 广告过滤在代理中禁用，由播放器处理
const FILTER_DISCONTINUITY = false;


// --- 辅助函数 ---

const STREAM_MEDIA_EXTENSIONS = [
    '.ts', '.m4s', '.mp4', '.m4v', '.m4a', '.webm', '.mkv', '.mov', '.flv',
    '.aac', '.mp3', '.ogg', '.wav', '.flac', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.ico'
];

function isDirectStreamMedia(targetUrl, contentType) {
    const lowerType = (contentType || '').toLowerCase();
    if (lowerType.startsWith('video/') || lowerType.startsWith('audio/') || lowerType.startsWith('image/')) {
        return true;
    }
    try {
        const pathname = new URL(targetUrl).pathname.toLowerCase();
        if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) {
            return false;
        }
        return STREAM_MEDIA_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
        return false;
    }
}

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
    const buffer = Buffer.from(await response.arrayBuffer());
    // 有些服务器会用 application/octet-stream 返回 M3U8，按内容头识别后转成文本
    if (buffer.subarray(0, 16).toString('utf8').trimStart().startsWith('#EXTM3U')) {
        return buffer.toString('utf8');
    }
    return buffer;
}

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[代理日志] ${message}`);
    }
}

/**
 * 从代理请求路径中提取编码后的目标 URL。
 * @param {string} encodedPath - URL 编码后的路径部分 (例如 "https%3A%2F%2F...")
 * @returns {string|null} 解码后的目标 URL，如果无效则返回 null。
 */
function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) {
        logDebug("getTargetUrlFromPath 收到空路径。");
        return null;
    }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        // 基础检查，看是否像一个 HTTP/HTTPS URL
        if (decodedUrl.match(/^https?:\/\/.+/i)) {
            return decodedUrl;
        } else {
            logDebug(`无效的解码 URL 格式: ${decodedUrl}`);
            // 备选检查：原始路径是否未编码但看起来像 URL？
            if (encodedPath.match(/^https?:\/\/.+/i)) {
                logDebug(`警告: 路径未编码但看起来像 URL: ${encodedPath}`);
                return encodedPath;
            }
            return null;
        }
    } catch (e) {
        // 捕获解码错误 (例如格式错误的 URI)
        logDebug(`解码目标 URL 出错: ${encodedPath} - ${e.message}`);
        return null;
    }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        // 处理根目录或只有文件名的情况
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean); // 移除空字符串
        if (pathSegments.length <= 1) {
            return `${parsedUrl.origin}/`;
        }
        pathSegments.pop(); // 移除最后一段
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`获取 BaseUrl 失败: "${urlStr}": ${e.message}`);
        // 备用方法：查找最后一个斜杠
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { // 确保不是协议部分的斜杠
            return urlStr.substring(0, lastSlashIndex + 1);
        }
        return urlStr + '/'; // 如果没有路径，添加斜杠
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; // 处理空的 relativeUrl
    if (relativeUrl.match(/^https?:\/\/.+/i)) {
        return relativeUrl; // 已经是绝对 URL
    }
    if (!baseUrl) return relativeUrl; // 没有基础 URL 无法解析

    try {
        // 使用 Node.js 的 URL 构造函数处理相对路径
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        logDebug(`URL 解析失败: base="${baseUrl}", relative="${relativeUrl}". 错误: ${e.message}`);
        // 简单的备用逻辑
        if (relativeUrl.startsWith('/')) {
             try {
                const baseOrigin = new URL(baseUrl).origin;
                return `${baseOrigin}${relativeUrl}`;
             } catch { return relativeUrl; } // 如果 baseUrl 也无效，返回原始相对路径
        } else {
            // 假设相对于包含基础 URL 资源的目录
            return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
        }
    }
}

// ** 已修正：确保生成 /proxy/ 前缀的链接 **
function rewriteUrlToProxy(targetUrl, options = {}) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    const params = [];
    if (options.adFilter) params.push('adfilter=1');
    if (options.directSeg) params.push('direct_seg=1');
    const suffix = params.length > 0 ? `?${params.join('&')}` : '';
    return `/proxy/${encodeURIComponent(targetUrl)}${suffix}`;
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchUpstreamResponse(targetUrl, requestHeaders) {
    const targetHost = new URL(targetUrl).hostname;
    // 准备请求头
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*', // 传递原始 Accept 头（如果有）
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        // 透传 Range 头，支持分片/MP4 拖动快进
        'Range': requestHeaders['range'],
        // 尝试设置一个合理的 Referer
        'Referer': targetHost.endsWith('doubanio.com')
            ? 'https://movie.douban.com/'
            : requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    // 清理空值的头
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});

    logDebug(`准备请求目标: ${targetUrl}，请求头: ${JSON.stringify(headers)}`);

    try {
        // 发起 fetch 请求
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });

        // 检查响应是否成功
        if (!response.ok) {
            const errorBody = await response.text().catch(() => ''); // 尝试获取错误响应体
            logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
            // 创建一个包含状态码的错误对象
            const err = new Error(`HTTP 错误 ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status; // 将状态码附加到错误对象
            throw err; // 抛出错误
        }

        return response;
    } catch (error) {
        // 捕获 fetch 本身的错误（网络、超时等）或上面抛出的 HTTP 错误
        logDebug(`请求异常 ${targetUrl}: ${error.message}`);
        // 重新抛出，确保包含原始错误信息
        throw new Error(`请求目标 URL 失败 ${targetUrl}: ${error.message}`);
    }
}

async function fetchContentWithType(targetUrl, requestHeaders) {
    const response = await fetchUpstreamResponse(targetUrl, requestHeaders);
    const contentType = response.headers.get('content-type') || '';
    const content = await readResponseBody(response, contentType);
    const contentLength = content.length;
    logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${contentLength}`);
    return { content, contentType, responseHeaders: response.headers };
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
        return true;
    }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl, options = {}) {
    return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${options.directSeg ? absoluteUri : rewriteUrlToProxy(absoluteUri)}"`;
    });
}

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

function processMediaPlaylist(url, content, options = {}) {
    // 防御：若拿到二进制内容，先按 UTF-8 解码
    if (Buffer.isBuffer(content)) {
        content = content.toString('utf8');
    }
    const baseUrl = getBaseUrl(url);
    if (!baseUrl) {
        logDebug(`无法确定媒体列表的 Base URL: ${url}，相对路径可能无法处理。`);
    }
    if (options.adFilter) {
        content = filterAdsFromM3U8(content, baseUrl);
    }
    const lines = content.split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 保留最后一个空行
        if (!line && i === lines.length - 1) { output.push(line); continue; }
        if (!line) continue; // 跳过中间空行
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl, options)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl, options)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        // 处理 URL 行：directSeg 模式直接输出原始 CDN 绝对地址，让 iPad/Safari 直连拉取 .ts 分片
        if (!line.startsWith('#')) {
            const absoluteUrl = resolveUrl(baseUrl, line);
            logDebug(`重写媒体片段: 原始='${line}', 解析后='${absoluteUrl}'`);
            output.push(options.directSeg ? absoluteUrl : rewriteUrlToProxy(absoluteUrl));
            continue;
        }
        // 保留其他 M3U8 标签
        output.push(line);
    }
    return output.join('\n');
}

async function processM3u8Content(targetUrl, content, recursionDepth = 0, options = {}) {
    // 判断是主列表还是媒体列表
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        logDebug(`检测到主播放列表: ${targetUrl} (深度: ${recursionDepth})`);
        return await processMasterPlaylist(targetUrl, content, options);
    }
    logDebug(`检测到媒体播放列表: ${targetUrl} (深度: ${recursionDepth})`);
    return processMediaPlaylist(targetUrl, content, options);
}

async function processMasterPlaylist(url, content, options = {}) {
    // 保留所有码率档位并仅重写子清单与音轨 URI，让前端 hls.js / 原生 HLS 正常执行 ABR 自适应码率切换，
    // 同时透传 adfilter/direct_seg 标志给子清单。
    if (Buffer.isBuffer(content)) {
        content = content.toString('utf8');
    }
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


// --- Vercel Handler 函数 ---
export default async function handler(req, res) {
    // --- 记录请求开始 ---
    console.info('--- Vercel 代理请求开始 ---');
    console.info('时间:', new Date().toISOString());
    console.info('方法:', req.method);
    console.info('URL:', req.url); // 原始请求 URL (例如 /proxy/...)
    console.info('查询参数:', JSON.stringify(req.query)); // Vercel 解析的查询参数

    // --- 提前设置 CORS 头 ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*'); // 允许所有请求头

    // --- 处理 OPTIONS 预检请求 ---
    if (req.method === 'OPTIONS') {
        console.info("处理 OPTIONS 预检请求");
        res.status(204).setHeader('Access-Control-Max-Age', '86400').end(); // 缓存预检结果 24 小时
        return;
    }

    let targetUrl = null; // 初始化目标 URL

    try { // ---- 开始主处理逻辑的 try 块 ----

        // --- 提取目标 URL (主要依赖 req.query["...path"]) ---
        // Vercel 将 :path* 捕获的内容（可能包含斜杠）放入 req.query["...path"] 数组
        const pathData = req.query["...path"]; // 使用正确的键名
        let encodedUrlPath = '';

        if (pathData) {
            if (Array.isArray(pathData)) {
                encodedUrlPath = pathData.join('/'); // 重新组合
                console.info(`从 req.query["...path"] (数组) 组合的编码路径: ${encodedUrlPath}`);
            } else if (typeof pathData === 'string') {
                encodedUrlPath = pathData; // 也处理 Vercel 可能只返回字符串的情况
                console.info(`从 req.query["...path"] (字符串) 获取的编码路径: ${encodedUrlPath}`);
            } else {
                console.warn(`[代理警告] req.query["...path"] 类型未知: ${typeof pathData}`);
            }
        } else {
            console.warn(`[代理警告] req.query["...path"] 为空或未定义。`);
            // 备选：尝试从 req.url 提取（如果需要）
            if (req.url && req.url.startsWith('/proxy/')) {
                encodedUrlPath = req.url.substring('/proxy/'.length);
                console.info(`使用备选方法从 req.url 提取的编码路径: ${encodedUrlPath}`);
            }
        }

        // 如果仍然为空，则无法继续
        if (!encodedUrlPath) {
             throw new Error("无法从请求中确定编码后的目标路径。");
        }

        // 解析目标 URL
        targetUrl = getTargetUrlFromPath(encodedUrlPath);
        console.info(`解析出的目标 URL: ${targetUrl || 'null'}`); // 记录解析结果

        // 检查目标 URL 是否有效
        if (!targetUrl) {
            // 抛出包含更多上下文的错误
            throw new Error(`无效的代理请求路径。无法从组合路径 "${encodedUrlPath}" 中提取有效的目标 URL。`);
        }

        console.info(`开始处理目标 URL 的代理请求: ${targetUrl}`);

        // --- 获取并处理目标内容 ---
        const upstreamResponse = await fetchUpstreamResponse(targetUrl, req.headers);
        const contentType = upstreamResponse.headers.get('content-type') || '';

        // 明确的视频/音频/图片分片直接流式透传，避免整包缓冲进内存拉高 TTFB
        if (isDirectStreamMedia(targetUrl, contentType) && upstreamResponse.body) {
            upstreamResponse.headers.forEach((value, key) => {
                const lowerKey = key.toLowerCase();
                if (!lowerKey.startsWith('access-control-') &&
                    lowerKey !== 'content-encoding' &&
                    lowerKey !== 'transfer-encoding' &&
                    lowerKey !== 'connection') {
                    res.setHeader(key, value);
                }
            });
            res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
            res.status(upstreamResponse.status || 200);
            await new Promise((resolve, reject) => {
                upstreamResponse.body.on('error', reject);
                res.on('close', resolve);
                res.on('finish', resolve);
                upstreamResponse.body.pipe(res);
            });
            return;
        }

        const content = await readResponseBody(upstreamResponse, contentType);
        const responseHeaders = upstreamResponse.headers;

        // --- 如果是 M3U8，处理并返回 ---
        if (isM3u8Content(content, contentType)) {
            const m3u8Options = {
                adFilter: req.query?.adfilter === '1',
                directSeg: req.query?.direct_seg === '1'
            };
            console.info(`正在处理 M3U8 内容: ${targetUrl}`, m3u8Options);
            const processedM3u8 = await processM3u8Content(targetUrl, content, 0, m3u8Options);

            console.info(`成功处理 M3U8: ${targetUrl}`);
            // 发送处理后的 M3U8 响应
            res.status(200)
                .setHeader('Content-Type', 'application/vnd.apple.mpegurl;charset=utf-8')
                .setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`)
                // 移除可能导致问题的原始响应头
                .removeHeader('content-encoding') // 很重要！node-fetch 已解压
                .removeHeader('content-length')   // 长度已改变
                .send(processedM3u8); // 发送 M3U8 文本

        } else {
            // --- 如果不是 M3U8，直接返回原始内容 ---
            console.info(`直接返回非 M3U8 内容: ${targetUrl}, 类型: ${contentType}`);

            // 设置原始响应头，但排除有问题的头和 CORS 头（已设置）
            responseHeaders.forEach((value, key) => {
                 const lowerKey = key.toLowerCase();
                 if (!lowerKey.startsWith('access-control-') &&
                     lowerKey !== 'content-encoding' && // 很重要！
                     lowerKey !== 'content-length') {   // 很重要！
                     res.setHeader(key, value); // 设置其他原始头
                 }
             });
            // 设置我们自己的缓存策略
            res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);

            // 发送原始（已解压）内容：Buffer 直发，避免 text() 破坏二进制图片
            res.status(200).end(content);
        }

    // ---- 结束主处理逻辑的 try 块 ----
    } catch (error) { // ---- 捕获处理过程中的任何错误 ----
        // **检查这个错误是否是 "Assignment to constant variable"**
        console.error(`[代理错误处理 V3] 捕获错误！目标: ${targetUrl || '解析失败'} | 错误类型: ${error.constructor.name} | 错误消息: ${error.message}`);
        console.error(`[代理错误堆栈 V3] ${error.stack}`); // 记录完整的错误堆栈信息

        // 特别标记 "Assignment to constant variable" 错误
        if (error instanceof TypeError && error.message.includes("Assignment to constant variable")) {
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
             console.error("捕获到 'Assignment to constant variable' 错误!");
             console.error("请再次检查函数代码及所有辅助函数中，是否有 const 声明的变量被重新赋值。");
             console.error("错误堆栈指向:", error.stack);
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        }

        // 尝试从错误对象获取状态码，否则默认为 500
        const statusCode = error.status || 500;

        // 确保在发送错误响应前没有发送过响应头
        if (!res.headersSent) {
             res.setHeader('Content-Type', 'application/json');
             // CORS 头应该已经在前面设置好了
             res.status(statusCode).json({
                success: false,
                error: `代理处理错误: ${error.message}`, // 返回错误消息给前端
                targetUrl: targetUrl // 包含目标 URL 以便调试
            });
        } else {
            // 如果响应头已发送，无法再发送 JSON 错误
            console.error("[代理错误处理 V3] 响应头已发送，无法发送 JSON 错误响应。");
            // 尝试结束响应
             if (!res.writableEnded) {
                 res.end();
             }
        }
    } finally {
         // 记录请求处理结束
         console.info('--- Vercel 代理请求结束 ---');
    }
}

// --- [确保所有辅助函数定义都在这里] ---
// getTargetUrlFromPath, getBaseUrl, resolveUrl, rewriteUrlToProxy, getRandomUserAgent,
// fetchContentWithType, isM3u8Content, processKeyLine, processMapLine,
// processMediaPlaylist, processM3u8Content, processMasterPlaylist
