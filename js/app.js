// 全局变量
let customAPIs = JSON.parse(localStorage.getItem('customAPIs') || '[]'); // 存储自定义API列表

// 默认启用全部非成人内置资源，以及用户已添加的自定义资源
const DEFAULT_SELECTED_APIS = [
    ...Object.keys(API_SITES).filter(apiId => !API_SITES[apiId].adult),
    ...customAPIs.map((_, index) => 'custom_' + index)
];
const LEGACY_DEFAULT_SELECTED_APIS = ['dyttzy', 'bfzy', 'ruyi'];
const DEFAULT_SOURCES_VERSION = 'all-sources-v1';

function getInitialSelectedAPIs() {
    const storedSelection = localStorage.getItem('selectedAPIs');
    if (!storedSelection) {
        return { apis: [...DEFAULT_SELECTED_APIS], needsPersist: true };
    }

    try {
        const parsedSelection = JSON.parse(storedSelection);
        if (Array.isArray(parsedSelection)) {
            return { apis: parsedSelection, needsPersist: false };
        }
    } catch (error) {
        console.warn('读取已选资源失败，将使用全部资源作为默认值:', error);
    }

    return { apis: [...DEFAULT_SELECTED_APIS], needsPersist: true };
}

const initialSelection = getInitialSelectedAPIs();
let selectedAPIs = initialSelection.apis;
let needsSelectionPersist = initialSelection.needsPersist;

// 将旧版本残留的默认三源选择迁移为全选，保留用户明确设置过的其他组合
if (localStorage.getItem('hasInitializedDefaults') === 'true') {
    const isLegacyDefault = selectedAPIs.length === LEGACY_DEFAULT_SELECTED_APIS.length &&
        LEGACY_DEFAULT_SELECTED_APIS.every(apiId => selectedAPIs.includes(apiId));
    if (isLegacyDefault) {
        selectedAPIs = [...DEFAULT_SELECTED_APIS];
        needsSelectionPersist = true;
    }
    localStorage.setItem('hasInitializedDefaults', DEFAULT_SOURCES_VERSION);
}

const previousSelectedAPIs = [...selectedAPIs];
selectedAPIs = selectedAPIs.filter(apiId => apiId.startsWith('custom_') || Boolean(API_SITES[apiId]));
if (needsSelectionPersist || selectedAPIs.length !== previousSelectedAPIs.length) {
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
}

let activeSearchRun = null;
let searchRunSequence = 0;

const SEARCH_RESULT_BANNED_TYPES = ['伦理片', '福利', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒', 'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG', '网红主播', '色情片', '同性片', '福利视频', '福利片'];

// 添加当前播放的集数索引
let currentEpisodeIndex = 0;
// 添加当前视频的所有集数
let currentEpisodes = [];
// 添加当前视频的标题
let currentVideoTitle = '';
// 全局变量用于倒序状态
let episodesReversed = false;

// 页面初始化
document.addEventListener('DOMContentLoaded', function () {
    // 设置首次访问的默认选项，必须在渲染复选框之前完成
    if (!localStorage.getItem('hasInitializedDefaults')) {
        selectedAPIs = [...DEFAULT_SELECTED_APIS];
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

        // 默认选中过滤开关
        localStorage.setItem('yellowFilterEnabled', 'true');
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true');

        // 默认启用豆瓣功能
        localStorage.setItem('doubanEnabled', 'true');

        // 标记已初始化默认值
        localStorage.setItem('hasInitializedDefaults', DEFAULT_SOURCES_VERSION);
    }

    // 初始化API复选框
    initAPICheckboxes();

    // 初始化自定义API列表
    renderCustomAPIsList();

    // 初始化显示选中的API数量
    updateSelectedApiCount();

    // 渲染搜索历史
    renderSearchHistory();

    // 设置黄色内容过滤开关初始状态
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.checked = localStorage.getItem('yellowFilterEnabled') === 'true';
    }

    // 设置广告过滤开关初始状态
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true
    }

    // 设置事件监听器
    setupEventListeners();

    // 初始检查成人API选中状态
    setTimeout(checkAdultAPIsSelected, 100);
});

// 初始化API复选框
function initAPICheckboxes() {
    const container = document.getElementById('apiCheckboxes');
    container.innerHTML = '';

    // 添加普通API组标题
    const normaldiv = document.createElement('div');
    normaldiv.id = 'normaldiv';
    normaldiv.className = 'settings-api-grid';
    const normalTitle = document.createElement('div');
    normalTitle.className = 'api-group-title';
    normalTitle.textContent = '普通资源';
    normaldiv.appendChild(normalTitle);

    // 创建普通API源的复选框
    Object.keys(API_SITES).forEach(apiKey => {
        const api = API_SITES[apiKey];
        if (api.adult) return; // 跳过成人内容API，稍后添加

        const checked = selectedAPIs.includes(apiKey);

        const checkbox = document.createElement('div');
        checkbox.className = 'flex items-center';
        checkbox.innerHTML = `
            <input type="checkbox" id="api_${apiKey}" 
                   class="form-checkbox h-3 w-3 text-blue-600 bg-[#222] border border-[#333]" 
                   ${checked ? 'checked' : ''} 
                   data-api="${apiKey}">
            <label for="api_${apiKey}" class="ml-1 text-xs text-gray-400 truncate">${api.name}</label>
        `;
        normaldiv.appendChild(checkbox);

        // 添加事件监听器
        checkbox.querySelector('input').addEventListener('change', function () {
            updateSelectedAPIs();
            checkAdultAPIsSelected();
        });
    });
    container.appendChild(normaldiv);

    // 添加成人API列表
    addAdultAPI();

    // 初始检查成人内容状态
    checkAdultAPIsSelected();
}

