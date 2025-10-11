// my-chat-app/static/client.js

document.addEventListener('DOMContentLoaded', () => {
    // --- 元素获取 ---
    const usernameDisplay = document.getElementById('username-display');
    const addFriendBtn = document.getElementById('add-friend-btn');
    const friendRequestsList = document.getElementById('friend-requests-list');
    const friendList = document.getElementById('friend-list');
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatArea = document.getElementById('chat-area');
    const chatHeaderTitle = document.getElementById('chat-header-title');
    const deleteFriendBtn = document.getElementById('delete-friend-btn');
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

    // --- 状态管理 ---
    let username = localStorage.getItem('chat_username');
    let ws;
    let currentChatId = null;

    // --- 初始化 ---
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
    }

    // --- WebSocket 通信 ---
    function connectWebSocket() {
        if (ws) ws.close();
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws?username=${username}`);

        ws.onmessage = (event) => {
            const { type, payload } = JSON.parse(event.data);
            handleServerMessage(type, payload);
        };
        ws.onclose = () => showToast("与服务器断开连接，尝试重连...", 'error');
        ws.onerror = (err) => console.error("WebSocket 错误:", err);
    }

    function handleServerMessage(type, payload) {
        switch (type) {
            case 'initial_data':
                renderFriendList(payload.friends);
                renderFriendRequests(payload.requests);
                break;
            case 'history':
                if (payload.chatId === currentChatId) {
                    messagesContainer.innerHTML = '';
                    payload.messages.forEach(addMessageToUI);
                }
                break;
            case 'new_message':
                if (payload.chatId === currentChatId) {
                    addMessageToUI(payload);
                } else {
                    // 提示有新消息
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
            case 'new_friend_request':
                showToast(`收到来自 ${payload} 的好友请求`);
                renderFriendRequests([payload], true); // true表示追加
                break;
            case 'friend_added':
                showToast(`已添加 ${payload} 为好友`);
                renderFriendList([payload], true);
                // 如果对方在请求列表里，移除它
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
            case 'error':
                showToast(payload, 'error');
                break;
            case 'info':
                showToast(payload, 'info');
                break;
        }
    }

    // --- UI 渲染 ---
    function renderFriendList(friends, append = false) {
        if (!append) friendList.innerHTML = '';
        friends.forEach(friend => {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.username = friend;
            item.textContent = friend;
            item.onclick = () => switchChat(friend);
            friendList.appendChild(item);
        });
    }

    function renderFriendRequests(requests, append = false) {
        if (!append) friendRequestsList.innerHTML = '';
        requests.forEach(requestUser => {
            const item = document.createElement('div');
            item.className = 'list-item';
            item.dataset.username = requestUser;
            item.innerHTML = `
                <span>${requestUser}</span>
                <div class="list-item-actions">
                    <button class="accept-btn" title="接受"><i class="fa-solid fa-check"></i></button>
                </div>
            `;
            item.querySelector('.accept-btn').onclick = (e) => {
                e.stopPropagation();
                ws.send(JSON.stringify({ type: 'accept_friend', payload: { friendUsername: requestUser } }));
            };
            friendRequestsList.appendChild(item);
        });
    }

    function addMessageToUI(msg) {
        const item = document.createElement('div');
        item.dataset.messageId = msg.id;

        if (msg.contentType === 'recalled') {
            item.className = 'message-recalled';
            item.textContent = `${msg.sender} 撤回了一条消息`;
        } else {
            const isMine = msg.sender === username;
            item.className = isMine ? 'message mine' : 'message theirs';
            
            item.innerHTML = `
                <div class="message-content">
                    <div class="message-sender">${escapeHTML(msg.sender)}</div>
                    <div class="text">${escapeHTML(msg.content)}</div>
                </div>
            `;
            
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
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    function switchChat(friendUsername) {
        currentChatId = [username, friendUsername].sort().join('-');
        
        // 更新UI
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

        // 获取历史记录
        ws.send(JSON.stringify({ type: 'get_history', payload: { chatId: currentChatId } }));
    }

    function switchToWelcomeScreen() {
        currentChatId = null;
        welcomeScreen.classList.remove('hidden');
        chatArea.classList.add('hidden');
        document.querySelectorAll('#friend-list .list-item').forEach(el => el.classList.remove('active'));
    }

    function showToast(message, type = 'info') {
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
    
    // --- 事件监听 ---
    addFriendBtn.onclick = () => addFriendModal.classList.remove('hidden');
    cancelAddFriendBtn.onclick = () => addFriendModal.classList.add('hidden');
    
    addFriendForm.onsubmit = (e) => {
        e.preventDefault();
        const friendUsername = addFriendInput.value.trim();
        if (friendUsername) {
            ws.send(JSON.stringify({ type: 'add_friend', payload: { friendUsername } }));
            addFriendInput.value = '';
            addFriendModal.classList.add('hidden');
        }
    };
    
    messageForm.onsubmit = (e) => {
        e.preventDefault();
        if (messageInput.value && currentChatId) {
            const message = {
                type: 'send_message',
                payload: {
                    chatId: currentChatId,
                    content: messageInput.value
                }
            };
            ws.send(JSON.stringify(message));
            
            // 立即在自己屏幕上显示
            addMessageToUI({
                id: 'temp-' + Date.now(),
                sender: username,
                content: messageInput.value,
            });
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
    
    function escapeHTML(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // --- 启动应用 ---
    initialize();
});