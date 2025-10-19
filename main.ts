// my-chat-app/main.ts (v5 - 决定性修复版)

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";
// ✅ 引入 Deno 官方标准库中的 Base64 模块，这是最可靠的方法
import { encode, decode } from "std/encoding/base64.ts";

// --- 配置 ---
const ENCRYPTION_KEY = "Key-qgejDhsjTiuYenfhGFbFjkImghFn"; // 你的密钥
const RECALL_TIMEOUT_MS = 3 * 60 * 1000;

// --- 数据库和 WebSocket 管理 (无变化) ---
const kv = await Deno.openKv();
const userSockets = new Map<string, Set<WebSocket>>();

// --- 辅助函数 (无变化) ---
function getChatId(user1: string, user2: string): string {
  return [user1, user2].sort().join('-');
}

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

// --- 加密/解密 (✅ 关键修复！) ---
async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// ✅ 使用官方标准库重写加密函数，彻底解决发送失败问题
async function encrypt(text: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedText = new TextEncoder().encode(text);
  const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encodedText);
  
  // 将 iv 和加密数据合并成一个 buffer
  const combinedBuffer = new Uint8Array(iv.length + encryptedData.byteLength);
  combinedBuffer.set(iv, 0);
  combinedBuffer.set(new Uint8Array(encryptedData), iv.length);
  
  // 使用官方、稳定的 `encode` 方法进行 Base64 编码
  return encode(combinedBuffer);
}

// ✅ 使用官方标准库重写解密函数，确保与加密函数匹配
async function decrypt(base64Encrypted: string, key: CryptoKey): Promise<string> {
  try {
    // 使用官方、稳定的 `decode` 方法进行 Base64 解码
    const combinedBuffer = decode(base64Encrypted);
    
    const iv = combinedBuffer.slice(0, 12);
    const data = combinedBuffer.slice(12);
    
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
  
  if (!userSockets.has(username)) {
    userSockets.set(username, new Set());
  }
  userSockets.get(username)!.add(socket);

  await kv.set(["users", username], { username, online: true });

  const [friendsEntry, requestsEntry] = await kv.getMany<string[][]>([["friends", username], ["requests", username]]);
  const friends = friendsEntry.value ?? [];
  const requests = requestsEntry.value ?? [];
  socket.send(JSON.stringify({ type: "initial_data", payload: { friends, requests } }));

  socket.onmessage = async (event) => {
    // ✅ 增加顶层 try...catch，防止任何意外错误导致连接崩溃
    try {
      const { type, payload } = JSON.parse(event.data);
      const encryptionKey = await getCryptoKey(ENCRYPTION_KEY);

      switch (type) {
        case 'get_history': {
          const { chatId } = payload;
          const history = [];
          const iter = kv.list({ prefix: ["messages", chatId] }, { reverse: true, limit: 100 });
          for await (const entry of iter) {
            const msg = entry.value as any;
            if (msg.contentType === 'encrypted-text' && msg.content) {
              msg.content = await decrypt(msg.content, encryptionKey);
            }
            history.push(msg);
          }
          socket.send(JSON.stringify({ type: "history", payload: { chatId, messages: history.reverse() } }));
          break;
        }

        case 'send_message': {
          const { chatId, content } = payload;
          const recipient = chatId.replace(username, '').replace('-', '');

          const messageId = crypto.randomUUID();
          const timestamp = Date.now();
          const encryptedContent = await encrypt(content, encryptionKey);

          const messageToStore = {
            id: messageId,
            chatId,
            sender: username,
            contentType: 'encrypted-text',
            content: encryptedContent,
            timestamp,
          };
          await kv.set(["messages", chatId, timestamp, messageId], messageToStore);

          const messageToBroadcast = { ...messageToStore, content: content };
          
          sendToUser(recipient, { type: "new_message", payload: messageToBroadcast });
          sendToUser(username, { type: "new_message", payload: messageToBroadcast });
          break;
        }
        
        // 其他 case 保持不变...
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
              sendToUser(user1, { type: 'recalled_message', payload: broadcastPayload });
              sendToUser(user2, { type: 'recalled_message', payload: broadcastPayload });
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
    } catch (error) {
      console.error("处理 WebSocket 消息时发生严重错误:", error);
    }
  };

  socket.onclose = async () => {
    console.log(`[用户: ${username}] 的一个设备已断开`);
    const userSocketSet = userSockets.get(username);
    if (userSocketSet) {
      userSocketSet.delete(socket);
      if (userSocketSet.size === 0) {
        console.log(`[用户: ${username}] 所有设备均已离线`);
        userSockets.delete(username);
        await kv.set(["users", username], { username, online: false });
      }
    }
  };
}

// --- HTTP 请求处理器 (无变化) ---
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

console.log("🚀 聊天服务器已启动 (v5 - 决定性修复版)，访问 http://localhost:8000");
serve(handler, { port: 8000 });