// 添加成人API列表
function addAdultAPI() {
    // 仅在隐藏设置为false时添加成人API组
    if (!HIDE_BUILTIN_ADULT_APIS && (localStorage.getItem('yellowFilterEnabled') === 'false')) {
        const container = document.getElementById('apiCheckboxes');

        // 添加成人API组标题
        const adultdiv = document.createElement('div');
        adultdiv.id = 'adultdiv';
        adultdiv.className = 'settings-api-grid';
        const adultTitle = document.createElement('div');
        adultTitle.className = 'api-group-title adult';
        adultTitle.innerHTML = `黄色资源采集站 <span class="adult-warning">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
        </span>`;
        adultdiv.appendChild(adultTitle);

        // 创建成人API源的复选框
        Object.keys(API_SITES).forEach(apiKey => {
            const api = API_SITES[apiKey];
            if (!api.adult) return; // 仅添加成人内容API

            const checked = selectedAPIs.includes(apiKey);

            const checkbox = document.createElement('div');
            checkbox.className = 'flex items-center';
            checkbox.innerHTML = `
                <input type="checkbox" id="api_${apiKey}" 
                       class="form-checkbox h-3 w-3 text-blue-600 bg-[#222] border border-[#333] api-adult" 
                       ${checked ? 'checked' : ''} 
                       data-api="${apiKey}">
                <label for="api_${apiKey}" class="ml-1 text-xs text-pink-400 truncate">${api.name}</label>
            `;
            adultdiv.appendChild(checkbox);

            // 添加事件监听器
            checkbox.querySelector('input').addEventListener('change', function () {
                updateSelectedAPIs();
                checkAdultAPIsSelected();
            });
        });
        container.appendChild(adultdiv);
    }
}

// 检查是否有成人API被选中
function checkAdultAPIsSelected() {
    // 查找所有内置成人API复选框
    const adultBuiltinCheckboxes = document.querySelectorAll('#apiCheckboxes .api-adult:checked');

    // 查找所有自定义成人API复选框
    const customApiCheckboxes = document.querySelectorAll('#customApisList .api-adult:checked');

    const hasAdultSelected = adultBuiltinCheckboxes.length > 0 || customApiCheckboxes.length > 0;

    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    const yellowFilterContainer = yellowFilterToggle.closest('div').parentNode;
    const filterDescription = yellowFilterContainer.querySelector('p.filter-description');

    // 如果选择了成人API，禁用黄色内容过滤器
    if (hasAdultSelected) {
        yellowFilterToggle.checked = false;
        yellowFilterToggle.disabled = true;
        localStorage.setItem('yellowFilterEnabled', 'false');

        // 添加禁用样式
        yellowFilterContainer.classList.add('filter-disabled');

        // 修改描述文字
        if (filterDescription) {
            filterDescription.innerHTML = '<strong class="text-pink-300">选中黄色资源站时无法启用此过滤</strong>';
        }

        // 移除提示信息（如果存在）
        const existingTooltip = yellowFilterContainer.querySelector('.filter-tooltip');
        if (existingTooltip) {
            existingTooltip.remove();
        }
    } else {
        // 启用黄色内容过滤器
        yellowFilterToggle.disabled = false;
        yellowFilterContainer.classList.remove('filter-disabled');

        // 恢复原来的描述文字
        if (filterDescription) {
            filterDescription.innerHTML = '过滤"伦理片"等黄色内容';
        }

        // 移除提示信息
        const existingTooltip = yellowFilterContainer.querySelector('.filter-tooltip');
        if (existingTooltip) {
            existingTooltip.remove();
        }
    }
}

// 渲染自定义API列表
function renderCustomAPIsList() {
    const container = document.getElementById('customApisList');
    if (!container) return;

    if (customAPIs.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-500 text-center my-2">未添加自定义API</p>';
        return;
    }

    container.innerHTML = '';
    customAPIs.forEach((api, index) => {
        const apiItem = document.createElement('div');
        apiItem.className = 'flex items-center justify-between p-1 mb-1 bg-[#222] rounded';

        // 根据是否是成人内容设置不同的样式
        const textColorClass = api.isAdult ? 'text-pink-400' : 'text-white';

        // 将(18+)标记移到最前面
        const adultTag = api.isAdult ? '<span class="text-xs text-pink-400 mr-1">(18+)</span>' : '';

        apiItem.innerHTML = `
            <div class="flex items-center flex-1 min-w-0">
                <input type="checkbox" id="custom_api_${index}" 
                       class="form-checkbox h-3 w-3 text-blue-600 mr-1 ${api.isAdult ? 'api-adult' : ''}" 
                       ${selectedAPIs.includes('custom_' + index) ? 'checked' : ''} 
                       data-custom-index="${index}">
                <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium ${textColorClass} truncate">
                        ${adultTag}${api.name}
                    </div>
                    <div class="text-xs text-gray-500 truncate">${api.url}</div>
                </div>
            </div>
            <div class="flex items-center">
                <button class="text-blue-500 hover:text-blue-700 text-xs px-1" onclick="editCustomApi(${index})">✎</button>
                <button class="text-red-500 hover:text-red-700 text-xs px-1" onclick="removeCustomApi(${index})">✕</button>
            </div>
        `;
        container.appendChild(apiItem);

        // 添加事件监听器
        apiItem.querySelector('input').addEventListener('change', function () {
            updateSelectedAPIs();
            checkAdultAPIsSelected();
        });
    });
}

// 编辑自定义API
function editCustomApi(index) {
    if (index < 0 || index >= customAPIs.length) return;

    const api = customAPIs[index];

    // 填充表单数据
    const nameInput = document.getElementById('customApiName');
    const urlInput = document.getElementById('customApiUrl');
    const isAdultInput = document.getElementById('customApiIsAdult');

    nameInput.value = api.name;
    urlInput.value = api.url;
    if (isAdultInput) isAdultInput.checked = api.isAdult || false;

    // 显示表单
    const form = document.getElementById('addCustomApiForm');
    if (form) {
        form.classList.remove('hidden');

        // 替换表单按钮操作
        const buttonContainer = form.querySelector('div:last-child');
        buttonContainer.innerHTML = `
            <button onclick="updateCustomApi(${index})" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs">更新</button>
            <button onclick="cancelEditCustomApi()" class="bg-[#444] hover:bg-[#555] text-white px-3 py-1 rounded text-xs">取消</button>
        `;
    }
}

