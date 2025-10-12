// my-chat-app/main.ts 
import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";

// --- 配置 ---
const ENCRYPTION_KEY = "Key-qgejDhsjTiuYenfhGFbFjkImghFn";
const RECALL_TIMEOUT_MS = 3 * 60 * 1000;

// --- 数据库和 WebSocket 管理 ---
const kv = await Deno.openKv();
// 核心升级：从单个WebSocket变为一个WebSocket集合，支持多设备登录
const userSockets = new Map<string, Set<WebSocket>>();

// --- 辅助函数 ---
// 生成私聊的唯一ID
function getChatId(user1: string, user2: string): string {
  return [user1, user2].sort().join('-');
}

// 核心升级：从向单个用户发送，变为向一个用户的所有设备广播
function broadcastToUser(username: string, message: object) {
  const sockets = userSockets.get(username);
  if (sockets) {
    const messageStr = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(messageStr);
      }
    }
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
  console.log(`[用户: ${username}] 新设备连接`);
  // 核心升级：处理多设备连接
  if (!userSockets.has(username)) {
    userSockets.set(username, new Set());
  }
  userSockets.get(username)!.add(socket);

  await kv.set(["users", username], { username, online: true });

  const [friendsEntry, requestsEntry] = await kv.getMany<string[][]>([["friends", username], ["requests", username]]);
  const friends = friendsEntry.value ?? [];
  const requests = requestsEntry.value ?? [];
  // 只向当前这个新连接的设备发送初始数据
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
        // 只向请求历史的这个设备发送历史记录
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

        // 广播给接收方的所有设备
        broadcastToUser(recipient, { type: "new_message", payload: { ...message, content } });
        // 同时为了同步，也广播给发送方的所有其他设备
        broadcastToUser(username, { type: "new_message", payload: { ...message, content } });
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
            // 向双方的所有设备广播撤回事件
            broadcastToUser(user1, { type: 'recalled_message', payload: { id: messageId, chatId, username: msg.sender } });
            broadcastToUser(user2, { type: 'recalled_message', payload: { id: messageId, chatId, username: msg.sender } });
            break;
          }
        }
        break;
      }

      case 'add_friend': {
        const { friendUsername } = payload;
        if (friendUsername === username) return;
        const friendExists = (await kv.get(["users", friendUsername])).value !== null;
        if (!friendExists) {
          broadcastToUser(username, { type: 'error', payload: '用户不存在' });
          return;
        }
        
        const requestsEntry = await kv.get<string[]>(["requests", friendUsername]);
        const currentRequests = requestsEntry.value ?? [];

        if (!currentRequests.includes(username)) {
            currentRequests.push(username);
            await kv.set(["requests", friendUsername], currentRequests);
        }

        broadcastToUser(friendUsername, { type: 'new_friend_request', payload: username });
        broadcastToUser(username, { type: 'info', payload: '好友请求已发送' });
        break;
      }

      case 'accept_friend': {
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

        broadcastToUser(username, { type: 'friend_added', payload: friendUsername });
        broadcastToUser(friendUsername, { type: 'friend_added', payload: username });
        break;
      }
      
      case 'delete_friend': {
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
        
        broadcastToUser(username, { type: 'friend_deleted', payload: friendUsername });
        broadcastToUser(friendUsername, { type: 'friend_deleted', payload: username });
        break;
      }
    }
  };

  socket.onclose = async () => {
    console.log(`[用户: ${username}] 一个设备断开连接`);
    const sockets = userSockets.get(username);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        userSockets.delete(username);
        await kv.set(["users", username], { username, online: false });
        console.log(`[用户: ${username}] 所有设备已离线`);
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

  return serveDir(req, {
    fsRoot: "static",
    urlRoot: "",
  });
}

console.log("🚀 聊天服务器已启动 (王者版)，访问 http://localhost:8000");
serve(handler, { port: 8000 });
