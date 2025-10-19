// my-chat-app/main.ts (v3 - 终极稳定版)

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";

// --- 配置 ---
const ENCRYPTION_KEY = "Key-qgejDhsjTiuYenfhGFbFjkImghFn"; // 你的密钥
const RECALL_TIMEOUT_MS = 3 * 60 * 1000;

// --- 数据库和 WebSocket 管理 ---
const kv = await Deno.openKv();
// ✅ 支持多设备登录：将单个 WebSocket 连接升级为 WebSocket 集合 (Set)
const userSockets = new Map<string, Set<WebSocket>>();

// --- 辅助函数 ---
// 生成私聊的唯一ID
function getChatId(user1: string, user2: string): string {
  return [user1, user2].sort().join('-');
}

// ✅ 向特定用户的所有设备发送消息
function sendToUser(username: string, message: object) {
  const sockets = userSockets.get(username);
  if (sockets) {
    const messageStr = JSON.stringify(message);
    sockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(messageStr);
      }
    });
  }
}

// --- 加密/解密 (保持不变) ---
async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encrypt(text: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedText = new TextEncoder().encode(text);
  const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encodedText);
  const buffer = new Uint8Array(iv.length + encryptedData.byteLength);
  buffer.set(iv, 0);
  buffer.set(new Uint8Array(encryptedData), iv.length);
  return btoa(String.fromCharCode.apply(null, Array.from(buffer)));
}
async function decrypt(base64Encrypted: string, key: CryptoKey): Promise<string> {
  try {
    const buffer = Uint8Array.from(atob(base64Encrypted), c => c.charCodeAt(0));
    const iv = buffer.slice(0, 12);
    const data = buffer.slice(12);
    const decryptedData = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(decryptedData);
  } catch (e) {
    console.error("解密失败:", e);
    return "[消息解密失败]";
  }
}