// 更新自定义API
function updateCustomApi(index) {
    if (index < 0 || index >= customAPIs.length) return;

    const nameInput = document.getElementById('customApiName');
    const urlInput = document.getElementById('customApiUrl');
    const isAdultInput = document.getElementById('customApiIsAdult');

    const name = nameInput.value.trim();
    let url = urlInput.value.trim();
    const isAdult = isAdultInput ? isAdultInput.checked : false;

    if (!name || !url) {
        showToast('请输入API名称和链接', 'warning');
        return;
    }

    // 确保URL格式正确
    if (!/^https?:\/\/.+/.test(url)) {
        showToast('API链接格式不正确，需以http://或https://开头', 'warning');
        return;
    }

    // 移除URL末尾的斜杠
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    // 更新API信息
    customAPIs[index] = { name, url, isAdult };
    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));

    // 重新渲染自定义API列表
    renderCustomAPIsList();

    // 重新检查成人API选中状态
    checkAdultAPIsSelected();

    // 恢复添加按钮
    restoreAddCustomApiButtons();

    // 清空表单并隐藏
    nameInput.value = '';
    urlInput.value = '';
    if (isAdultInput) isAdultInput.checked = false;
    document.getElementById('addCustomApiForm').classList.add('hidden');

    showToast('已更新自定义API: ' + name, 'success');
}

// 取消编辑自定义API
function cancelEditCustomApi() {
    // 清空表单
    document.getElementById('customApiName').value = '';
    document.getElementById('customApiUrl').value = '';
    const isAdultInput = document.getElementById('customApiIsAdult');
    if (isAdultInput) isAdultInput.checked = false;

    // 隐藏表单
    document.getElementById('addCustomApiForm').classList.add('hidden');

    // 恢复添加按钮
    restoreAddCustomApiButtons();
}

// 恢复自定义API添加按钮
function restoreAddCustomApiButtons() {
    const form = document.getElementById('addCustomApiForm');
    const buttonContainer = form.querySelector('div:last-child');
    buttonContainer.innerHTML = `
        <button onclick="addCustomApi()" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs">添加</button>
        <button onclick="cancelAddCustomApi()" class="bg-[#444] hover:bg-[#555] text-white px-3 py-1 rounded text-xs">取消</button>
    `;
}

// 更新选中的API列表
function updateSelectedAPIs() {
    // 获取所有内置API复选框
    const builtInApiCheckboxes = document.querySelectorAll('#apiCheckboxes input:checked');

    // 获取选中的内置API
    const builtInApis = Array.from(builtInApiCheckboxes).map(input => input.dataset.api);

    // 获取选中的自定义API
    const customApiCheckboxes = document.querySelectorAll('#customApisList input:checked');
    const customApiIndices = Array.from(customApiCheckboxes).map(input => 'custom_' + input.dataset.customIndex);

    // 合并内置和自定义API
    selectedAPIs = [...builtInApis, ...customApiIndices];

    // 保存到localStorage
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 更新显示选中的API数量
    updateSelectedApiCount();
}

// 更新选中的API数量显示
function updateSelectedApiCount() {
    const countEl = document.getElementById('selectedApiCount');
    if (countEl) {
        countEl.textContent = selectedAPIs.length;
    }
}

// 全选或取消全选API
function selectAllAPIs(selectAll = true, excludeAdult = false) {
    const checkboxes = document.querySelectorAll('#apiCheckboxes input[type="checkbox"]');

    checkboxes.forEach(checkbox => {
        if (excludeAdult && checkbox.classList.contains('api-adult')) {
            checkbox.checked = false;
        } else {
            checkbox.checked = selectAll;
        }
    });

    updateSelectedAPIs();
    checkAdultAPIsSelected();
}

// 显示添加自定义API表单
function showAddCustomApiForm() {
    const form = document.getElementById('addCustomApiForm');
    if (form) {
        form.classList.remove('hidden');
    }
}

// 取消添加自定义API - 修改函数来重用恢复按钮逻辑
function cancelAddCustomApi() {
    const form = document.getElementById('addCustomApiForm');
    if (form) {
        form.classList.add('hidden');
        document.getElementById('customApiName').value = '';
        document.getElementById('customApiUrl').value = '';
        const isAdultInput = document.getElementById('customApiIsAdult');
        if (isAdultInput) isAdultInput.checked = false;

        // 确保按钮是添加按钮
        restoreAddCustomApiButtons();
    }
}

// 添加自定义API
function addCustomApi() {
    const nameInput = document.getElementById('customApiName');
    const urlInput = document.getElementById('customApiUrl');
    const isAdultInput = document.getElementById('customApiIsAdult');

    const name = nameInput.value.trim();
    let url = urlInput.value.trim();
    const isAdult = isAdultInput ? isAdultInput.checked : false;

    if (!name || !url) {
        showToast('请输入API名称和链接', 'warning');
        return;
    }

    // 确保URL格式正确
    if (!/^https?:\/\/.+/.test(url)) {
        showToast('API链接格式不正确，需以http://或https://开头', 'warning');
        return;
    }

    // 移除URL末尾的斜杠
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    // 添加到自定义API列表 - 增加isAdult属性
    customAPIs.push({ name, url, isAdult });
    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));

    // 默认选中新添加的API
    const newApiIndex = customAPIs.length - 1;
    selectedAPIs.push('custom_' + newApiIndex);
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 重新渲染自定义API列表
    renderCustomAPIsList();

    // 更新选中的API数量
    updateSelectedApiCount();

    // 重新检查成人API选中状态
    checkAdultAPIsSelected();

    // 清空表单并隐藏
    nameInput.value = '';
    urlInput.value = '';
    if (isAdultInput) isAdultInput.checked = false;
    document.getElementById('addCustomApiForm').classList.add('hidden');

    showToast('已添加自定义API: ' + name, 'success');
}

