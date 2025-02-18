// API 地址
const API_BASE_URL = window.location.origin;

class NewsApp {
    constructor() {
        // 获取DOM元素
        this.categorySelect = document.getElementById('category');
        this.daysSelect = document.getElementById('days');
        this.refreshBtn = document.getElementById('refresh');
        this.newsList = document.getElementById('news-list');
        this.loading = document.getElementById('loading');
        this.error = document.getElementById('error');
        this.updateTime = document.getElementById('update-time');
        this.newsContainer = document.getElementById('news-container');

        // 添加分页按钮
        this.prevPageBtn = document.getElementById('prev-page');
        this.nextPageBtn = document.getElementById('next-page');
        this.currentPageSpan = document.getElementById('current-page');
        this.totalPagesSpan = document.getElementById('total-pages');

        // 初始化状态
        this.currentPage = 1;
        this.itemsPerPage = 10;
        this.totalPages = 1;
        this.allNews = [];

        // 初始化颜色映射
        this.categoryColors = new Map();

        // 预定义一些好看的颜色
        this.colorPalette = [
            '#1E88E5', '#43A047', '#FB8C00', '#E53935',
            '#5E35B1', '#00ACC1', '#7CB342', '#F4511E',
            '#3949AB', '#00897B', '#C0CA33', '#8E24AA'
        ];

        // 从 localStorage 获取数据和选择
        this.allNewsData = JSON.parse(localStorage.getItem('allNewsData')) || null;
        this.lastCategory = localStorage.getItem('lastCategory') || 'all';
        this.lastDays = localStorage.getItem('lastDays') || '90';

        // 设置初始选择
        this.categorySelect.value = this.lastCategory;
        this.daysSelect.value = this.lastDays;

        this.initializeEventListeners();
        this.initializeApp();
    }

    async initializeApp() {
        try {
            await this.loadCategories();
            if (!this.allNewsData || this.isDataExpired()) {
                await this.refresh();
            } else {
                this.updateTime.textContent = this.allNewsData.updateTime || '未知';
                this.filterAndDisplayNews();
            }
        } catch (error) {
            console.error('初始化失败:', error);
            this.showError('加载数据失败，请刷新页面重试');
        }
    }

    // 检查数据是否过期（30分钟）
    isDataExpired() {
        const lastUpdate = localStorage.getItem('lastUpdate');
        if (!lastUpdate) return true;
        return (Date.now() - parseInt(lastUpdate)) > 30 * 60 * 1000;
    }

    // 获取分类的颜色
    getCategoryColor(category) {
        if (!this.categoryColors.has(category)) {
            const unusedColors = this.colorPalette.filter(color =>
                !Array.from(this.categoryColors.values()).includes(color)
            );
            const color = unusedColors.length > 0
                ? unusedColors[0]
                : this.colorPalette[Math.floor(Math.random() * this.colorPalette.length)];
            this.categoryColors.set(category, color);
        }
        return this.categoryColors.get(category);
    }

    initializeEventListeners() {
        // 修改筛选事件，使用本地数据
        this.categorySelect.addEventListener('change', (e) => {
            console.log('分类改变:', e.target.value);
            localStorage.setItem('lastCategory', e.target.value);
            this.filterAndDisplayNews();
            this.updateURL();
        });

        this.daysSelect.addEventListener('change', (e) => {
            console.log('天数改变:', e.target.value);
            localStorage.setItem('lastDays', e.target.value);
            this.filterAndDisplayNews();
            this.updateURL();
        });

        this.refreshBtn.addEventListener('click', async () => {
            console.log('点击刷新按钮');
            await this.refresh();
        });

        this.prevPageBtn.addEventListener('click', () => this.changePage(-1));
        this.nextPageBtn.addEventListener('click', () => this.changePage(1));
    }

    showLoading() {
        this.loading.style.display = 'block';
        this.error.style.display = 'none';
        this.newsList.innerHTML = '';
    }

    hideLoading() {
        this.loading.style.display = 'none';
    }

    showError(message) {
        console.error('错误:', message);
        this.error.innerHTML = `
            <div class="error-message">${message}</div>
        `;
        this.error.style.display = 'block';
        this.hideLoading();
    }

