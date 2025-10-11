// my-chat-app/static/client.js 

document.addEventListener('DOMContentLoaded', () => {
    // 获取所有需要的 DOM 元素
    const appContainer = document.getElementById('app-container');
    const usernameDisplay = document.getElementById('username-display');
    const addFriendBtn = document.getElementById('add-friend-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const friendRequestsList = document.getElementById('friend-requests-list');
    const friendList = document.getElementById('friend-list');
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatArea = document.getElementById('chat-area');
    const chatHeaderTitle = document.getElementById('chat-header-title');
    const deleteFriendBtn = document.getElementById('delete-friend-btn');
    const backToListBtn = document.getElementById('back-to-list-btn');
    const messagesContainer = document.getElementById('messages');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const addFriendModal = document.getElementById('add-friend-modal');
    const addFriendForm = document.getElementById('add-friend-form');
    const addFriendInput = document.getElementById('add-friend-input');
    const settingsModal = document.getElementById('settings-modal');
    const heartbeatInput = document.getElementById('heartbeat-interval-input');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const deleteAccountBtn = document.getElementById('delete-account-btn');
    const contextMenu = document.getElementById('context-menu');
    const recallOption = document.getElementById('recall-option');
    const toast = document.getElementById('toast');

    // 状态管理变量
    let username = localStorage.getItem('chat_username');
    let ws;
    let currentChatId = null;
    let reconnectDelay = 1000;
    let heartbeatInterval;
    let heartbeatTimeout;

    // 初始化函数
    function initialize() {
        if (!username) {
            username = prompt("为了使用好友功能，请输入一个唯一的用户名:")?.trim();
            if (!username) { alert("必须提供用户名！"); return location.reload(); }
            localStorage.setItem('chat_username', username);
        }
        usernameDisplay.textContent = username;
        connectWebSocket();
        setupEventListeners();
    }

    // WebSocket 连接函数 (带自动重连)
    function connectWebSocket() {
        if (ws) ws.close();
        stopHeartbeat();
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws?username=${username}`);
        ws.onopen = () => {
            console.log("WebSocket 连接已建立");
            showToast("连接成功！", "success");
            reconnectDelay = 1000;
            startHeartbeat();
        };
        ws.onmessage = (event) => handleServerMessage(JSON.parse(event.data));
        ws.onclose = () => {
            console.log(`连接已断开，将在 ${reconnectDelay / 1000} 秒后尝试重连...`);
            showToast(`连接已断开，正在尝试重连...`, 'error');
            stopHeartbeat();
            setTimeout(connectWebSocket, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        };
        ws.onerror = (err) => { console.error("WebSocket 错误:", err); ws.close(); };
    }
    
    // 心跳机制函数
    function startHeartbeat() {
        const intervalSeconds = parseInt(localStorage.getItem('heartbeat_interval_s') || '5');
        const intervalMs = intervalSeconds * 1000;
        
        heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
                heartbeatTimeout = setTimeout(() => {
                    console.log("心跳超时，强制重连...");
                    ws.close();
                }, Math.max(2000, intervalMs - 1000));
            }
        }, intervalMs);
    }
    
    function stopHeartbeat() {
        clearInterval(heartbeatInterval);
        clearTimeout(heartbeatTimeout);
    }

    // 处理从服务器收到的消息
    function handleServerMessage({ type, payload }) {
        if (type === 'pong') { clearTimeout(heartbeatTimeout); return; }
        
        if (type === 'account_deleted') {
            showToast("账户已成功删除，即将刷新页面...", "success");
            localStorage.removeItem('chat_username');
            localStorage.removeItem('heartbeat_interval_s');
            setTimeout(() => location.reload(), 2000);
            return;
        }

        switch (type) {
            case 'initial_data': renderFriendList(payload.friends); renderFriendRequests(payload.requests); break;
            case 'history': if (payload.chatId === currentChatId) { messagesContainer.innerHTML = ''; payload.messages.forEach(addMessageToUI); } break;
            case 'new_message':
                if (payload.sender === username && !payload.isEcho) return;
                if (payload.chatId === currentChatId) { addMessageToUI(payload); } else {
                    const friendItem = document.querySelector(`.list-item[data-username="${payload.sender}"]`);
                    if (friendItem && !friendItem.querySelector('.notification-dot')) {
                        const dot = document.createElement('span');
                        dot.className = 'notification-dot';
                        friendItem.appendChild(dot);
                    }
                }
                break;
            case 'recalled_message':
                if (payload.chatId === currentChatId) {
                    const messageElement = document.querySelector(`[data-message-id="${payload.id}"]`);
                    if (messageElement) {
                        const recallNotice = document.createElement('div');
                        recallNotice.className = 'message-recalled';
                        recallNotice.textContent = `${payload.username} 撤回了一条消息`;
                        messageElement.replaceWith(recallNotice);
                    }
                }
                break;
            case 'new_friend_request': showToast(`收到来自 ${payload} 的好友请求`); renderFriendRequests([payload], true); break;
            case 'friend_added': showToast(`已添加 ${payload} 为好友`); renderFriendList([payload], true); const req = friendRequestsList.querySelector(`[data-username="${payload}"]`); if(req) req.remove(); break;
            case 'friend_deleted':
                showToast(`你与 ${payload} 的好友关系已解除`);
                if (currentChatId && currentChatId.includes(payload)) { switchToWelcomeScreen(); }
                const friendElem = friendList.querySelector(`[data-username="${payload}"]`);
                if (friendElem) friendElem.remove();
                break;
            case 'error': showToast(payload, 'error'); break;
            case 'info': showToast(payload, 'info'); break;
        }
    }

    // 集中管理所有事件监听
    function setupEventListeners() {
        addFriendBtn.onclick = () => addFriendModal.classList.remove('hidden');
        backToListBtn.onclick = () => appContainer.classList.remove('mobile-chat-visible');
        document.querySelectorAll('.cancel-btn').forEach(btn => btn.onclick = () => {
            addFriendModal.classList.add('hidden');
            settingsModal.classList.add('hidden');
        });
        
        addFriendForm.onsubmit = (e) => {
            e.preventDefault();
            const friendUsername = addFriendInput.value.trim();
            if (friendUsername && ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'add_friend', payload: { friendUsername } }));
                addFriendInput.value = '';
                addFriendModal.classList.add('hidden');
            } else { showToast('连接已断开，请稍后重试', 'error'); }
        };
        
        messageForm.onsubmit = (e) => {
            e.preventDefault();
            if (messageInput.value && currentChatId && ws?.readyState === WebSocket.OPEN) {
                const tempId = 'temp-' + Date.now();
                addMessageToUI({ id: tempId, sender: username, content: messageInput.value });
                ws.send(JSON.stringify({ type: 'send_message', payload: { chatId: currentChatId, content: messageInput.value } }));
                messageInput.value = '';
            }
        };

        deleteFriendBtn.onclick = () => {
            const friendUsername = chatHeaderTitle.textContent;
            if (friendUsername && confirm(`确定要删除好友 ${friendUsername} 吗？所有聊天记录将永久删除。`)) {
                ws.send(JSON.stringify({ type: 'delete_friend', payload: { friendUsername } }));
            }
        };

        document.addEventListener('click', () => contextMenu.style.display = 'none');
        recallOption.onclick = () => {
            const messageId = contextMenu.dataset.targetMessageId;
            if (messageId && currentChatId) {
                ws.send(JSON.stringify({ type: 'recall_message', payload: { messageId, chatId: currentChatId } }));
            }
        };

        settingsBtn.onclick = () => {
            heartbeatInput.value = localStorage.getItem('heartbeat_interval_s') || '5';
            settingsModal.classList.remove('hidden');
        };

        saveSettingsBtn.onclick = () => {
            const newInterval = parseInt(heartbeatInput.value);
            if (newInterval >= 3 && newInterval <= 60) {
                localStorage.setItem('heartbeat_interval_s', newInterval);
                showToast("设置已保存！将在下次重连或刷新后生效。", "success");
                settingsModal.classList.add('hidden');
            } else {
                showToast("心跳间隔必须在 3 到 60 秒之间！", "error");
            }
        };

        deleteAccountBtn.onclick = () => {
            if (confirm("警告：此操作将永久删除您的账户和所有数据！您确定要继续吗？")) {
                const confirmation = prompt(`为最终确认，请输入您的用户名 "${username}"：`);
                if (confirmation === username) {
                    if (ws?.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'delete_account' }));
                    } else {
                        showToast("无法连接到服务器，请稍后再试。", "error");
                    }
                } else if (confirmation !== null) { // 用户点击了确定但输入错误
                    showToast("用户名输入不匹配，操作已取消。", "info");
                }
            }
        };
    }
    
    // 渲染好友列表
    function renderFriendList(friends, append = false) {
        if (!append) friendList.innerHTML = '';
        friends.forEach(friend => {
            if (friendList.querySelector(`[data-username="${friend}"]`)) return;
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.username = friend;
            item.textContent = friend;
            item.onclick = () => switchChat(friend);
            friendList.appendChild(item);
        });
    }

    // 渲染好友请求列表
    function renderFriendRequests(requests, append = false) {
        if (!append) friendRequestsList.innerHTML = '';
        requests.forEach(requestUser => {
            if (friendRequestsList.querySelector(`[data-username="${requestUser}"]`)) return;
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.username = requestUser;
            item.innerHTML = `<span>${requestUser}</span><div class="list-item-actions"><button class="accept-btn" title="接受"><i class="fa-solid fa-check"></i></button></div>`;
            item.querySelector('.accept-btn').onclick = (e) => {
                e.stopPropagation();
                ws.send(JSON.stringify({ type: 'accept_friend', payload: { friendUsername: requestUser } }));
            };
            friendRequestsList.appendChild(item);
        });
    }

    // 在UI上添加一条消息
    function addMessageToUI(msg) {
        if (msg.sender === username && msg.isEcho) {
            const tempMessage = document.querySelector(`[data-message-id^="temp-"]`);
            if (tempMessage) {
                tempMessage.dataset.messageId = msg.id;
                return;
            }
        }
        const isScrolledToBottom = messagesContainer.scrollHeight - messagesContainer.clientHeight <= messagesContainer.scrollTop + 5;
        const item = document.createElement('div');
        item.dataset.messageId = msg.id;
        if (msg.contentType === 'recalled') {
            item.className = 'message-recalled';
            item.textContent = `${msg.sender} 撤回了一条消息`;
        } else {
            const isMine = msg.sender === username;
            item.className = isMine ? 'message mine' : 'message theirs';
            item.innerHTML = `<div class="message-content"><div class="message-sender">${escapeHTML(msg.sender)}</div><div class="text">${escapeHTML(msg.content)}</div></div>`;
            if (isMine) {
                item.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    contextMenu.style.top = `${e.pageY}px`;
                    contextMenu.style.left = `${e.pageX}px`;
                    contextMenu.style.display = 'block';
                    contextMenu.dataset.targetMessageId = msg.id;
                });
            }
        }
        messagesContainer.appendChild(item);
        if (isScrolledToBottom) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    // 切换聊天对象
    function switchChat(friendUsername) {
        currentChatId = [username, friendUsername].sort().join('-');
        welcomeScreen.classList.add('hidden');
        chatArea.classList.remove('hidden');
        chatHeaderTitle.textContent = friendUsername;
        document.querySelectorAll('#friend-list .list-item').forEach(el => el.classList.remove('active'));
        const friendItem = document.querySelector(`.list-item[data-username="${friendUsername}"]`);
        if (friendItem) {
            friendItem.classList.add('active');
            const dot = friendItem.querySelector('.notification-dot');
            if (dot) dot.remove();
        }
        appContainer.classList.add('mobile-chat-visible');
        ws.send(JSON.stringify({ type: 'get_history', payload: { chatId: currentChatId } }));
    }

    // 切换回欢迎界面
    function switchToWelcomeScreen() {
        currentChatId = null;
        welcomeScreen.classList.remove('hidden');
        chatArea.classList.add('hidden');
        document.querySelectorAll('#friend-list .list-item').forEach(el => el.classList.remove('active'));
        appContainer.classList.remove('mobile-chat-visible');
    }

    // 显示提示信息
    function showToast(message, type = 'info') {
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        setTimeout(() => { toast.classList.remove('show'); }, 3000);
    }
    
    // HTML转义函数
    function escapeHTML(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // 启动应用
    initialize();
});
