// my-chat-app/main.ts (v2 - 已修复添加好友BUG并更新密钥)

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";

// --- 配置 ---
const ENCRYPTION_KEY = "Key-qgejDhsjTiuYenfhGFbFjkImghFn";
const RECALL_TIMEOUT_MS = 3 * 60 * 1000;

// --- 数据库和 WebSocket 管理 ---
const kv = await Deno.openKv();
// 存储每个在线用户的 WebSocket 连接，键是用户名
const userSockets = new Map<string, WebSocket>();

// --- 辅助函数 ---
// 生成私聊的唯一ID
function getChatId(user1: string, user2: string): string {
  return [user1, user2].sort().join('-');
}

// 向特定用户发送消息
function sendToUser(username: string, message: object) {
  const socket = userSockets.get(username);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

// --- 加密/解密 (与之前版本相同) ---
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
  console.log(`[用户: ${username}] 已连接`);
  userSockets.set(username, socket);

  // 注册用户（如果不存在）
  await kv.set(["users", username], { username, online: true });

  // 发送初始数据：好友列表和好友请求
  const [friendsEntry, requestsEntry] = await kv.getMany<string[][]>([["friends", username], ["requests", username]]);
  const friends = friendsEntry.value ?? [];
  const requests = requestsEntry.value ?? [];
  sendToUser(username, { type: "initial_data", payload: { friends, requests } });

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
        sendToUser(username, { type: "history", payload: { chatId, messages: history.reverse() } });
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

        // 发送给接收方（解密后）
        sendToUser(recipient, { type: "new_message", payload: { ...message, content } });
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
            sendToUser(user1, { type: 'recalled_message', payload: { id: messageId, chatId, username: msg.sender } });
            sendToUser(user2, { type: 'recalled_message', payload: { id: messageId, chatId, username: msg.sender } });
            break;
          }
        }
        break;
      }

      case 'add_friend': {
        const { friendUsername } = payload;
        if (friendUsername === username) return; // 不能加自己
        const friendExists = (await kv.get(["users", friendUsername])).value !== null;
        if (!friendExists) {
          sendToUser(username, { type: 'error', payload: '用户不存在' });
          return;
        }
        
        // ✅ 这是修复后的代码
        const requestsEntry = await kv.get<string[]>(["requests", friendUsername]);
        const currentRequests = requestsEntry.value ?? [];

        if (!currentRequests.includes(username)) {
            currentRequests.push(username);
            await kv.set(["requests", friendUsername], currentRequests);
        }
        // 通知对方有新的好友请求
        sendToUser(friendUsername, { type: 'new_friend_request', payload: username });
        sendToUser(username, { type: 'info', payload: '好友请求已发送' });
        break;
      }

      case 'accept_friend': {
        const { friendUsername } = payload;
        // 1. 更新自己的好友列表
        const myFriendsEntry = await kv.get<string[]>(["friends", username]);
        const myFriends = myFriendsEntry.value ?? [];
        if (!myFriends.includes(friendUsername)) myFriends.push(friendUsername);
        
        // 2. 更新对方的好友列表
        const theirFriendsEntry = await kv.get<string[]>(["friends", friendUsername]);
        const theirFriends = theirFriendsEntry.value ?? [];
        if (!theirFriends.includes(username)) theirFriends.push(username);

        // 3. 从自己的请求列表中移除对方
        const myRequestsEntry = await kv.get<string[]>(["requests", username]);
        const myRequests = myRequestsEntry.value ?? [];
        const updatedRequests = myRequests.filter(req => req !== friendUsername);

        await kv.atomic()
          .set(["friends", username], myFriends)
          .set(["friends", friendUsername], theirFriends)
          .set(["requests", username], updatedRequests)
          .commit();

        // 4. 通知双方更新UI
        sendToUser(username, { type: 'friend_added', payload: friendUsername });
        sendToUser(friendUsername, { type: 'friend_added', payload: username });
        break;
      }
      
      case 'delete_friend': {
        const { friendUsername } = payload;
        const chatId = getChatId(username, friendUsername);

        // 1. 更新双方好友列表
        const myFriends = ((await kv.get<string[]>(["friends", username])).value ?? []).filter(f => f !== friendUsername);
        const theirFriends = ((await kv.get<string[]>(["friends", friendUsername])).value ?? []).filter(f => f !== username);

        const atomicOp = kv.atomic()
            .set(["friends", username], myFriends)
            .set(["friends", friendUsername], theirFriends);

        // 2. 删除聊天记录
        const iter = kv.list({ prefix: ["messages", chatId] });
        for await (const entry of iter) {
            atomicOp.delete(entry.key);
        }
        await atomicOp.commit();
        
        // 3. 通知双方删除好友
        sendToUser(username, { type: 'friend_deleted', payload: friendUsername });
        sendToUser(friendUsername, { type: 'friend_deleted', payload: username });
        break;
      }
    }
  };

  socket.onclose = async () => {
    console.log(`[用户: ${username}] 已断开`);
    userSockets.delete(username);
    await kv.set(["users", username], { username, online: false });
  };
}


// --- HTTP 请求处理器 ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const username = url.searchParams.get("username");

  if (url.pathname === "/ws" && username) {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWs(socket, username);
    return response;
  }

  // 托管 static 文件夹下的所有前端文件
  return serveDir(req, {
    fsRoot: "static",
    urlRoot: "",
  });
}

console.log("🚀 聊天服务器已启动，访问 http://localhost:8000");
serve(handler, { port: 8000 });

