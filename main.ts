// my-chat-app/main.ts (v7 - 终极健壮版)

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";
import { encodeBase64 } from "std/encoding/base64.ts";

// --- 配置 ---
const ENCRYPTION_KEY = "Key-qgejDhsjTiuYenfhGFbFjkImghFn";
const RECALL_TIMEOUT_MS = 3 * 60 * 1000;

// --- 数据库和 WebSocket 管理 ---
const kv = await Deno.openKv();
const userSockets = new Map<string, Set<WebSocket>>();

// --- 辅助函数 ---
function getChatId(user1: string, user2: string): string {
  return [user1, user2].sort().join('-');
}

function sendToUser(username: string, message: object) {
  const sockets = userSockets.get(username);
  if (sockets) {
    try {
      const messageStr = JSON.stringify(message);
      sockets.forEach(socket => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(messageStr);
        }
      });
    } catch (e) {
      console.error(`[服务器] 向用户 ${username} 发送消息时 JSON.stringify 失败:`, e);
    }
  }
}

// --- 加密/解密 ---
async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(text: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedText = new TextEncoder().encode(text);
  const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encodedText);
  const resultBuffer = new Uint8Array(iv.length + encryptedData.byteLength);
  resultBuffer.set(iv, 0);
  resultBuffer.set(new Uint8Array(encryptedData), iv.length);
  return encodeBase64(resultBuffer);
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
  if (!userSockets.has(username)) userSockets.set(username, new Set());
  userSockets.get(username)!.add(socket);
  await kv.set(["users", username], { username, online: true });

  const [friendsEntry, requestsEntry] = await kv.getMany([["friends", username], ["requests", username]]);
  const friends = Array.isArray(friendsEntry?.value) ? friendsEntry.value : [];
  const requests = Array.isArray(requestsEntry?.value) ? requestsEntry.value : [];
  socket.send(JSON.stringify({ type: "initial_data", payload: { friends, requests } }));

  socket.onmessage = async (event) => {
    const { type, payload } = JSON.parse(event.data);
    const encryptionKey = await getCryptoKey(ENCRYPTION_KEY);

    switch (type) {
      case 'get_history': { /* ... */ break; }
      case 'send_message': { /* ... */ break; }
      case 'recall_message': { /* ... */ break; }
      case 'add_friend': { /* ... */ break; }

      // ✅ 对 accept_friend 逻辑进行最终加固
      case 'accept_friend': {
        const { friendUsername } = payload;
        
        try {
            const [myFriendsEntry, theirFriendsEntry, myRequestsEntry] = await kv.getMany([
                ["friends", username],
                ["friends", friendUsername],
                ["requests", username]
            ]);

            const myFriends = Array.isArray(myFriendsEntry?.value) ? myFriendsEntry.value : [];
            const theirFriends = Array.isArray(theirFriendsEntry?.value) ? theirFriendsEntry.value : [];
            const myRequests = Array.isArray(myRequestsEntry?.value) ? myRequestsEntry.value : [];

            if (!myFriends.includes(friendUsername)) myFriends.push(friendUsername);
            if (!theirFriends.includes(username)) theirFriends.push(username);
            
            const updatedRequests = myRequests.filter(req => req !== friendUsername);

            const res = await kv.atomic()
                .set(["friends", username], myFriends)
                .set(["friends", friendUsername], theirFriends)
                .set(["requests", username], updatedRequests)
                .commit();

            if (!res.ok) throw new Error("Atomic commit failed for accepting friend.");

            sendToUser(username, { type: 'friend_added', payload: friendUsername });
            sendToUser(friendUsername, { type: 'friend_added', payload: username });

        } catch (error) {
            console.error("[服务器] 处理接受好友请求时发生严重错误:", error);
            sendToUser(username, { type: 'error', payload: '处理好友请求失败，请联系管理员。' });
        }
        break;
      }

      case 'delete_friend': { /* ... */ break; }
    }
  };

  socket.onclose = async () => { /* ... */ };

  // 隐藏了部分未改变的代码以保持简洁，请使用下面完整版的
}

// 隐藏的代码部分，请复制下面完整版的
// ...

// -----------------------------------------------------------------------------
// 请复制这个完整的、未经删节的最终版本
// -----------------------------------------------------------------------------

async function handleWs_FULL(socket: WebSocket, username: string) {
  if (!userSockets.has(username)) {
    userSockets.set(username, new Set());
  }
  userSockets.get(username)!.add(socket);
  await kv.set(["users", username], { username, online: true });

  const [friendsEntry, requestsEntry] = await kv.getMany([["friends", username], ["requests", username]]);
  // 确保即使值为 null 也能安全处理
  const friends = Array.isArray(friendsEntry?.value) ? friendsEntry.value as string[] : [];
  const requests = Array.isArray(requestsEntry?.value) ? requestsEntry.value as string[] : [];
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
        const [user1, user2] = chatId.split('-');
        const recipient = username === user1 ? user2 : user1;
        const messageId = crypto.randomUUID();
        const timestamp = Date.now();
        const encryptedContent = await encrypt(content, encryptionKey);
        const message = { id: messageId, chatId, sender: username, contentType: 'encrypted-text', content: encryptedContent, timestamp };
        await kv.set(["messages", chatId, timestamp, messageId], message);
        const broadcastMessage = { ...message, content };
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
        const currentRequests = Array.isArray(requestsEntry?.value) ? requestsEntry.value : [];
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
        try {
            const [myFriendsEntry, theirFriendsEntry, myRequestsEntry] = await kv.getMany([
                ["friends", username],
                ["friends", friendUsername],
                ["requests", username]
            ]);

            const myFriends = Array.isArray(myFriendsEntry?.value) ? myFriendsEntry.value as string[] : [];
            const theirFriends = Array.isArray(theirFriendsEntry?.value) ? theirFriendsEntry.value as string[] : [];
            const myRequests = Array.isArray(myRequestsEntry?.value) ? myRequestsEntry.value as string[] : [];

            if (!myFriends.includes(friendUsername)) myFriends.push(friendUsername);
            if (!theirFriends.includes(username)) theirFriends.push(username);
            
            const updatedRequests = myRequests.filter(req => req !== friendUsername);

            const res = await kv.atomic()
                .set(["friends", username], myFriends)
                .set(["friends", friendUsername], theirFriends)
                .set(["requests", username], updatedRequests)
                .commit();

            if (!res.ok) throw new Error("Atomic commit failed for accepting friend.");

            sendToUser(username, { type: 'friend_added', payload: friendUsername });
            sendToUser(friendUsername, { type: 'friend_added', payload: username });

        } catch (error) {
            console.error("[服务器] 处理接受好友请求时发生严重错误:", error);
            sendToUser(username, { type: 'error', payload: '处理好友请求失败，请联系管理员。' });
        }
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
  };

  socket.onclose = async () => {
    const userSocketSet = userSockets.get(username);
    if (userSocketSet) {
      userSocketSet.delete(socket);
      if (userSocketSet.size === 0) {
        userSockets.delete(username);
        await kv.set(["users", username], { username, online: false });
      }
    }
  };
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const username = url.searchParams.get("username");
  if (url.pathname === "/ws" && username) {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWs_FULL(socket, username); // 使用完整函数
    return response;
  }
  return serveDir(req, { fsRoot: "static", urlRoot: "" });
}

console.log("🚀 聊天服务器已启动 (v7 - 终极健壮版)，访问 http://localhost:8000");
serve(handler, { port: 8000 });