    async fetchWithTimeout(url, options = {}, retries = 3) {
        const timeout = 10000;
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), timeout);
                
                const fullUrl = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
                console.log(`尝试请求 (${i + 1}/${retries}):`, fullUrl);
                
                const response = await fetch(fullUrl, {
                    ...options,
                    signal: controller.signal,
                    headers: {
                        'Cache-Control': 'no-cache',
                        ...options.headers
                    }
                });
                
                clearTimeout(id);
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                return response;
            } catch (error) {
                console.error(`请求失败 (尝试 ${i + 1}/${retries}):`, error);
                lastError = error;
                
                // 如果不是最后一次尝试，则等待后重试
                if (i < retries - 1) {
                    const waitTime = Math.min(1000 * Math.pow(2, i), 5000); // 指数退避，最多等待5秒
                    console.log(`等待 ${waitTime}ms 后重试...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }
        
        // 所有重试都失败后抛出最后一个错误
        throw lastError;
    }

    async loadCategories() {
        try {
            console.log('开始加载分类');
            const response = await this.fetchWithTimeout('/api/news/categories', {}, 3);
            const categories = await response.json();
            console.log('获取到的分类:', categories);

            // 清除现有选项（除了"全部栏目"）
            while (this.categorySelect.options.length > 1) {
                this.categorySelect.remove(1);
            }

            // 添加新的选项
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                this.categorySelect.appendChild(option);
            });

            console.log('分类加载完成');
        } catch (error) {
            console.error('加载分类失败:', error);
            this.showError(`加载栏目失败: ${error.message}`);
            throw error; // 重新抛出错误以便上层处理
        }
    }

    async refresh(retryCount = 3) {
        this.showLoading();
        try {
            const response = await this.fetchWithTimeout('/api/news/refresh', {}, retryCount);
            const data = await response.json();
            
            // 检查是否有抓取失败的分类
            if (data.errors && data.errors.length > 0) {
                const errorSources = data.errors.map(e => e.source).join(', ');
                const message = data.partialSuccess
                    ? `部分栏目（${errorSources}）抓取失败，其他栏目已更新`
                    : `所有栏目抓取失败（${errorSources}），请稍后重试`;
                
                this.showToast(message, 5000);
                
                // 如果完全失败，显示错误信息
                if (!data.partialSuccess) {
                    this.showError(message);
                    return;
                }
            }

            this.allNewsData = data;
            this.updateTime.textContent = data.updateTime || '未知';

            localStorage.setItem('allNewsData', JSON.stringify(data));
            localStorage.setItem('lastUpdate', Date.now().toString());

            this.filterAndDisplayNews();
            this.hideLoading();
        } catch (error) {
            console.error('刷新失败:', error);
            this.showError(`刷新新闻失败: ${error.message}`);
            this.hideLoading();
            
            // 添加重试按钮
            const retryButton = document.createElement('button');
            retryButton.textContent = '重试';
            retryButton.className = 'retry-btn';
            retryButton.onclick = () => this.refresh(retryCount);
            this.error.appendChild(retryButton);
        }
    }

    async fetchAllNews() {
        if (!this.allNewsData || this.isDataExpired()) {
            await this.refresh();
        } else {
            this.updateTime.textContent = this.allNewsData.updateTime || '未知';
            this.filterAndDisplayNews();
        }
    }

    // 根据当前筛选条件过滤和显示新闻
    filterAndDisplayNews() {
        if (!this.allNewsData || !this.allNewsData.allItems) {
            this.renderEmptyState();
            return;
        }

        const category = this.categorySelect.value;
        const days = parseInt(this.daysSelect.value);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        let filteredNews = this.allNewsData.allItems.filter(item => {
            const itemDate = new Date(item.date);
            return itemDate >= cutoffDate;
        });

        if (category !== 'all') {
            filteredNews = filteredNews.filter(item => item.source === category);
        }

        if (filteredNews.length === 0) {
            this.renderEmptyState();
            this.currentPage = 1;
            this.totalPages = 1;
            this.updatePagination();
        } else {
            this.allNews = filteredNews;
            this.totalPages = Math.ceil(this.allNews.length / this.itemsPerPage);
            if (this.currentPage > this.totalPages) {
                this.currentPage = 1;
            }
            this.renderCurrentPage();
        }
    }

    renderEmptyState() {
        this.newsList.innerHTML = `
            <div class="empty-state">
                <p>暂无内容</p>
                <p>当前筛选条件下没有找到任何新闻</p>
            </div>
        `;
    }

    // 修改 generateShareText 方法，使用 HTML 换行符
    generateShareText(item) {
        return `${item.title}\n\n发布时间：${item.date}\n来源：${item.source}\n链接：${item.url}\n\n——来自成信易通知`;
    }

    // 添加复制到剪贴板的方法
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.showToast('分享内容已复制到剪贴板');
        } catch (err) {
            console.error('复制失败:', err);
            this.showToast('复制失败，请手动复制');
        }
    }

    // 修改 showToast 方法支持自定义显示时间
    showToast(message, duration = 2000) {
        const toast = Object.assign(document.createElement('div'), {
            className: 'toast',
            textContent: message
        });

        // 如果已经存在 toast，先移除
        const existingToast = document.querySelector('.toast');
        if (existingToast) {
            existingToast.remove();
        }

        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // 修改 renderNews 方法
    renderNews(news) {
        const self = this;  // 保存 this 引用
        this.newsList.innerHTML = news.map(item => {
            const shareText = this.generateShareText(item)
                .replace(/\n/g, '\\n')  // 将换行符转换为字符串形式
                .replace(/'/g, "\\'");   // 处理单引号
            return `
                <li class="news-item">
                    <div class="news-header">
                        <h3 class="news-title">
                            <a href="${this.escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
                                ${this.escapeHtml(item.title)}
                            </a>
                        </h3>
                        <button class="share-btn" title="分享" data-share-text="${this.escapeHtml(shareText)}">
                            <svg viewBox="0 0 24 24" width="16" height="16">
                                <path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92zM18 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM6 13c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm12 7.02c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="news-meta">
                        <span class="news-source">
                            <span class="category-tag" style="background-color: ${this.getCategoryColor(item.source)}">
                                ${this.escapeHtml(item.source)}
                            </span>
                        </span>
                        <span class="news-date">${this.escapeHtml(item.date)}</span>
                    </div>
                </li>
            `;
        }).join('');

        // 添加分享按钮的事件监听器
        const shareButtons = this.newsList.querySelectorAll('.share-btn');
        shareButtons.forEach(button => {
            button.addEventListener('click', () => {
                const shareText = button.getAttribute('data-share-text')
                    .replace(/\\n/g, '\n');  // 将字符串形式的换行符转回真实换行符
                this.copyToClipboard(shareText);
            });
        });
    }

    changePage(delta) {
        this.currentPage += delta;
        this.renderCurrentPage();
    }

    renderCurrentPage() {
        const start = (this.currentPage - 1) * this.itemsPerPage;
        const end = start + this.itemsPerPage;
        const pageItems = this.allNews.slice(start, end);

        this.renderNews(pageItems);
        this.updatePagination();
    }

    updatePagination() {
        this.currentPageSpan.textContent = this.currentPage;
        this.totalPagesSpan.textContent = this.totalPages;
        this.prevPageBtn.disabled = this.currentPage === 1;
        this.nextPageBtn.disabled = this.currentPage === this.totalPages;
    }

    // 防止 XSS 攻击的辅助函数
    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // 添加更新 URL 的方法
    updateURL() {
        const params = new URLSearchParams();
        params.set('category', this.categorySelect.value);
        params.set('days', this.daysSelect.value);
        const newURL = `${window.location.pathname}?${params.toString()} `;
        window.history.pushState({}, '', newURL);
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM 加载完成，初始化应用');
    window.newsApp = new NewsApp();
});

// 添加全局错误处理
window.addEventListener('unhandledrejection', event => {
    console.error('未处理的 Promise 错误:', event.reason);
});

window.addEventListener('error', event => {
    console.error('全局错误:', event.error);
});

// 添加相应的 CSS 样式
const style = document.createElement('style');
style.textContent = `
.retry-btn {
    margin-top: 10px;
    padding: 8px 16px;
    background-color: var(--primary-color);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
}

.retry-btn:hover {
    background-color: var(--secondary-color);
}

.error-message {
    margin-bottom: 10px;
}

.toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(100px);
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 12px 24px;
    border-radius: 4px;
    font-size: 0.9rem;
    z-index: 1000;
    transition: transform 0.3s ease-out;
    max-width: 80%;
    text-align: center;
}
`;
document.head.appendChild(style);