// 移除自定义API
function removeCustomApi(index) {
    if (index < 0 || index >= customAPIs.length) return;

    const apiName = customAPIs[index].name;

    // 从列表中移除API
    customAPIs.splice(index, 1);
    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));

    // 从选中列表中移除此API
    const customApiId = 'custom_' + index;
    selectedAPIs = selectedAPIs.filter(id => id !== customApiId);

    // 更新大于此索引的自定义API索引
    selectedAPIs = selectedAPIs.map(id => {
        if (id.startsWith('custom_')) {
            const currentIndex = parseInt(id.replace('custom_', ''));
            if (currentIndex > index) {
                return 'custom_' + (currentIndex - 1);
            }
        }
        return id;
    });

    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 重新渲染自定义API列表
    renderCustomAPIsList();

    // 更新选中的API数量
    updateSelectedApiCount();

    // 重新检查成人API选中状态
    checkAdultAPIsSelected();

    showToast('已移除自定义API: ' + apiName, 'info');
}

// 设置事件监听器
function setupEventListeners() {
    // 回车搜索
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            search();
        }
    });

    // 点击外部关闭设置面板
    document.addEventListener('click', function (e) {
        const panel = document.getElementById('settingsPanel');
        const settingsButton = document.querySelector('button[onclick="toggleSettings(event)"]');

        if (!panel.contains(e.target) && !settingsButton.contains(e.target) && panel.classList.contains('show')) {
            panel.classList.remove('show');
        }
    });

    // 黄色内容过滤开关事件绑定
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.addEventListener('change', function (e) {
            localStorage.setItem('yellowFilterEnabled', e.target.checked);

            // 控制黄色内容接口的显示状态
            const adultdiv = document.getElementById('adultdiv');
            if (adultdiv) {
                if (e.target.checked === true) {
                    adultdiv.style.display = 'none';
                } else if (e.target.checked === false) {
                    adultdiv.style.display = ''
                }
            } else {
                // 添加成人API列表
                addAdultAPI();
            }
        });
    }

    // 广告过滤开关事件绑定
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.addEventListener('change', function (e) {
            localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, e.target.checked);
        });
    }
}

// 重置搜索区域
function resetSearchArea() {
    abortActiveSearch();
    setSearchButtonBusy(false);

    // 清理搜索结果
    document.getElementById('results').innerHTML = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResultsCount').textContent = '0';
    const resultsFooter = document.getElementById('resultsFooter');
    const resultsStatus = document.getElementById('searchResultsStatus');
    const loadMoreButton = document.getElementById('loadMoreResults');
    if (resultsFooter) resultsFooter.classList.add('hidden');
    if (resultsStatus) resultsStatus.textContent = '';
    if (loadMoreButton) loadMoreButton.classList.add('hidden');

    // 恢复搜索区域的样式
    document.getElementById('searchArea').classList.add('flex-1');
    document.getElementById('searchArea').classList.remove('mb-8');
    document.getElementById('searchArea').classList.remove('is-compact');
    document.getElementById('resultsArea').classList.add('hidden');

    // 确保页脚正确显示，移除相对定位
    const footer = document.querySelector('.footer');
    if (footer) {
        footer.style.position = '';
    }

    // 如果有豆瓣功能，检查是否需要显示豆瓣推荐区域
    if (typeof updateDoubanVisibility === 'function') {
        updateDoubanVisibility();
    }
}

// 获取自定义API信息
function getCustomApiInfo(customApiIndex) {
    const index = parseInt(customApiIndex);
    if (isNaN(index) || index < 0 || index >= customAPIs.length) {
        return null;
    }
    return customAPIs[index];
}

function isCurrentSearchRun(run) {
    return Boolean(run && activeSearchRun === run);
}

function setSearchButtonBusy(isBusy) {
    const button = document.querySelector('.search-submit');
    if (!button) return;
    button.disabled = isBusy;
    button.classList.toggle('is-busy', isBusy);
    button.setAttribute('aria-busy', String(isBusy));
}

function abortActiveSearch() {
    if (!activeSearchRun) return;
    clearTimeout(activeSearchRun.deadlineId);
    activeSearchRun.controller.abort();
    activeSearchRun = null;
}

function shouldIncludeSearchResult(item) {
    if (localStorage.getItem('yellowFilterEnabled') !== 'true') {
        return true;
    }
    const typeName = String(item.type_name || '');
    return !SEARCH_RESULT_BANNED_TYPES.some(keyword => typeName.includes(keyword));
}

function getSearchResultKey(item) {
    const source = item.source_code || '';
    const id = String(item.vod_id || '').trim();
    const name = String(item.vod_name || '').trim();
    return id ? `${source}|${id}` : `${source}|${name}|${item.vod_year || ''}`;
}

function normalizeSearchText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

function getCharacterBigrams(value) {
    if (!value) return [];
    if (value.length === 1) return [value];

    const bigrams = [];
    for (let index = 0; index < value.length - 1; index += 1) {
        bigrams.push(value.slice(index, index + 2));
    }
    return bigrams;
}

function calculateDiceSimilarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;

    const leftBigrams = getCharacterBigrams(left);
    const rightBigrams = getCharacterBigrams(right);
    if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;

    const counts = new Map();
    leftBigrams.forEach(bigram => {
        counts.set(bigram, (counts.get(bigram) || 0) + 1);
    });

    let overlap = 0;
    rightBigrams.forEach(bigram => {
        const count = counts.get(bigram) || 0;
        if (count > 0) {
            overlap += 1;
            counts.set(bigram, count - 1);
        }
    });

    return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function scoreNormalizedText(query, text) {
    if (!query || !text) return 0;
    if (text === query) return 1;
    if (text.startsWith(query)) return 0.92;
    if (text.includes(query)) return 0.84;
    if (query.includes(text) && text.length >= 2) return 0.76;
    return calculateDiceSimilarity(query, text) * 0.7;
}

function calculateSearchSimilarity(query, item) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return 0;

    const titleScore = scoreNormalizedText(
        normalizedQuery,
        normalizeSearchText(item.vod_name)
    );
    const aliasScore = Math.max(
        scoreNormalizedText(normalizedQuery, normalizeSearchText(item.vod_sub)),
        scoreNormalizedText(normalizedQuery, normalizeSearchText(item.vod_en))
    );
    const metadataScore = Math.max(
        scoreNormalizedText(normalizedQuery, normalizeSearchText(item.vod_actor)),
        scoreNormalizedText(normalizedQuery, normalizeSearchText(item.vod_director)),
        scoreNormalizedText(normalizedQuery, normalizeSearchText(item.vod_tag)),
        scoreNormalizedText(normalizedQuery, normalizeSearchText(item.vod_class))
    );

    return titleScore * 1000 + aliasScore * 20 + metadataScore * 10;
}

function sortSearchResultsByRelevance(results, query) {
    return results
        .map((item, index) => ({
            item,
            index,
            score: calculateSearchSimilarity(query, item),
            titleLength: normalizeSearchText(item.vod_name).length
        }))
        .sort((left, right) =>
            right.score - left.score ||
            left.titleLength - right.titleLength ||
            left.index - right.index
        )
        .map(entry => entry.item);
}

function renderSearchCard(item) {
    const safeId = item.vod_id ? item.vod_id.toString().replace(/[^\w-]/g, '') : '';
    const safeName = (item.vod_name || '').toString()
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const sourceInfo = item.source_name ?
        `<span class="source-badge">${item.source_name}</span>` : '';
    const sourceCode = item.source_code || '';
    const safeRemarks = (item.vod_remarks || '暂无简介').toString().replace(/</g, '&lt;');
    const safeType = (item.type_name || '').toString().replace(/</g, '&lt;');
    const metaParts = [safeType, item.vod_year].filter(Boolean);
    const apiUrlAttr = item.api_url ?
        `data-api-url="${item.api_url.replace(/"/g, '&quot;')}"` : '';
    const hasCover = item.vod_pic && item.vod_pic.startsWith('http');

    return `
        <article class="search-card" ${apiUrlAttr}>
            <div class="poster-frame" onclick="showDetails('${safeId}','${safeName}','${sourceCode}')">
                ${hasCover ? `
                    <img src="${item.vod_pic}" alt="${safeName}"
                         onerror="this.closest('.poster-frame').classList.add('is-missing'); this.remove();"
                         loading="lazy">
                ` : `
                    <div class="poster-placeholder">${safeName}</div>
                `}
            </div>
            <button class="poster-title" onclick="showDetails('${safeId}','${safeName}','${sourceCode}')" title="${safeName}">${safeName}</button>
            <p class="search-card-summary">${safeRemarks}</p>
            <div class="search-card-footer">
                ${sourceInfo || '<span class="source-badge">未标记来源</span>'}
                <span>${metaParts.join(' · ')}</span>
            </div>
        </article>
    `;
}

function updateSearchResultSummary(run) {
    const count = document.getElementById('searchResultsCount');
    const footer = document.getElementById('resultsFooter');
    const status = document.getElementById('searchResultsStatus');
    const loadMoreButton = document.getElementById('loadMoreResults');
    if (!count || !footer || !status || !loadMoreButton) return;

    count.textContent = run.results.length;
    footer.classList.remove('hidden');

    const remaining = run.results.length - run.renderedCount;
    const sourceSummary = run.completed
        ? `已从 ${run.settledSources}/${run.totalSources} 个来源汇总`
        : `正在从 ${run.settledSources}/${run.totalSources} 个来源汇总`;
    status.textContent = remaining > 0
        ? `已显示 ${run.renderedCount} / ${run.results.length} 条，${sourceSummary}`
        : `已显示 ${run.results.length} 条，${sourceSummary}`;

    if (run.completed && run.timedOut) {
        status.textContent += '，部分来源未在限时内返回';
    }
    if (run.truncated) {
        status.textContent += `，已达到 ${AGGREGATED_SEARCH_CONFIG.maxResults} 条上限`;
    }

    loadMoreButton.classList.toggle('hidden', remaining <= 0);
}

function revealSearchResults() {
    const searchArea = document.getElementById('searchArea');
    searchArea.classList.remove('flex-1');
    searchArea.classList.add('mb-8');
    searchArea.classList.add('is-compact');

    const resultsArea = document.getElementById('resultsArea');
    resultsArea.classList.remove('hidden');
    resultsArea.setAttribute('aria-busy', 'true');

    const doubanArea = document.getElementById('doubanArea');
    if (doubanArea) {
        doubanArea.classList.add('hidden');
    }
}

function resetSearchResultUi() {
    document.getElementById('results').innerHTML = '';
    document.getElementById('searchResultsCount').textContent = '0';
    document.getElementById('resultsFooter').classList.add('hidden');
    document.getElementById('searchResultsStatus').textContent = '';
    document.getElementById('loadMoreResults').classList.add('hidden');
    revealSearchResults();
}

