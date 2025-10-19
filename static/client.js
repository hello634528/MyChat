// my-chat-app/static/client.js (v4 - 终极修复版)

document.addEventListener('DOMContentLoaded', () => {
    // --- 元素获取 (无变化) ---
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

    // --- 状态管理 (无变化) ---
    let username = localStorage.getItem('chat_username');
    let ws;
    let currentChatId = null;
    let reconnectDelay = 1000;

    // --- 初始化与连接 (无变化) ---
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

    // --- 服务器消息处理 (核心修正！) ---
    function handleServerMessage(type, payload) {
        // 新增调试日志，方便排查问题
        console.log('收到服务器消息:', { type, payload });

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
            
            // ==================== ✅ 核心修正就在这里！ ====================
            case 'new_message': {
                // 1. 检查这条消息是否已经存在于界面上，防止重复渲染
                if (payload.id && document.querySelector(`[data-message-id="${payload.id}"]`)) {
                    console.log(`消息 ${payload.id} 已存在，跳过渲染。`);
                    return;
                }

                // 2. 核心判断：这条新消息的聊天ID，是否就是当前打开的聊天窗口的ID？
                if (payload.chatId === currentChatId) {
                    // 如果是，立即将消息添加到UI
                    console.log(`聊天窗口匹配！立即显示新消息。`);
                    addMessageToUI(payload);
                } else {
                    // 如果不是，说明是别的聊天发来的消息，显示小红点通知
                    console.log(`聊天窗口不匹配 (当前: ${currentChatId}, 收到: ${payload.chatId})。显示小红点。`);
                    
                    // 找出这条消息的“另一方”是谁
                    const otherUser = payload.sender === username 
                        ? payload.chatId.replace(username, '').replace('-', '') 
                        : payload.sender;

                    const friendItem = document.querySelector(`.list-item[data-username="${otherUser}"]`);
                    if (friendItem && !friendItem.querySelector('.notification-dot')) {
                        const dot = document.createElement('span');
                        dot.className = 'notification-dot';
                        friendItem.appendChild(dot);
                    }
                }
                break;
            }
            // =============================================================

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

    // --- UI 渲染与交互 (无变化) ---
    function addMessageToUI(msg) {
        if (msg.id && document.querySelector(`[data-message-id="${msg.id}"]`)) return;
        
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
    
    // --- 事件监听 (无变化) ---
    messageForm.onsubmit = (e) => {
        e.preventDefault();
        if (messageInput.value && currentChatId && ws && ws.readyState === WebSocket.OPEN) {
            const messagePayload = { chatId: currentChatId, content: messageInput.value };
            ws.send(JSON.stringify({ type: 'send_message', payload: messagePayload }));
            messageInput.value = '';
        }
    };

    function renderFriendList(friends, append = false) { if (!append) friendList.innerHTML = ''; friends.forEach(friend => { if (friendList.querySelector(`[data-username="${friend}"]`)) return; const item = document.createElement('div'); item.className = 'list-item'; item.dataset.username = friend; item.textContent = friend; item.onclick = () => switchChat(friend); friendList.appendChild(item); }); }
    function renderFriendRequests(requests, append = false) { if (!append) friendRequestsList.innerHTML = ''; requests.forEach(requestUser => { if (friendRequestsList.querySelector(`[data-username="${requestUser}"]`)) return; const item = document.createElement('div'); item.className = 'list-item'; item.dataset.username = requestUser; item.innerHTML = `<span>${requestUser}</span><div class="list-item-actions"><button class="accept-btn" title="接受"><i class="fa-solid fa-check"></i></button></div>`; item.querySelector('.accept-btn').onclick = (e) => { e.stopPropagation(); ws.send(JSON.stringify({ type: 'accept_friend', payload: { friendUsername: requestUser } })); }; friendRequestsList.appendChild(item); }); }
    function switchChat(friendUsername) { currentChatId = [username, friendUsername].sort().join('-'); welcomeScreen.classList.add('hidden'); chatArea.classList.remove('hidden'); chatHeaderTitle.textContent = friendUsername; document.querySelectorAll('#friend-list .list-item').forEach(el => el.classList.remove('active')); const friendItem = document.querySelector(`.list-item[data-username="${friendUsername}"]`); if (friendItem) { friendItem.classList.add('active'); const dot = friendItem.querySelector('.notification-dot'); if (dot) dot.remove(); } appContainer.classList.add('mobile-chat-visible'); ws.send(JSON.stringify({ type: 'get_history', payload: { chatId: currentChatId } })); }
    function switchToWelcomeScreen() { currentChatId = null; welcomeScreen.classList.remove('hidden'); chatArea.classList.add('hidden'); document.querySelectorAll('#friend-list .list-item').forEach(el => el.classList.remove('active')); appContainer.classList.remove('mobile-chat-visible'); }
    function showToast(message, type = 'info') { toast.textContent = message; toast.className = `toast show ${type}`; setTimeout(() => { toast.classList.remove('show'); }, 3000); }
    addFriendBtn.onclick = () => addFriendModal.classList.remove('hidden');
    cancelAddFriendBtn.onclick = () => addFriendModal.classList.add('hidden');
    backToListBtn.onclick = () => appContainer.classList.remove('mobile-chat-visible');
    addFriendForm.onsubmit = (e) => { e.preventDefault(); const friendUsername = addFriendInput.value.trim(); if (friendUsername && ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'add_friend', payload: { friendUsername } })); addFriendInput.value = ''; addFriendModal.classList.add('hidden'); } else { showToast('连接已断开，请稍后重试', 'error'); } };
    deleteFriendBtn.onclick = () => { const friendUsername = chatHeaderTitle.textContent; if (friendUsername && confirm(`确定要删除好友 ${friendUsername} 吗？所有聊天记录将永久删除。`)) { ws.send(JSON.stringify({ type: 'delete_friend', payload: { friendUsername } })); } };
    document.addEventListener('click', () => contextMenu.style.display = 'none');
    recallOption.onclick = () => { const messageId = contextMenu.dataset.targetMessageId; if (messageId && currentChatId) { ws.send(JSON.stringify({ type: 'recall_message', payload: { messageId, chatId: currentChatId } })); } };
    function escapeHTML(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }

    // --- 启动应用 ---
    initialize();
});
