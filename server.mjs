import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import compression from 'compression';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 8080;

// 启用 CORS
app.use(cors());

// 启用响应压缩
app.use(compression());

// 静态文件路径
app.use(express.static('./', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const requestUrl = new URL(res.req?.originalUrl || '', 'http://localhost');
    const isHtml = filePath.endsWith('.html');
    const isServiceWorker = filePath.endsWith('service-worker.js');

    if (isHtml || isServiceWorker) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (requestUrl.searchParams.has('v')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    }
  }
}));

/*
app.get('/', async (req, res) => {
  try {
    const content = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
    res.send(content)
  } catch (error) {
    console.error(error)
    res.status(500).send('读取 index.html 失败')
  }
})
*/

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    // 获取 URL 编码的参数
    const encodedUrl = req.params.encodedUrl;
    
    // 对 URL 进行解码
    const targetUrl = decodeURIComponent(encodedUrl);
    
    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('Invalid URL');
    }

    const target = new URL(targetUrl);
    const requestHeaders = {};
    if (target.hostname.endsWith('doubanio.com')) {
      requestHeaders.Referer = 'https://movie.douban.com/';
      requestHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
    }

    // 发起请求
    const response = await axios({
      method: 'get',
      url: targetUrl,
      headers: requestHeaders,
      responseType: 'stream',
      timeout: 5000
    });

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    delete headers['content-security-policy'];
    delete headers['cookie'];
    res.set(headers);

    // 管道传输响应流
    response.data.pipe(res);
  } catch (error) {
    if (error.response) {
      error.response.data.pipe(res)
    } else {
      res.status(500).send(error.message)
    }
  }
});

// 安全验证：检查是否为合法 URL
const isValidUrl = (urlString) => {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    const blockedHostnames = ['localhost', '127.0.0.1'];
    
    return allowedProtocols.includes(parsed.protocol) &&
           !blockedHostnames.includes(parsed.hostname);
  } catch {
    return false;
  }
};

app.listen(port, () => {
  console.log(`服务器运行在 http://localhost:${port}`)
});