function flushSearchResults(run) {
    if (!isCurrentSearchRun(run)) return;

    const target = Math.min(run.results.length, run.renderLimit);
    if (target > run.renderedCount) {
        const items = run.results.slice(run.renderedCount, target);
        const buffer = document.createElement('div');
        buffer.innerHTML = items.map(renderSearchCard).join('');

        const fragment = document.createDocumentFragment();
        while (buffer.firstChild) {
            fragment.appendChild(buffer.firstChild);
        }
        document.getElementById('results').appendChild(fragment);
        run.renderedCount = target;
        hideLoading();
    }

    updateSearchResultSummary(run);
}

function appendSearchResults(run, results) {
    if (!isCurrentSearchRun(run) || !run.acceptResults) return;

    for (const item of results) {
        if (run.results.length >= AGGREGATED_SEARCH_CONFIG.maxResults) {
            run.truncated = true;
            break;
        }
        if (!shouldIncludeSearchResult(item)) continue;

        const key = getSearchResultKey(item);
        if (run.seenKeys.has(key)) continue;
        run.seenKeys.add(key);
        run.results.push(item);
    }

    updateSearchResultSummary(run);
}

function finalizeSearchResults(run) {
    if (!isCurrentSearchRun(run)) return;

    clearTimeout(run.deadlineId);
    run.deadlineId = null;
    run.completed = true;
    run.acceptResults = false;

    run.results = sortSearchResultsByRelevance(run.results, run.query);
    flushSearchResults(run);

    if (run.results.length === 0) {
        document.getElementById('results').innerHTML = `
            <div class="empty-state">
                <div>
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <circle cx="11" cy="11" r="6.5" stroke-width="1.5"></circle>
                        <path d="m16 16 4 4" stroke-width="1.5" stroke-linecap="round"></path>
                    </svg>
                    <h3>${run.timedOut ? '搜索等待超时' : '没有找到匹配的结果'}</h3>
                    <p>${run.timedOut ? '部分来源响应较慢，请稍后重试' : '请尝试其他关键词，或在设置中增加数据源'}</p>
                </div>
            </div>
        `;
    }

    document.getElementById('resultsArea').setAttribute('aria-busy', 'false');
    updateSearchResultSummary(run);
    hideLoading();
    setSearchButtonBusy(false);
}

function loadMoreSearchResults() {
    const run = activeSearchRun;
    if (!isCurrentSearchRun(run)) return;
    run.renderLimit = Math.min(
        AGGREGATED_SEARCH_CONFIG.maxResults,
        run.renderLimit + AGGREGATED_SEARCH_CONFIG.renderBatchSize
    );
    flushSearchResults(run);
}

async function searchApiSource(apiId, query, run) {
    let apiUrl;
    let apiName;

    if (apiId.startsWith('custom_')) {
        const customApi = getCustomApiInfo(apiId.replace('custom_', ''));
        if (!customApi) return [];
        apiUrl = customApi.url + API_CONFIG.search.path + encodeURIComponent(query);
        apiName = customApi.name;
    } else {
        if (!API_SITES[apiId]) return [];
        apiUrl = API_SITES[apiId].api + API_CONFIG.search.path + encodeURIComponent(query);
        apiName = API_SITES[apiId].name;
    }

    const requestController = new AbortController();
    const timeoutId = setTimeout(() => requestController.abort(), AGGREGATED_SEARCH_CONFIG.timeout);
    const abortFromSearch = () => requestController.abort();
    if (run.controller.signal.aborted) {
        requestController.abort();
    } else {
        run.controller.signal.addEventListener('abort', abortFromSearch, { once: true });
    }

    try {
        const response = await fetch(PROXY_URL + encodeURIComponent(apiUrl), {
            headers: API_CONFIG.search.headers,
            signal: requestController.signal
        });

        if (!response.ok) return [];
        const data = await response.json();
        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }

        return data.list.slice(0, AGGREGATED_SEARCH_CONFIG.maxResults).map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
        }));
    } catch (error) {
        if (!run.controller.signal.aborted) {
            console.warn(`API ${apiId} 搜索失败:`, error);
        }
        return [];
    } finally {
        clearTimeout(timeoutId);
        run.controller.signal.removeEventListener('abort', abortFromSearch);
    }
}

async function search() {
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }

    const query = document.getElementById('searchInput').value.trim();
    if (!query) {
        showToast('请输入搜索内容', 'info');
        return;
    }
    if (selectedAPIs.length === 0) {
        showToast('请至少选择一个API源', 'warning');
        return;
    }

    abortActiveSearch();
    const run = {
        id: ++searchRunSequence,
        query,
        controller: new AbortController(),
        results: [],
        seenKeys: new Set(),
        settledSources: 0,
        totalSources: selectedAPIs.length,
        renderedCount: 0,
        renderLimit: AGGREGATED_SEARCH_CONFIG.initialRenderLimit,
        deadlineId: null,
        completed: false,
        timedOut: false,
        truncated: false,
        acceptResults: true
    };

    activeSearchRun = run;
    setSearchButtonBusy(true);
    showLoading('正在汇总结果…');
    resetSearchResultUi();

    try {
        saveSearchHistory(query);

        run.deadlineId = setTimeout(() => {
            if (!isCurrentSearchRun(run)) return;
            run.timedOut = true;
            run.acceptResults = false;
            run.controller.abort();
            finalizeSearchResults(run);
        }, AGGREGATED_SEARCH_CONFIG.totalTimeout);

        const searchPromises = selectedAPIs.map(apiId =>
            searchApiSource(apiId, query, run)
                .then(results => {
                    appendSearchResults(run, results);
                })
                .finally(() => {
                    if (!isCurrentSearchRun(run) || !run.acceptResults) return;
                    run.settledSources += 1;
                    updateSearchResultSummary(run);
                })
        );

        await Promise.allSettled(searchPromises);
        finalizeSearchResults(run);
    } catch (error) {
        if (isCurrentSearchRun(run)) {
            console.error('搜索错误:', error);
            showToast('搜索请求失败，请稍后重试', 'error');
        }
    } finally {
        if (isCurrentSearchRun(run) && !run.completed) {
            finalizeSearchResults(run);
        }
    }
}

