const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const https = require('https');
const cors = require('cors');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// 配置 winston 日志记录
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'app.log' })
    ]
});

// 请求日志中间件
const requestLogger = (req, res, next) => {
    const start = Date.now();
    logger.info(`收到请求: ${req.method} ${req.url}`);
    if (Object.keys(req.query).length > 0) {
        logger.info(`请求参数: ${JSON.stringify(req.query)}`);
    }

    // 响应完成后记录
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info(`${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
    });

    next();
};

// 加载配置
async function loadConfig() {
    try {
        const data = await fs.promises.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        // 验证配置，防止缺失关键字段
        if (!config.days || !Array.isArray(config.sources)) {
            throw new Error('配置文件缺少必需字段');
        }
        return config;
    } catch (error) {
        logger.error(`加载配置文件失败，使用默认配置: ${error.message}`);
        return {
            days: 3,
            sources: [
            ]
        };
    }
}

// 默认请求头
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3"
};

// 抓取内容
async function fetchContent(sourceConfig, days = CONFIG.days) {
    const { url, title, dateSelector, itemSelector, titleSelector, hrefSelector, HEADERS } = sourceConfig;
    logger.info(`开始抓取 ${title} 的数据, URL: ${url}`);

    try {
        // 合并默认请求头和自定义请求头
        const headers = {
            ...DEFAULT_HEADERS,
            ...(HEADERS || {})  // 如果有自定义请求头，则覆盖默认值
        };

        const response = await axios.get(url, {
            headers,
            timeout: 10000,
            httpsAgent: new https.Agent({
                rejectUnauthorized: false,
                keepAlive: true  // 添加 keepAlive 支持
            }),
            maxRedirects: 5,  // 允许最多5次重定向
            validateStatus: status => status < 400  // 接受所有非4xx和5xx的状态码
        });

        if (response.status === 200) {
            const $ = cheerio.load(response.data);
            let result = [];

            $(itemSelector).each((index, element) => {
                try {
                    const dateElement = $(element).find(dateSelector);
                    if (!dateElement.length) {
                        logger.warn(`在 ${title} 中未找到日期元素，跳过此项`);
                        return;
                    }

                    const dateText = dateElement.text().trim();
                    const date = dayjs(dateText, ['YYYY/MM/DD', 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY年MM月DD日'], true);

                    if (!date.isValid()) {
                        logger.warn(`日期格式无效: ${dateText}, 来源: ${title}`);
                        return;
                    }

                    const titleElement = $(element).find(titleSelector);
                    const hrefElement = $(element).find(hrefSelector);

                    if (!titleElement.length || !hrefElement.length) {
                        logger.warn(`在 ${title} 中未找到标题或链接元素，跳过此项`);
                        return;
                    }

                    const href = new URL(hrefElement.attr('href'), url).href;
                    const text = titleElement.attr('title') || titleElement.text().trim();

                    result.push({
                        source: title,
                        title: text,
                        url: href,
                        date: date.format('YYYY-MM-DD')
                    });
                } catch (err) {
                    logger.error(`处理 ${title} 的单个项目时出错: ${err.message}`);
                }
            });

            if (result.length === 0) {
                logger.warn(`${title} 未找到任何有效数据`);
            } else {
                logger.info(`${title} 抓取完成，获取到 ${result.length} 条数据`);
            }
            return result;
        } else {
            throw new Error(`HTTP status: ${response.status}`);
        }
    } catch (error) {
        const errorMessage = error.response
            ? `HTTP status: ${error.response.status} - ${error.response.statusText || ''}`
            : error.message;
        logger.error(`${title} 抓取失败: ${errorMessage}`);
        throw new Error(`抓取失败 (${errorMessage})`);
    }
}


// 请求数据
async function fetchAllData(days = CONFIG.days) {
    logger.info(`开始获取新数据，天数: ${days}`);

    try {
        const errors = [];
        const results = await Promise.all(CONFIG.sources.map(async source => {
            try {
                return await fetchContent(source);
            } catch (error) {
                const errorMessage = `${source.title}: ${error.message}`;
                logger.error(errorMessage);
                errors.push({
                    source: source.title,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                return [];
            }
        }));

        const allItems = results.flat();
        allItems.sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());

        const cutoffDate = dayjs().subtract(days, 'day').startOf('day');
        const filteredItems = allItems.filter(item => dayjs(item.date).isAfter(cutoffDate));

        const data = {
            updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss'),
            total: filteredItems.length,
            allItems: filteredItems,
            errors: errors.length > 0 ? errors : undefined,
            partialSuccess: errors.length > 0 && filteredItems.length > 0
        };

        logger.info(`数据获取完成，共 ${data.total} 条通知，${errors.length} 个错误`);
        if (errors.length > 0) {
            logger.warn(`抓取失败的栏目: ${errors.map(e => e.source).join(', ')}`);
        }

        return data;
    } catch (error) {
        logger.error(`获取数据失败: ${error.message}`);
        throw error;
    }
}

async function main() {
    CONFIG = await loadConfig();
    const app = express();

    // 使用中间件
    app.use(cors());
    app.use(requestLogger);

    // 静态文件中间件 - 指定 index.html 作为默认文件
    app.use(express.static(path.join(__dirname, 'public'), {
        index: 'index.html'
    }));

    // API 路由
    app.get('/api/news/categories', async (req, res) => {
        try {
            logger.info('获取分类列表');
            const config = await loadConfig();
            const categories = config.sources.map(source => source.title);
            logger.info(`返回 ${categories.length} 个分类`);
            res.json(categories);
        } catch (error) {
            logger.error(`获取分类数据出错: ${error.message}`);
            res.status(500).json({
                error: '服务器错误',
                message: error.message
            });
        }
    });

    app.get('/api/news/refresh', async (req, res) => {
        try {
            logger.info('收到刷新请求');
            const data = await fetchAllData();
            logger.info(`刷新完成，获取到 ${data.total} 条通知`);
            res.json(data);
        } catch (error) {
            logger.error(`刷新数据出错: ${error.message}`);
            res.status(500).json({
                error: '服务器错误',
                message: error.message
            });
        }
    });

    // 处理所有其他请求，返回 index.html
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        logger.info(`服务器启动成功，http://127.0.0.1:${port}`);
    });
}

main().catch(error => {
    logger.error('服务器启动失败:', error);
    process.exit(1);
});