// --- WebSocket 核心逻辑 ---
async function handleWs(socket: WebSocket, username: string) {
  console.log(`[用户: ${username}] 的一个新设备已连接`);
  
  // ✅ 将新连接添加到用户的设备集合中
  if (!userSockets.has(username)) {
    userSockets.set(username, new Set());
  }
  userSockets.get(username)!.add(socket);

  await kv.set(["users", username], { username, online: true });

  // 只向当前这个新设备发送初始数据
  const [friendsEntry, requestsEntry] = await kv.getMany<string[][]>([["friends", username], ["requests", username]]);
  const friends = friendsEntry.value ?? [];
  const requests = requestsEntry.value ?? [];
  socket.send(JSON.stringify({ type: "initial_data", payload: { friends, requests } }));

  socket.onmessage = async (event) => {
    const { type, payload } = JSON.parse(event.data);
    const encryptionKey = await getCryptoKey(ENCRYPTION_KEY);

    switch (type) {
      case 'get_history': {
        const { chatId } = payload;
        const history = [];
        const iter = kv.list({ prefix: ["messages", chatId] }, { reverse: true, limit: 100 });
        for await (const entry of iter) {
          const msg = entry.value as any;
          if (msg.contentType === 'encrypted-text') {
            msg.content = await decrypt(msg.content, encryptionKey);
          }
          history.push(msg);
        }
        // 只把历史记录发给请求的这个设备
        socket.send(JSON.stringify({ type: "history", payload: { chatId, messages: history.reverse() } }));
        break;
      }

      case 'send_message': {
        const { chatId, content } = payload;
        const [user1, user2] = chatId.split('-');
        const recipient = username === user1 ? user2 : user1;

        const messageId = crypto.randomUUID();
        const timestamp = Date.now();
        const encryptedContent = await encrypt(content, encryptionKey);

        const message = {
          id: messageId,
          chatId,
          sender: username,
          contentType: 'encrypted-text',
          content: encryptedContent,
          timestamp,
        };
        await kv.set(["messages", chatId, timestamp, messageId], message);

        const broadcastMessage = { ...message, content }; // 包含解密后内容的消息
        
        // ✅ 将消息广播给接收方的所有设备和发送方的所有设备
        sendToUser(recipient, { type: "new_message", payload: broadcastMessage });
        sendToUser(username, { type: "new_message", payload: broadcastMessage });
        break;
      }

      case 'recall_message': {
        const { messageId, chatId } = payload;
        const iter = kv.list({ prefix: ["messages", chatId] });
        for await (const entry of iter) {
          const msg = entry.value as any;
          if (msg.id === messageId && (Date.now() - msg.timestamp < RECALL_TIMEOUT_MS)) {
            const recalledMessage = { ...msg, contentType: 'recalled', content: '' };
            await kv.set(entry.key, recalledMessage);
            
            const [user1, user2] = chatId.split('-');
            const broadcastPayload = { id: messageId, chatId, username: msg.sender };
            // ✅ 将撤回通知广播给双方的所有设备
            sendToUser(user1, { type: 'recalled_message', payload: broadcastPayload });
            sendToUser(user2, { type: 'recalled_message', payload: broadcastPayload });
            break;
          }
        }
        break;
      }

      case 'add_friend': {
        // ... (这部分逻辑保持不变)
        const { friendUsername } = payload;
        if (friendUsername === username) return;
        const friendExists = (await kv.get(["users", friendUsername])).value !== null;
        if (!friendExists) {
          sendToUser(username, { type: 'error', payload: '用户不存在' });
          return;
        }
        const requestsEntry = await kv.get<string[]>(["requests", friendUsername]);
        const currentRequests = requestsEntry.value ?? [];
        if (!currentRequests.includes(username)) {
            currentRequests.push(username);
            await kv.set(["requests", friendUsername], currentRequests);
        }
        sendToUser(friendUsername, { type: 'new_friend_request', payload: username });
        sendToUser(username, { type: 'info', payload: '好友请求已发送' });
        break;
      }

      case 'accept_friend': {
        // ... (这部分逻辑也基本不变，只是通知方式改变)
        const { friendUsername } = payload;
        const myFriendsEntry = await kv.get<string[]>(["friends", username]);
        const myFriends = myFriendsEntry.value ?? [];
        if (!myFriends.includes(friendUsername)) myFriends.push(friendUsername);
        const theirFriendsEntry = await kv.get<string[]>(["friends", friendUsername]);
        const theirFriends = theirFriendsEntry.value ?? [];
        if (!theirFriends.includes(username)) theirFriends.push(username);
        const myRequestsEntry = await kv.get<string[]>(["requests", username]);
        const myRequests = myRequestsEntry.value ?? [];
        const updatedRequests = myRequests.filter(req => req !== friendUsername);
        await kv.atomic()
          .set(["friends", username], myFriends)
          .set(["friends", friendUsername], theirFriends)
          .set(["requests", username], updatedRequests)
          .commit();
        sendToUser(username, { type: 'friend_added', payload: friendUsername });
        sendToUser(friendUsername, { type: 'friend_added', payload: username });
        break;
      }
      
      case 'delete_friend': {
        // ... (这部分逻辑也基本不变，只是通知方式改变)
        const { friendUsername } = payload;
        const chatId = getChatId(username, friendUsername);
        const myFriends = ((await kv.get<string[]>(["friends", username])).value ?? []).filter(f => f !== friendUsername);
        const theirFriends = ((await kv.get<string[]>(["friends", friendUsername])).value ?? []).filter(f => f !== username);
        const atomicOp = kv.atomic()
            .set(["friends", username], myFriends)
            .set(["friends", friendUsername], theirFriends);
        const iter = kv.list({ prefix: ["messages", chatId] });
        for await (const entry of iter) {
            atomicOp.delete(entry.key);
        }
        await atomicOp.commit();
        sendToUser(username, { type: 'friend_deleted', payload: friendUsername });
        sendToUser(friendUsername, { type: 'friend_deleted', payload: username });
        break;
      }
    }
  };

  socket.onclose = async () => {
    console.log(`[用户: ${username}] 的一个设备已断开`);
    const userSocketSet = userSockets.get(username);
    if (userSocketSet) {
      // ✅ 从设备集合中移除当前这个断开的连接
      userSocketSet.delete(socket);
      // 如果该用户的所有设备都已断开，则更新在线状态
      if (userSocketSet.size === 0) {
        console.log(`[用户: ${username}] 所有设备均已离线`);
        userSockets.delete(username);
        await kv.set(["users", username], { username, online: false });
      }
    }
  };
}

// --- HTTP 请求处理器 (保持不变) ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const username = url.searchParams.get("username");
  if (url.pathname === "/ws" && username) {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWs(socket, username);
    return response;
  }
  return serveDir(req, { fsRoot: "static", urlRoot: "" });
}

console.log("🚀 聊天服务器已启动 (v3 - 终极稳定版)，访问 http://localhost:8000");
serve(handler, { port: 8000 });
