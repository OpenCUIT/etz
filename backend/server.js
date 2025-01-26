const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const dayjs = require('dayjs');
const fs = require('fs/promises');
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
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        // 验证配置，防止缺失关键字段
        if (!config.days || !config.intervalMinutes || !config.outputPath || !Array.isArray(config.sources)) {
            throw new Error('配置文件缺少必需字段');
        }
        return config;
    } catch (error) {
        logger.error(`加载配置文件失败，使用默认配置: ${error.message}`);
        return {
            days: 3,
            intervalMinutes: 30,
            outputPath: 'news.json',
            sources: [
            ]
        };
    }
}

// 默认请求头
const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3"
};

// 抓取内容
async function fetchContent(sourceConfig, days = CONFIG.days) {
    const { url, title, dateSelector, itemSelector, titleSelector, hrefSelector } = sourceConfig;
    logger.info(`开始抓取 ${title} 的数据, URL: ${url}, 天数: ${days}`);
    try {
        const response = await axios.get(url, {
            headers: COMMON_HEADERS,
            timeout: 10000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }) // 忽略证书错误
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
                    logger.error(`处理单个项目时出错: ${err.message}`);
                }
            });

            logger.info(`${title} 抓取完成，获取到 ${result.length} 条数据`);
            return result;
        } else {
            logger.error(`页面访问失败: ${title}, 状态码: ${response.status}`);
            return [];
        }
    } catch (error) {
        logger.error(`${title} 抓取失败: ${error.message}`);
        return [];
    }
}

// 保存数据到文件
async function saveData(data) {
    try {
        await fs.writeFile(CONFIG.outputPath, JSON.stringify(data, null, 2));
        logger.info(`数据已保存到 ${CONFIG.outputPath}`);
    } catch (error) {
        logger.error(`保存数据失败: ${error.message}`);
    }
}

// 修改缓存机制，考虑查询参数
const NEWS_CACHE = {
    data: null,
    lastUpdate: null,
    categories: {}  // 按分类存储缓存
};

async function fetchAllData(forceRefresh = false, days = CONFIG.days) {
    const now = Date.now();
    const cacheAge = now - (NEWS_CACHE.lastUpdate || 0);
    const cacheTimeout = CONFIG.intervalMinutes * 60 * 1000;

    // 如果缓存存在且未过期，且不是强制刷新，则返回缓存数据
    if (!forceRefresh && NEWS_CACHE.data && cacheAge < cacheTimeout) {
        logger.info('使用缓存数据');
        return NEWS_CACHE.data;
    }

    logger.info(`开始获取新数据，天数: ${days}`);
    try {
        const results = await Promise.all(CONFIG.sources.map(source => fetchContent(source)));
        const allItems = results.flat();

        // 按日期降序排序
        allItems.sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());

        // 在这里根据天数过滤数据
        const cutoffDate = dayjs().subtract(days, 'day').startOf('day');
        const filteredItems = allItems.filter(item => dayjs(item.date).isAfter(cutoffDate));

        const data = {
            updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss'),
            total: filteredItems.length,
            allItems: filteredItems
        };

        // 更新缓存
        NEWS_CACHE.data = data;
        NEWS_CACHE.lastUpdate = now;

        logger.info(`数据获取完成，共 ${data.total} 条通知`);
        return data;
    } catch (error) {
        logger.error(`获取数据失败: ${error.message}`);
        if (NEWS_CACHE.data) {
            logger.info('返回缓存数据作为备份');
            return NEWS_CACHE.data;
        }
        throw error;
    }
}

async function main() {
    CONFIG = await loadConfig();
    const app = express();

    // 使用中间件
    app.use(cors());
    app.use(requestLogger);

    // 修改静态文件中间件配置
    app.use(express.static(path.join(__dirname, '../')));

    app.get('/', (req, res) => {
        return res.status(200).json({
            error: '服务器错误',
            message: err.message
        });
    });

    // 新闻接口
    app.get('/api/news', async (req, res) => {
        try {
            const { category, days } = req.query;
            const daysNum = parseInt(days) || CONFIG.days;
            logger.info(`处理新闻请求 - 分类: ${category || 'all'}, 天数: ${daysNum}`);

            // 参数验证
            if (days && (isNaN(daysNum) || daysNum < 1 || daysNum > 90)) {
                logger.warn(`无效的天数参数: ${days}`);
                return res.status(400).json({
                    error: '参数错误',
                    message: '天数必须是1到90之间的数字'
                });
            }

            // 获取数据时传入天数参数
            let data = await fetchAllData(false, daysNum);
            logger.info(`原始数据获取完成，共 ${data.allItems.length} 条`);

            // 根据分类过滤
            if (category && category !== 'all') {
                const beforeCount = data.allItems.length;
                data = {
                    ...data,
                    allItems: data.allItems.filter(item => item.source === category)
                };
                logger.info(`分类过滤: ${category}, 过滤前 ${beforeCount} 条，过滤后 ${data.allItems.length} 条`);
            }

            // 更新总数
            data.total = data.allItems.length;

            // 保存并返回数据
            await saveData(data);
            logger.info(`响应数据: 总计 ${data.total} 条通知`);
            res.json(data);
        } catch (error) {
            logger.error(`获取或保存数据出错: ${error.message}`);
            logger.error(error.stack);
            res.status(500).json({
                error: '服务器错误',
                message: error.message
            });
        }
    });

    // 刷新接口
    app.get('/api/news/refresh', async (req, res) => {
        try {
            logger.info('收到刷新请求');
            const data = await fetchAllData(true); // 强制刷新
            await saveData(data);
            logger.info(`刷新完成，获取到 ${data.total} 条通知`);
            res.json(data);
        } catch (error) {
            logger.error(`刷新数据出错: ${error.message}`);
            logger.error(error.stack);
            res.status(500).json({
                error: '服务器错误',
                message: error.message
            });
        }
    });

    // 分类接口
    app.get('/api/news/categories', async (req, res) => {
        try {
            logger.info('获取分类列表');
            const config = await loadConfig();
            const categories = config.sources.map(source => source.title);
            logger.info(`返回 ${categories.length} 个分类`);
            res.json(categories);
        } catch (error) {
            logger.error(`获取分类数据出错: ${error.message}`);
            logger.error(error.stack);
            res.status(500).json({
                error: '服务器错误',
                message: error.message
            });
        }
    });

    // 错误处理中间件
    app.use((err, req, res, next) => {
        logger.error('未捕获的错误:', err);
        res.status(500).json({
            error: '服务器错误',
            message: err.message
        });
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        logger.info(`服务器启动成功，监听端口 ${port}`);
    });

    // 初始数据获取
    try {
        const initialData = await fetchAllData();
        await saveData(initialData);
        logger.info(`初始数据获取完成，共 ${initialData.total} 条通知`);
    } catch (error) {
        logger.error(`初始数据获取失败: ${error.message}`);
    }
}

main().catch(error => {
    logger.error('服务器启动失败:', error);
    process.exit(1);
});