// 显示详情 - 修改为支持自定义API
async function showDetails(id, vod_name, sourceCode) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }

    showLoading();
    try {
        // 构建API参数
        let apiParams = '';

        // 处理自定义API源
        if (sourceCode.startsWith('custom_')) {
            const customIndex = sourceCode.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) {
                showToast('自定义API配置无效', 'error');
                hideLoading();
                return;
            }

            apiParams = '&customApi=' + encodeURIComponent(customApi.url) + '&source=custom';
        } else {
            // 内置API
            apiParams = '&source=' + sourceCode;
        }

        const response = await fetch('/api/detail?id=' + encodeURIComponent(id) + apiParams);

        const data = await response.json();

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modalTitle');
        const modalContent = document.getElementById('modalContent');

        // 显示来源信息
        const sourceName = data.videoInfo && data.videoInfo.source_name ?
            ` <span class="text-sm font-normal text-gray-400">(${data.videoInfo.source_name})</span>` : '';

        // 不对标题进行截断处理，允许完整显示
        modalTitle.innerHTML = `<span class="break-words">${vod_name || '未知视频'}</span>${sourceName}`;
        currentVideoTitle = vod_name || '未知视频';

        if (data.episodes && data.episodes.length > 0) {
            // 安全处理集数URL
            const safeEpisodes = data.episodes.map(url => {
                try {
                    // 确保URL是有效的并且是http或https开头
                    return url && (url.startsWith('http://') || url.startsWith('https://'))
                        ? url.replace(/"/g, '&quot;')
                        : '';
                } catch (e) {
                    return '';
                }
            }).filter(url => url); // 过滤掉空URL

            // 保存当前视频的所有集数
            currentEpisodes = safeEpisodes;
            episodesReversed = false; // 默认正序
            modalContent.innerHTML = `
                <div class="flex justify-end mb-2">
                    <button onclick="toggleEpisodeOrder('${sourceCode}')" class="px-4 py-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white font-semibold rounded-full shadow-lg hover:shadow-xl transition-all duration-300 transform flex items-center justify-center space-x-2">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V7z" clip-rule="evenodd" />
                        </svg>
                        <span>倒序排列</span>
                    </button>
                </div>
                <div id="episodesGrid" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                    ${renderEpisodes(vod_name, sourceCode)}
                </div>
            `;
        } else {
            modalContent.innerHTML = '<p class="text-center text-gray-400 py-8">没有找到可播放的视频</p>';
        }

        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    } catch (error) {
        console.error('获取详情错误:', error);
        showToast('获取详情失败，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}

function extractEpisodesFromPlayUrl(playUrl) {
    if (!playUrl || typeof playUrl !== 'string') return [];

    const mainSource = playUrl.split('$$$')[0] || '';
    return mainSource
        .split('#')
        .map(episode => episode.split('$')[1])
        .map(url => String(url || '').trim())
        .filter(url => /^https?:\/\//.test(url));
}

function buildPlayerSourceCandidates(title, results) {
    const normalizedTitle = normalizeSearchText(title);
    if (!normalizedTitle || !Array.isArray(results)) return [];

    const candidatesBySource = new Map();
    results.forEach(item => {
        const sourceCode = String(item.source_code || '');
        if (!sourceCode) return;

        const titleScore = scoreNormalizedText(
            normalizedTitle,
            normalizeSearchText(item.vod_name)
        );
        if (titleScore < 0.55) return;

        const current = candidatesBySource.get(sourceCode);
        if (current && current.titleScore >= titleScore) return;

        candidatesBySource.set(sourceCode, {
            source_code: sourceCode,
            source_name: item.source_name || '',
            vod_id: String(item.vod_id || ''),
            vod_name: item.vod_name || title,
            episodes: extractEpisodesFromPlayUrl(item.vod_play_url),
            api_url: item.api_url || '',
            titleScore
        });
    });

    return Array.from(candidatesBySource.values()).map(candidate => ({
        source_code: candidate.source_code,
        source_name: candidate.source_name,
        vod_id: candidate.vod_id,
        vod_name: candidate.vod_name,
        episodes: candidate.episodes,
        api_url: candidate.api_url
    }));
}

function rememberPlayerSourceCandidates(title) {
    if (!title || !activeSearchRun || !Array.isArray(activeSearchRun.results)) return;

    const items = buildPlayerSourceCandidates(title, activeSearchRun.results);
    try {
        if (items.length === 0) {
            sessionStorage.removeItem(PLAYER_SOURCE_CACHE_CONFIG.storageKey);
            return;
        }
        sessionStorage.setItem(PLAYER_SOURCE_CACHE_CONFIG.storageKey, JSON.stringify({
            version: PLAYER_SOURCE_CACHE_CONFIG.version,
            title,
            timestamp: Date.now(),
            items
        }));
    } catch (error) {
        console.warn('保存播放页片源结果失败:', error);
    }
}

// 更新播放视频函数，修改为在新标签页中打开播放页面，并保存到历史记录
function playVideo(url, vod_name, sourceCode, episodeIndex = 0) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    if (!url) {
        showToast('无效的视频链接', 'error');
        return;
    }

    // 获取当前视频来源名称（从模态框标题中提取）
    let sourceName = '';
    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) {
        const sourceSpan = modalTitle.querySelector('span.text-gray-400');
        if (sourceSpan) {
            // 提取括号内的来源名称, 例如从 "(黑木耳)" 提取 "黑木耳"
            const sourceText = sourceSpan.textContent;
            const match = sourceText.match(/\(([^)]+)\)/);
            if (match && match[1]) {
                sourceName = match[1].trim();
            }
        }
    }

    // 保存当前状态到localStorage，让播放页面可以获取
    const currentVideoTitle = vod_name;
    localStorage.setItem('currentVideoTitle', currentVideoTitle);
    localStorage.setItem('currentEpisodeIndex', episodeIndex);
    localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
    localStorage.setItem('episodesReversed', episodesReversed);

    // 构建视频信息对象，使用标题作为唯一标识
    const videoTitle = vod_name || currentVideoTitle;
    rememberPlayerSourceCandidates(videoTitle);
    const videoInfo = {
        title: videoTitle,
        url: url,
        episodeIndex: episodeIndex,
        sourceName: sourceName,
        timestamp: Date.now(),
        // 重要：将完整的剧集信息也添加到历史记录中
        episodes: currentEpisodes && currentEpisodes.length > 0 ? [...currentEpisodes] : []
    };

    // 保存到观看历史，添加sourceName
    if (typeof addToViewingHistory === 'function') {
        addToViewingHistory(videoInfo);
    }

    // 构建播放页面URL，传递必要参数
    const playerUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(videoTitle)}&index=${episodeIndex}&source=${encodeURIComponent(sourceName)}&source_code=${encodeURIComponent(sourceCode)}`;

    // 在当前标签页中打开播放页面
    window.location.href = playerUrl;
}

// 播放上一集
function playPreviousEpisode(sourceCode) {
    if (currentEpisodeIndex > 0) {
        const prevIndex = currentEpisodeIndex - 1;
        const prevUrl = currentEpisodes[prevIndex];
        playVideo(prevUrl, currentVideoTitle, sourceCode, prevIndex);
    }
}

// 播放下一集
function playNextEpisode(sourceCode) {
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        const nextIndex = currentEpisodeIndex + 1;
        const nextUrl = currentEpisodes[nextIndex];
        playVideo(nextUrl, currentVideoTitle, sourceCode, nextIndex);
    }
}

// 处理播放器加载错误
function handlePlayerError() {
    hideLoading();
    showToast('视频播放加载失败，请尝试其他视频源', 'error');
}

// 辅助函数用于渲染剧集按钮（使用当前的排序状态）
function renderEpisodes(vodName, sourceCode) {
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    return episodes.map((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        return `
            <button id="episode-${realIndex}" onclick="playVideo('${episode}','${vodName.replace(/"/g, '&quot;')}', '${sourceCode}', ${realIndex})" 
                    class="px-4 py-2 bg-[#222] hover:bg-[#333] border border-[#333] rounded-lg transition-colors text-center episode-btn">
                第${realIndex + 1}集
            </button>
        `;
    }).join('');
}

// 切换排序状态的函数
function toggleEpisodeOrder(sourceCode) {
    episodesReversed = !episodesReversed;
    // 重新渲染剧集区域，使用 currentVideoTitle 作为视频标题
    const episodesGrid = document.getElementById('episodesGrid');
    if (episodesGrid) {
        episodesGrid.innerHTML = renderEpisodes(currentVideoTitle, sourceCode);
    }

    // 更新按钮文本和箭头方向
    const toggleBtn = document.querySelector(`button[onclick="toggleEpisodeOrder('${sourceCode}')"]`);
    if (toggleBtn) {
        toggleBtn.querySelector('span').textContent = episodesReversed ? '正序排列' : '倒序排列';
        const arrowIcon = toggleBtn.querySelector('svg');
        if (arrowIcon) {
            arrowIcon.style.transform = episodesReversed ? 'rotate(180deg)' : 'rotate(0deg)';
        }
    }
}

// 配置文件导入功能
async function importConfig() {
    showImportBox(async (file) => {
        try {
            // 检查文件类型
            if (!(file.type === 'application/json' || file.name.endsWith('.json'))) throw '文件类型不正确';

            // 检查文件大小
            if (file.size > 1024 * 1024 * 10) throw new Error('文件大小超过 10MB');

            // 读取文件内容
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject('文件读取失败');
                reader.readAsText(file);
            });

            // 解析并验证配置
            const config = JSON.parse(content);
            if (config.name !== 'video-search-settings') throw '配置文件格式不正确';

            // 验证哈希
            const dataHash = await sha256(JSON.stringify(config.data));
            if (dataHash !== config.hash) throw '配置文件哈希值不匹配';

            // 导入配置
            for (let item in config.data) {
                localStorage.setItem(item, config.data[item]);
            }

            showToast('配置文件导入成功，3 秒后自动刷新本页面。', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        } catch (error) {
            const message = typeof error === 'string' ? error : '配置文件格式错误';
            showToast(`配置文件读取出错 (${message})`, 'error');
        }
    });
}

// 配置文件导出功能
async function exportConfig() {
    // 存储配置数据
    const config = {};

    // 读取全部 localStorage 项
    const items = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        items[key] = localStorage.getItem(key);
    }

    const times = Date.now().toString();
    config['name'] = 'video-search-settings';  // 配置文件名，用于校验
    config['time'] = times;               // 配置文件生成时间
    config['cfgVer'] = '1.0.0';           // 配置文件版本
    config['data'] = items;               // 配置文件数据
    config['hash'] = await sha256(JSON.stringify(config['data']));  // 计算数据的哈希值，用于校验

    // 将配置数据保存为 JSON 文件
    saveStringAsFile(JSON.stringify(config), 'video-search-settings_' + times + '.json');
}

// 将字符串保存为文件
function saveStringAsFile(content, fileName) {
    // 创建Blob对象并指定类型
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    // 生成临时URL
    const url = window.URL.createObjectURL(blob);
    // 创建<a>标签并触发下载
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    // 清理临时对象
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// app.js 或路由文件中
const authMiddleware = require('./middleware/auth');
const config = require('./config');

// 对所有请求启用鉴权（按需调整作用范围）
if (config.auth.enabled) {
    app.use(authMiddleware);
}

// 或者针对特定路由
app.use('/api', authMiddleware);
