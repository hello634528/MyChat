// my-chat-app/static/client.js
document.addEventListener('DOMContentLoaded', () => {
    const appContainer = document.getElementById('app-container');
    const usernameDisplay = document.getElementById('username-display');
    const addFriendBtn = document.getElementById('add-friend-btn');
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
    const cancelAddFriendBtn = document.getElementById('cancel-add-friend');
    const contextMenu = document.getElementById('context-menu');
    const recallOption = document.getElementById('recall-option');
    const toast = document.getElementById('toast');

    let username = localStorage.getItem('chat_username');
    let ws;
    let currentChatId = null;
    let reconnectDelay = 1000;

    // 新增：本地缓存每个 chat 的消息，防止界面状态不同步
    const messagesCache = new Map(); // key: chatId, value: array of messages (ordered)

    // 帮助函数：生成标准 chatId（与服务端相同的排序规则）
    function makeChatId(a, b) {
        return [a, b].sort().join('-');
    }

    function initialize() {
        if (!username) {
            username = prompt("为了使用好友功能，请输入一个唯一的用户名:")?.trim();
            if (!username) {
                alert("必须提供用户名！");
                return location.reload();
            }
            localStorage.setItem('chat_username', username);
        }
        usernameDisplay.textContent = username;
        connectWebSocket();

        // 移动端：当输入框获得焦点时确保滚动到底部并把输入框可见
        messageInput.addEventListener('focus', () => {
            setTimeout(() => {
                ensureScrollToBottom();
                messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });
            }, 300);
        });

        // 监听 resize（部分移动浏览器打开键盘会触发 resize）
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                ensureScrollToBottom();
            }, 150);
        });
    }

    function connectWebSocket() {
        if (ws) ws.close();
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws?username=${username}`);
        ws.onopen = () => {
            console.log("WebSocket 连接已建立");
            showToast("连接成功！", "success");
            reconnectDelay = 1000;
        };
        ws.onmessage = (event) => {
            const { type, payload } = JSON.parse(event.data);
            handleServerMessage(type, payload);
        };
        ws.onclose = () => {
            console.log(`连接已断开，将在 ${reconnectDelay / 1000} 秒后尝试重连...`);
            showToast(`连接已断开，正在尝试重连...`, 'error');
            setTimeout(connectWebSocket, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        };
        ws.onerror = (err) => {
            console.error("WebSocket 错误:", err);
            ws.close();
        };
    }

    function handleServerMessage(type, payload) {
        switch (type) {
            case 'initial_data':
                renderFriendList(payload.friends);
                renderFriendRequests(payload.requests);
                break;
            case 'history':
                // 服务端发来的历史覆盖本地 cache，并在当前会话时显示
                if (!payload.chatId) break;
                messagesCache.set(payload.chatId, payload.messages.slice()); // 保证副本
                if (payload.chatId === currentChatId) {
                    renderMessagesForChat(payload.chatId);
                }
                break;
            case 'new_message':
                // 避免重复插入：使用消息 id 去重
                const chatId = payload.chatId;
                if (!chatId) break;

                // 把消息写入本地 cache（如果没有则新建）
                if (!messagesCache.has(chatId)) messagesCache.set(chatId, []);
                const cache = messagesCache.get(chatId);

                // 防重复：若已经存在 id 就忽略（保持稳定的去重）
                if (!cache.some(m => m.id === payload.id)) {
                    cache.push(payload);
                }

                // 如果当前会话是该 chat，则直接渲染到界面
                if (chatId === currentChatId) {
                    // 如果已经在 DOM 中存在（非常保守的双重检查），就不重复渲染
                    if (!document.querySelector(`[data-message-id="${payload.id}"]`)) {
                        addMessageToUI(payload);
                    }
                    ensureScrollToBottom();
                } else {
                    // 否则在好友列表显示未读点（并保留消息在 cache）
                    const friendUsername = identifyFriendFromChatId(chatId);
                    const friendItem = document.querySelector(`.list-item[data-username="${friendUsername}"]`);
                    if (friendItem && !friendItem.querySelector('.notification-dot')) {
                        const dot = document.createElement('span');
                        dot.className = 'notification-dot';
                        friendItem.appendChild(dot);
                    }
                }
                break;
            case 'recalled_message':
                // 更新 cache 并在当前会话中替换
                if (!payload.chatId) break;
                const recalledChat = payload.chatId;
                const arr = messagesCache.get(recalledChat);
                if (arr) {
                    const idx = arr.findIndex(m => m.id === payload.id);
                    if (idx !== -1) {
                        arr[idx].contentType = 'recalled';
                        arr[idx].content = '';
                    }
                }
                if (recalledChat === currentChatId) {
                    const messageElement = document.querySelector(`[data-message-id="${payload.id}"]`);
                    if (messageElement) {
                        const recallNotice = document.createElement('div');
                        recallNotice.className = 'message-recalled';
                        recallNotice.textContent = `${payload.username} 撤回了一条消息`;
                        messageElement.replaceWith(recallNotice);
                    }
                }
                break;
            case 'new_friend_request':
                showToast(`收到来自 ${payload} 的好友请求`);
                renderFriendRequests([payload], true);
                break;
            case 'friend_added':
                showToast(`已添加 ${payload} 为好友`);
                renderFriendList([payload], true);
                const requestItem = friendRequestsList.querySelector(`[data-username="${payload}"]`);
                if(requestItem) requestItem.remove();
                break;
            case 'friend_deleted':
                showToast(`你与 ${payload} 的好友关系已解除`);
                if (currentChatId && currentChatId.includes(payload)) {
                    switchToWelcomeScreen();
                }
                const friendElem = friendList.querySelector(`[data-username="${payload}"]`);
                if (friendElem) friendElem.remove();
                break;
            case 'error': showToast(payload, 'error'); break;
            case 'info': showToast(payload, 'info'); break;
        }
    }

    function addMessageToUI(msg) {
        if (!msg || !msg.id) return;
        if (document.querySelector(`[data-message-id="${msg.id}"]`)) return;
        const isScrolledToBottom = messagesContainer.scrollHeight - messagesContainer.clientHeight <= messagesContainer.scrollTop + 5;
        const item = document.createElement('div');
        item.dataset.messageId = msg.id;

        if (msg.contentType === 'recalled') {
            item.className = 'message-recalled';
            item.textContent = `${msg.sender} 撤回了一条消息`;
        } else {
            const isMine = msg.sender === username;
            item.className = isMine ? 'message mine' : 'message theirs';
            const safeSender = escapeHTML(msg.sender || '');
            const safeContent = escapeHTML(msg.content || '');
            item.innerHTML = `<div class="message-content"><div class="message-sender">${safeSender}</div><div class="text">${safeContent}</div></div>`;
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

    messageForm.onsubmit = (e) => {
        e.preventDefault();
        if (messageInput.value && currentChatId && ws && ws.readyState === WebSocket.OPEN) {
            const messagePayload = { chatId: currentChatId, content: messageInput.value };
            // 先在本地 cache 里生成一个临时条目（状态更新及时）
            const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
            const tempMsg = { id: tempId, chatId: currentChatId, sender: username, contentType: 'text', content: messageInput.value, timestamp: Date.now() };
            if (!messagesCache.has(currentChatId)) messagesCache.set(currentChatId, []);
            messagesCache.get(currentChatId).push(tempMsg);
            // 立即渲染
            addMessageToUI(tempMsg);
            ensureScrollToBottom();
            // 发送到服务器
            ws.send(JSON.stringify({ type: 'send_message', payload: messagePayload }));
            messageInput.value = '';
        }
    };

    function renderFriendList(friends, append = false) {
        if (!append) friendList.innerHTML = '';
        friends.forEach(friend => {
            if (friendList.querySelector(`[data-username="${friend}"]`)) return;
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.username = friend;
            item.innerHTML = `<span class="friend-name">${escapeHTML(friend)}</span>`;
            item.onclick = () => switchChat(friend);
            friendList.appendChild(item);
        });
    }

    function renderFriendRequests(requests, append = false) {
        if (!append) friendRequestsList.innerHTML = '';
        requests.forEach(requestUser => {
            if (friendRequestsList.querySelector(`[data-username="${requestUser}"]`)) return;
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.username = requestUser;
            item.innerHTML = `<span>${escapeHTML(requestUser)}</span><div class="list-item-actions"><button class="accept-btn" title="接受"><i class="fa-solid fa-check"></i></button></div>`;
            item.querySelector('.accept-btn').onclick = (e) => {
                e.stopPropagation();
                ws.send(JSON.stringify({ type: 'accept_friend', payload: { friendUsername: requestUser } }));
            };
            friendRequestsList.appendChild(item);
        });
    }

    // 切换到指定好友聊天（核心：使用标准 chatId，并从 cache 渲染）
    function switchChat(friendUsername) {
        const newChatId = makeChatId(username, friendUsername);
        currentChatId = newChatId;
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
        // 先展示本地 cache（如果有）
        if (messagesCache.has(currentChatId)) {
            renderMessagesForChat(currentChatId);
            ensureScrollToBottom();
        } else {
            // 无本地 cache 则请求历史
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'get_history', payload: { chatId: currentChatId } }));
            }
        }
    }

    function switchToWelcomeScreen() {
        currentChatId = null;
        welcomeScreen.classList.remove('hidden');
        chatArea.classList.add('hidden');
        document.querySelectorAll('#friend-list .list-item').forEach(el => el.classList.remove('active'));
        appContainer.classList.remove('mobile-chat-visible');
    }

    // 把 cache 中某个 chat 的消息全部渲染到 messagesContainer（清空并重建）
    function renderMessagesForChat(chatId) {
        messagesContainer.innerHTML = '';
        const arr = messagesCache.get(chatId) || [];
        arr.forEach(msg => {
            // 当服务器历史覆盖（有真实 id）可能替换临时消息 —— 这里优先渲染现有条目并跳过 DOM 去重
            if (msg && msg.id && !document.querySelector(`[data-message-id="${msg.id}"]`)) {
                addMessageToUI(msg);
            }
        });
    }

    // 确保滚动到底（并为移动端键盘做兼容）
    function ensureScrollToBottom() {
        // 使用 requestAnimationFrame 使得布局稳定后滚动
        requestAnimationFrame(() => {
            try {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            } catch (e) { /* ignore */ }
        });
    }

    function showToast(message, type = 'info') {
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        setTimeout(() => { toast.classList.remove('show'); }, 3000);
    }

    addFriendBtn.onclick = () => addFriendModal.classList.remove('hidden');
    cancelAddFriendBtn.onclick = () => addFriendModal.classList.add('hidden');
    backToListBtn.onclick = () => appContainer.classList.remove('mobile-chat-visible');
    addFriendForm.onsubmit = (e) => {
        e.preventDefault();
        const friendUsername = addFriendInput.value.trim();
        if (friendUsername && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'add_friend', payload: { friendUsername } }));
            addFriendInput.value = '';
            addFriendModal.classList.add('hidden');
        } else {
            showToast('连接已断开，请稍后重试', 'error');
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

    function identifyFriendFromChatId(chatId) {
        // chatId 格式 user1-user2（已排序），找出除自己外的那一个
        if (!chatId) return '';
        const parts = chatId.split('-');
        if (parts.length !== 2) return '';
        return parts[0] === username ? parts[1] : parts[0];
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }

    initialize();
});
