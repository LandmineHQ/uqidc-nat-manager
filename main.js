(() => {
    // ============================================================
    // 1. 公共组件 (配置、API、限流)
    // ============================================================
    const CONFIG = {
        VERSION: "1.0.0",
        WORKER_COUNT: 2,
        MAX_RPS: 2,
        // 动态获取
        get REQUEST_URL() { return this._url || ""; },
        get REFERRER() { return this._ref || ""; },
        setContext(id) {
            this._url = `https://www.uqidc.com/provision/custom/${id}`;
            this._ref = `https://www.uqidc.com/servicedetail?id=${id}`;
        },
        HEADERS: {
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9",
            "authorization": "JWT",
            "content-type": "application/x-www-form-urlencoded",
            "priority": "u=1, i",
            "sec-ch-ua": "\"Not(A:Brand\";v=\"8\", \"Chromium\";v=\"144\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin"
        }
    };

    // 简单的服务 ID 获取工具
    const ContextHelper = {
        getId() {
            const urlParams = new URLSearchParams(location.search);
            return urlParams.get("id");
        },
        ensureContext() {
            const id = this.getId();
            if (id) {
                CONFIG.setContext(id);
                return true;
            }
            return false;
        }
    };

    // 核心请求逻辑
    class API {
        static async request(type, val) {
            let body = "";
            if (type === 'del') {
                body = `func=delNatAcl&id=${val}`;
            } else {
                body = `name=${val}&ext_port=${val}&int_port=${val}&select-protocol=3&func=addNatAcl`;
            }

            try {
                const res = await fetch(CONFIG.REQUEST_URL, {
                    method: "POST", headers: CONFIG.HEADERS, body,
                    mode: "cors", credentials: "include", referrer: CONFIG.REFERRER
                });

                if (!res.ok) return { status: 'network_error', msg: `HTTP ${res.status}` };
                const data = await res.json();

                if (data.status === 200) {
                    return { status: 'success', msg: data.msg || "成功" };
                } else {
                    return { status: 'logic_error', msg: data.msg || "业务错误" };
                }
            } catch (e) {
                return { status: 'network_error', msg: e.message || "请求异常" };
            }
        }
    }

    // 限流器 (可实例化多个，实现系统间隔离)
    class RateLimiter {
        constructor(rps) {
            this.rps = rps;
            this.count = 0;
            this.lastTime = Date.now();
        }
        async wait() {
            const now = Date.now();
            if (now - this.lastTime >= 1000) {
                this.count = 0;
                this.lastTime = now;
            }
            while (this.count >= this.rps) {
                await new Promise(r => setTimeout(r, 50));
                const currentNow = Date.now();
                if (currentNow - this.lastTime >= 1000) {
                    this.count = 0;
                    this.lastTime = currentNow;
                }
            }
            this.count++;
        }
    }

    // ============================================================
    // 2. CMD 系统 (Headless)
    // ============================================================
    class ConsoleTaskManager {
        constructor() {
            this.queue = [];
            this.activeWorkers = 0;
            this.limiter = new RateLimiter(CONFIG.MAX_RPS);
        }

        // 添加任务并自动启动
        addTasks(list, type) {
            if (!ContextHelper.ensureContext()) {
                console.error("[CMD] ❌ 错误: 无法获取 Service ID，请确认 URL 包含 ?id=xxx");
                return;
            }

            const tasks = list.map(val => ({ type, value: val }));
            this.queue.push(...tasks);
            console.log(`[CMD] 已添加 ${tasks.length} 个任务到后台队列。正在启动...`);

            this.start();
        }

        start() {
            if (this.activeWorkers === 0) {
                for (let i = 0; i < CONFIG.WORKER_COUNT; i++) this.worker(i + 1);
            }
        }

        async worker(wid) {
            this.activeWorkers++;
            while (this.queue.length > 0) {
                const task = this.queue.shift();

                try {
                    await this.limiter.wait();

                    // CMD 模式下，delete 输入的直接就是 ID
                    const displayVal = task.type === 'del' ? `ID:${task.value}` : `Port:${task.value}`;
                    console.log(`[CMD-W${wid}] 正在${task.type === 'del' ? '删除' : '创建'} ${displayVal}`);

                    const res = await API.request(task.type, task.value);

                    if (res.status === 'success') {
                        console.log(`%c[CMD] ✅ 成功: ${displayVal}`, "color:green");
                    } else if (res.status === 'logic_error') {
                        console.warn(`[CMD] ❌ 失败: ${displayVal} - ${res.msg}`);
                    } else {
                        console.error(`[CMD] 🚨 网络错误: ${displayVal} - ${res.msg}`);
                        // 网络错误暂停队列机制在 CMD 模式下可简化为：停止当前 Worker 或重试
                        // 这里选择简单的跳过，防止 CMD 脚本卡死
                    }
                } catch (e) {
                    console.error(`[CMD] 异常: ${e.message}`);
                }
            }
            this.activeWorkers--;
            if (this.activeWorkers === 0) {
                console.log("%c[CMD] 所有后台任务执行完毕。", "color:cyan; font-weight:bold;");
            }
        }
    }

    // ============================================================
    // 3. UI 系统 (Visual)
    // ============================================================

    // UI 表格解析与 DOM 同步
    class TableParser {
        getTbody() {
            return document.querySelector("#module_client_area_nat_acl > div > div.table-responsive > table > tbody");
        }

        scan(ui) {
            const tbody = this.getTbody();
            if (!tbody) { if (ui) ui.log("未找到网页表格", "warn"); return []; }

            const rows = Array.from(tbody.querySelectorAll("tr"));
            const data = rows.map(tr => {
                const tds = tr.querySelectorAll("td");
                if (tds.length < 5) return null;
                const btn = tds[4].querySelector(".deleteNAT");
                return {
                    name: tds[0].innerText.trim(),
                    external: tds[1].innerText.trim(),
                    internal: parseInt(tds[2].innerText.trim()),
                    protocol: tds[3].innerText.trim(),
                    id: btn ? btn.getAttribute("data-id") : null,
                    isNew: false,
                    origin: tr
                };
            }).filter(i => i);

            if (ui) ui.log(`列表已刷新 (${data.length})`);
            return data;
        }

        addOptimistic(port) {
            const tbody = this.getTbody();
            let origin = null;
            if (tbody) {
                try {
                    const tr = document.createElement("tr");
                    tr.innerHTML = `<td>${port}</td><td>等待刷新...</td><td>${port}</td><td>tcp,udp</td><td style="text-align:center"><span style="color:#4caf50;font-weight:bold">新增</span></td>`;
                    tbody.insertBefore(tr, tbody.firstChild);
                    origin = tr;
                } catch (e) { }
            }
            return {
                name: port.toString(), external: "等待刷新...", internal: parseInt(port),
                protocol: "tcp,udp", id: null, isNew: true, origin
            };
        }

        removeSynced(item) {
            if (item && item.origin) {
                try { item.origin.remove(); } catch (e) { }
            }
        }
    }

    // UI 任务管理器
    class UITaskManager {
        constructor(ui) {
            this.ui = ui;
            this.parser = new TableParser();
            this.inventory = [];
            this.queue = [];
            this.failedItems = [];
            this.activeWorkers = 0;
            this.isPaused = false;
            this.isRunning = false;
            this.totalTasks = 0;
            this.completedTasks = 0;
            this.limiter = new RateLimiter(CONFIG.MAX_RPS);
        }

        refreshList() {
            if (ContextHelper.ensureContext()) {
                this.inventory = this.parser.scan(this.ui);
                this.ui.renderList(this.inventory);
                this.ui.updateTitle(ContextHelper.getId());
            }
        }

        // UI 批量添加 (输入是端口)
        addBatch(start, end, type) {
            if (!ContextHelper.ensureContext()) { this.ui.log("无法获取 ID", "error"); return; }
            if (this.isRunning && !this.isPaused) { this.ui.log("请先暂停", "error"); return; }

            const s = parseInt(start), e = end ? parseInt(end) : s;
            if (isNaN(s)) return;

            const newTasks = [];
            if (type === 'add') {
                for (let p = s; p <= e; p++) newTasks.push({ type: 'add', value: p });
            } else {
                for (let p = s; p <= e; p++) {
                    const target = this.inventory.find(i => i.internal === p && i.id);
                    if (target) newTasks.push({ type: 'del', value: { port: p, id: target.id } });
                }
                if (newTasks.length === 0) { this.ui.log("未找到匹配端口", "warn"); return; }
            }

            this.queue.push(...newTasks);
            this.totalTasks += newTasks.length;
            this.ui.updateProgress(this.completedTasks, this.totalTasks);
            this.ui.log(`添加 ${newTasks.length} 个任务`);
        }

        // UI 列表单删
        async instantDelete(id, port, btn) {
            if (!ContextHelper.ensureContext()) return;
            this.ui.log(`删除 ${port}...`, "info");

            const res = await API.request('del', id);

            if (res.status === 'success') {
                this.ui.log(`✅ 删除成功 ${port}`, "success");
                const idx = this.inventory.findIndex(i => i.id == id);
                if (idx !== -1) {
                    this.parser.removeSynced(this.inventory[idx]);
                    this.inventory.splice(idx, 1);
                    this.ui.renderList(this.inventory);
                }
            } else {
                this.ui.log(`❌ 删除失败 ${port}: ${res.msg}`, "error");
                if (btn) { btn.disabled = false; btn.innerText = "×"; btn.style.opacity = "1"; }
            }
        }

        // UI Worker
        async worker(wid) {
            this.activeWorkers++;
            while (this.queue.length > 0) {
                if (this.isPaused) break;
                const task = this.queue.shift();

                try {
                    await this.limiter.wait();

                    const isDel = task.type === 'del';
                    const display = isDel ? task.value.port : task.value;
                    const reqVal = isDel ? task.value.id : task.value;

                    this.ui.log(`[W${wid}] ${isDel ? '删' : '增'}: ${display}`);
                    const res = await API.request(task.type, reqVal);

                    if (res.status === 'success') {
                        this.completedTasks++;
                        if (isDel) {
                            // Sync remove
                            const idx = this.inventory.findIndex(i => i.id == reqVal);
                            if (idx !== -1) {
                                this.parser.removeSynced(this.inventory[idx]);
                                this.inventory.splice(idx, 1);
                            }
                        } else {
                            // Sync add
                            const newItem = this.parser.addOptimistic(display);
                            this.inventory.unshift(newItem);
                        }
                        // Batch rendering? To save perf, maybe render every X items. For now, realtime.
                        // 但是为了防止列表跳动太快，这里不重新渲染整个列表，只更新数据源？
                        // 为了简单，我们只在 UI 线程空闲时渲染，或者这里直接渲染
                        // 由于 Worker 是 async，这里直接渲染是可以的
                        // 但考虑到性能，我们在 Worker 循环结束后或特定事件渲染更好。
                        // 鉴于目前需求，实时性优先：
                        // 如果不需要实时看到每一行变化，可以注释掉下面这行
                        // this.ui.renderList(this.inventory); 
                        // 改为：不频繁渲染，只在 UI Log 中体现，或者每完成一个就渲染
                        // 这里为了效果，我们假设用户想看到结果：
                        this.ui.renderList(this.inventory);

                    } else if (res.status === 'logic_error') {
                        this.ui.log(`❌ 失败: ${display} - ${res.msg}`, "error");
                        task.errorMsg = res.msg;
                        this.failedItems.push(task);
                        this.ui.renderFailed(this.failedItems);
                    } else {
                        this.ui.log(`🚨 网络错误: ${res.msg}`, "error");
                        this.ui.log("队列已暂停", "warn");
                        task.errorMsg = res.msg;
                        this.failedItems.push(task);
                        this.ui.renderFailed(this.failedItems);
                        this.isPaused = true;
                        this.ui.setBtnState("paused");
                        break;
                    }
                } catch (e) { this.ui.log(`异常: ${e.message}`, "error"); }
                finally { this.ui.updateProgress(this.completedTasks, this.totalTasks); }
            }
            this.activeWorkers--;
            if (this.activeWorkers === 0 && !this.isPaused && this.queue.length === 0) {
                this.isRunning = false;
                this.ui.setBtnState("idle");
                this.ui.log("✅ 队列完成", "success");
                this.queue = []; this.totalTasks = 0; this.completedTasks = 0;
                this.ui.updateProgress(0, 0);
            }
        }

        start() {
            if (!ContextHelper.ensureContext()) return this.ui.log("未找到ID", "error");
            if (this.queue.length === 0) return this.ui.log("队列为空", "warn");
            this.isPaused = false;
            this.isRunning = true;
            this.ui.setBtnState("running");
            if (this.activeWorkers === 0) for (let i = 0; i < CONFIG.WORKER_COUNT; i++) this.worker(i + 1);
        }
        pause() { this.isPaused = true; this.ui.setBtnState("paused"); }
        clear() { this.queue = []; this.totalTasks = 0; this.completedTasks = 0; this.ui.updateProgress(0, 0); this.ui.log("队列已清空", "warn"); }
        retry() {
            this.queue.push(...this.failedItems);
            this.totalTasks += this.failedItems.length;
            this.failedItems = [];
            this.ui.renderFailed([]);
            this.ui.updateProgress(this.completedTasks, this.totalTasks);
        }
    }

    // UI 渲染器
    class UIManager {
        constructor() { this.init(); }
        init() {
            const css = `
                #uq-panel { position: fixed; top: 50px; right: 50px; width: 600px; height: 450px; background: #1e1e1e; color: #d4d4d4; font-family: Consolas, sans-serif; border: 1px solid #3c3c3c; box-shadow: 0 4px 15px rgba(0,0,0,0.6); z-index: 99999; border-radius: 6px; display: flex; flex-direction: column; }
                #uq-header { padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; cursor: move; display: flex; justify-content: space-between; align-items: center; font-weight: bold; select-user: none; }
                #uq-close { cursor: pointer; color: #f44336; }
                #uq-body { display: flex; flex: 1; overflow: hidden; }
                #uq-left-col { width: 65%; display: flex; flex-direction: column; background: #1e1e1e; border-right: 1px solid #3c3c3c; }
                #uq-right-col { width: 35%; padding: 10px; display: flex; flex-direction: column; gap: 10px; background: #222; }
                .uq-section-title { font-size: 11px; color: #888; margin-bottom: 4px; font-weight: bold; text-transform: uppercase; }
                #uq-list-header { display: flex; padding: 6px 10px; background: #2d2d2d; font-size: 11px; color: #aaa; border-bottom: 1px solid #3c3c3c; align-items: center; }
                #uq-btn-refresh { cursor: pointer; margin-left: auto; color: #00bcd4; font-weight: bold; }
                #uq-list-scroll { flex: 1; overflow-y: auto; background: #181818; }
                .uq-list-item { display: flex; align-items: center; padding: 5px 10px; border-bottom: 1px solid #2a2a2a; font-size: 12px; }
                .uq-list-item:hover { background: #2a2d2e; }
                .uq-col-in { width: 50px; color: #fff; }
                .uq-col-ex { flex: 1; color: #9cdcfe; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 5px; }
                .uq-col-op { width: 30px; text-align: right; }
                .uq-input { width: 100%; background: #3c3c3c; border: 1px solid #555; color: #fff; padding: 5px; border-radius: 3px; font-size: 12px; margin-bottom: 5px; box-sizing: border-box; }
                .uq-btn { width: 100%; padding: 6px; border: none; border-radius: 3px; cursor: pointer; color: #fff; font-size: 12px; margin-bottom: 5px; }
                .uq-btn-blue { background: #007acc; } .uq-btn-blue:hover { background: #0062a3; }
                .uq-btn-red { background: #ce9178; color:#000; } .uq-btn-red:hover { background: #b87b64; }
                .uq-btn-green { background: #4caf50; font-weight:bold; } .uq-btn-green:hover { background: #43a047; }
                .uq-btn-darkred { background: #800; } .uq-btn-darkred:hover { background: #a00; }
                .uq-btn-yellow { background: #dcdcaa; color: #000; }
                .uq-btn-mini { padding: 2px 6px; font-size: 11px; width: auto; margin:0; }
                #uq-progress-bg { height: 6px; background: #333; border-radius: 3px; overflow: hidden; margin-top:5px; }
                #uq-progress-bar { height: 100%; width: 0%; background: #4caf50; transition: width 0.3s; }
                #uq-log { height: 80px; overflow-y: auto; padding: 5px; font-size: 11px; color: #888; font-family: monospace; background: #111; border-top: 1px solid #3c3c3c; }
                #uq-failed { display: none; background: #300; color: #f88; padding: 4px; font-size: 11px; margin-bottom: 5px; max-height: 50px; overflow-y: auto; }
                #uq-version { position: absolute; right: 8px; bottom: 6px; font-size: 10px; color: #666; letter-spacing: 0.5px; pointer-events: none; }
                #uq-modal-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: none; align-items: center; justify-content: center; z-index: 100000; }
                #uq-modal { width: 320px; background: #1f1f1f; border: 1px solid #3c3c3c; border-radius: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); padding: 12px; }
                #uq-modal-text { font-size: 12px; color: #ddd; line-height: 1.5; margin-bottom: 10px; }
                #uq-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
            `;
            const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
            const div = document.createElement("div"); div.id = "uq-panel";
            div.innerHTML = `
                <div id="uq-header"><span id="uq-title">UQIDC 面板</span><span id="uq-close">✕</span></div>
                <div id="uq-body">
                    <div id="uq-left-col">
                        <div id="uq-list-header">
                            <div class="uq-col-in">端口</div><div class="uq-col-ex">映射地址</div><div class="uq-col-op"></div>
                            <div id="uq-btn-refresh">⟳ 刷新</div>
                        </div>
                        <div id="uq-list-scroll"><div style="padding:15px;text-align:center;color:#555">等待数据...</div></div>
                    </div>
                    <div id="uq-right-col">
                        <div>
                            <div class="uq-section-title">批量配置</div>
                            <input type="number" id="uq-start" class="uq-input" placeholder="起始端口">
                            <input type="number" id="uq-end" class="uq-input" placeholder="结束 (选填)">
                            <button id="uq-btn-add" class="uq-btn uq-btn-blue">＋ 添加创建</button>
                            <button id="uq-btn-del" class="uq-btn uq-btn-red">－ 添加删除</button>
                        </div>
                        <div style="margin-top:auto">
                            <div class="uq-section-title">队列控制</div>
                            <div id="uq-failed"></div>
                            <button id="uq-retry" class="uq-btn uq-btn-yellow" style="display:none">重试失败项</button>
                            <div id="uq-progress-container">
                                <div id="uq-progress-bg"><div id="uq-progress-bar"></div></div>
                                <div id="uq-progress-text" style="font-size:10px;color:#aaa;text-align:center">0 / 0</div>
                            </div>
                            <button id="uq-btn-clear" class="uq-btn uq-btn-darkred">清空队列</button>
                            <button id="uq-btn-start" class="uq-btn uq-btn-green">开始执行</button>
                        </div>
                    </div>
                </div>
                <div id="uq-log"></div>
                <div id="uq-version">v${CONFIG.VERSION}</div>
                <div id="uq-modal-mask">
                    <div id="uq-modal">
                        <div id="uq-modal-text"></div>
                        <div id="uq-modal-actions">
                            <button id="uq-modal-cancel" class="uq-btn uq-btn-darkred uq-btn-mini">取消</button>
                            <button id="uq-modal-ok" class="uq-btn uq-btn-green uq-btn-mini">确定</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(div);
            this.el = div;
            this.bindEvents();
            this.makeDraggable();
            // 尝试初始化数据
            setTimeout(() => window.UqidcApp.uiTask.refreshList(), 500);
        }

        bindEvents() {
            this.el.querySelector("#uq-close").onclick = async () => {
                const ok = await this.confirm("确定隐藏面板？(后台任务仍会运行)");
                if (ok) this.el.style.display = "none";
            };
            const sIn = this.el.querySelector("#uq-start");
            const eIn = this.el.querySelector("#uq-end");
            const getRange = () => [parseInt(sIn.value), eIn.value ? parseInt(eIn.value) : parseInt(sIn.value)];

            this.el.querySelector("#uq-btn-add").onclick = () => window.UqidcApp.uiTask.addBatch(...getRange(), 'add');
            this.el.querySelector("#uq-btn-del").onclick = () => window.UqidcApp.uiTask.addBatch(...getRange(), 'del');
            this.el.querySelector("#uq-btn-refresh").onclick = () => window.UqidcApp.uiTask.refreshList();
            this.el.querySelector("#uq-btn-start").onclick = () => {
                const tm = window.UqidcApp.uiTask;
                tm.isRunning && !tm.isPaused ? tm.pause() : tm.start();
            };
            this.el.querySelector("#uq-btn-clear").onclick = () => window.UqidcApp.uiTask.clear();
            this.el.querySelector("#uq-retry").onclick = () => window.UqidcApp.uiTask.retry();
        }

        renderList(list) {
            const box = this.el.querySelector("#uq-list-scroll");
            box.innerHTML = "";
            if (!list || list.length === 0) { box.innerHTML = `<div style="padding:15px;text-align:center;color:#555">无数据</div>`; return; }
            list.forEach(item => {
                const row = document.createElement("div"); row.className = "uq-list-item";
                let btnHtml = "";
                if (item.isNew) btnHtml = `<span style="color:#4caf50;font-size:10px">NEW</span>`;
                else if (item.id) {
                    const btn = document.createElement("button");
                    btn.className = "uq-btn uq-btn-red uq-btn-mini"; btn.innerText = "×";
                    btn.onclick = (e) => {
                        e.target.disabled = true; e.target.style.opacity = 0.5;
                        window.UqidcApp.uiTask.instantDelete(item.id, item.internal, e.target);
                    };
                    btnHtml = btn;
                }
                row.innerHTML = `<div class="uq-col-in">${item.internal}</div><div class="uq-col-ex" title="${item.external}">${item.external}</div><div class="uq-col-op"></div>`;
                const op = row.querySelector(".uq-col-op");
                if (typeof btnHtml === 'string') op.innerHTML = btnHtml; else op.appendChild(btnHtml);
                box.appendChild(row);
            });
        }

        renderFailed(list) {
            const box = this.el.querySelector("#uq-failed"), btn = this.el.querySelector("#uq-retry");
            if (list.length === 0) { box.style.display = "none"; btn.style.display = "none"; return; }
            box.style.display = "block"; btn.style.display = "block";
            box.innerHTML = list.map(t => `<div>${t.type === 'del' ? '删' : '增'} ${t.type === 'del' ? t.value.port : t.value} 失败 (${t.errorMsg || ''})</div>`).join("");
        }

        log(msg, type = "info") {
            const box = this.el.querySelector("#uq-log");
            const div = document.createElement("div");
            div.style.color = type === 'error' ? '#f66' : (type === 'warn' ? '#fa0' : '#888');
            div.innerText = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
            box.prepend(div);
        }

        updateProgress(c, t) {
            const p = t === 0 ? 0 : ((c / t) * 100).toFixed(1);
            this.el.querySelector("#uq-progress-bar").style.width = `${p}%`;
            this.el.querySelector("#uq-progress-text").innerText = `${c} / ${t}`;
        }
        updateTitle(id) { this.el.querySelector("#uq-title").innerText = `UQIDC (${id})`; }
        setBtnState(s) {
            const btn = this.el.querySelector("#uq-btn-start");
            if (s === 'running') { btn.innerText = "暂停"; btn.className = "uq-btn uq-btn-yellow"; }
            else if (s === 'paused') { btn.innerText = "恢复"; btn.className = "uq-btn uq-btn-green"; }
            else { btn.innerText = "开始执行"; btn.className = "uq-btn uq-btn-green"; }
        }
        confirm(message) {
            const mask = this.el.querySelector("#uq-modal-mask");
            const text = this.el.querySelector("#uq-modal-text");
            const okBtn = this.el.querySelector("#uq-modal-ok");
            const cancelBtn = this.el.querySelector("#uq-modal-cancel");
            let resolved = false;

            const cleanup = () => {
                mask.style.display = "none";
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                mask.onclick = null;
            };

            return new Promise(resolve => {
                text.innerText = message;
                mask.style.display = "flex";

                okBtn.onclick = () => {
                    if (resolved) return;
                    resolved = true;
                    cleanup();
                    resolve(true);
                };
                cancelBtn.onclick = () => {
                    if (resolved) return;
                    resolved = true;
                    cleanup();
                    resolve(false);
                };
                mask.onclick = (e) => {
                    if (e.target !== mask || resolved) return;
                    resolved = true;
                    cleanup();
                    resolve(false);
                };
            });
        }
        show() { this.el.style.display = "flex"; }
        makeDraggable() {
            const h = this.el.querySelector("#uq-header");
            let d = false, x, y, l, t;
            h.onmousedown = e => { d = true; x = e.clientX; y = e.clientY; const r = this.el.getBoundingClientRect(); l = r.left; t = r.top; h.style.cursor = "grabbing" };
            document.onmousemove = e => { if (d) { this.el.style.left = (l + e.clientX - x) + "px"; this.el.style.top = (t + e.clientY - y) + "px" } };
            document.onmouseup = () => { d = false; h.style.cursor = "move" };
        }
    }

    // ============================================================
    // 4. 初始化
    // ============================================================
    const ui = new UIManager();
    const uiTask = new UITaskManager(ui);
    const cmdTask = new ConsoleTaskManager();

    window.UqidcApp = {
        ui, uiTask, cmdTask, showUI: () => ui.show(),
        cmd: {
            create: (s, e) => cmdTask.addTasks(
                Array.from({ length: (e ? e : s) - s + 1 }, (_, i) => s + i), 'add'
            ),
            delete: (s, e) => cmdTask.addTasks(
                Array.from({ length: (e ? e : s) - s + 1 }, (_, i) => s + i), 'del'
            )
        }
    };

    // 暴露全局命令
    window.cmd = window.cmd || {};
    window.cmd.uqidcCreate = window.UqidcApp.cmd.create;
    window.cmd.uqidcDelete = window.UqidcApp.cmd.delete;

    console.log("%c UQIDC 脚本已加载: UI 与 CMD 系统已分离。", "color:#4caf50;font-weight:bold");

})();
