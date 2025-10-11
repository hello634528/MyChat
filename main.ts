// my-chat-app/main.ts

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";

const ENCRYPTION_KEY = "Key-qgejDhsjTiuYenfhGFbFjkImghFn";
const RECALL_TIMEOUT_MS = 3 * 60 * 1000;

const kv = await Deno.openKv();
const userSockets = new Map<string, Set<WebSocket>>();

function getChatId(user1: string, user2: string): string {
  return [user1, user2].sort().join('-');
}

function sendToUser(username: string, message: object) {
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

async function handleWs(socket: WebSocket, username: string) {
  console.log(`[用户: ${username}] 的一个新设备已连接`);
  const sockets = userSockets.get(username) ?? new Set();
  sockets.add(socket);
  userSockets.set(username, sockets);

  await kv.set(["users", username], { username, online: true });

  const [friendsEntry, requestsEntry] = await kv.getMany<string[][]>([["friends", username], ["requests", username]]);
  socket.send(JSON.stringify({ type: "initial_data", payload: { friends: friendsEntry.value ?? [], requests: requestsEntry.value ?? [] } }));

  socket.onmessage = async (event) => {
    const { type, payload } = JSON.parse(event.data);
    const encryptionKey = await getCryptoKey(ENCRYPTION_KEY);

    switch (type) {
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'get_history': {
        const { chatId } = payload;
        const history = [];
        const iter = kv.list({ prefix: ["messages", chatId] }, { reverse: true, limit: 100 });
        for await (const entry of iter) {
          const msg = entry.value as any;
          if (msg.contentType === 'encrypted-text') msg.content = await decrypt(msg.content, encryptionKey);
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
        sendToUser(recipient, { type: "new_message", payload: { ...message, content } });
        const senderSockets = userSockets.get(username);
        if (senderSockets) {
            for (const s of senderSockets) {
                if (s !== socket && s.readyState === WebSocket.OPEN) {
                    s.send(JSON.stringify({ type: "new_message", payload: { ...message, content, isEcho: true } }));
                }
            }
        }
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
            const recallPayload = { id: messageId, chatId, username: msg.sender };
            sendToUser(user1, { type: 'recalled_message', payload: recallPayload });
            sendToUser(user2, { type: 'recalled_message', payload: recallPayload });
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
          socket.send(JSON.stringify({ type: 'error', payload: '用户不存在' }));
          return;
        }
        const requestsEntry = await kv.get<string[]>(["requests", friendUsername]);
        const currentRequests = requestsEntry.value ?? [];
        if (!currentRequests.includes(username)) {
            currentRequests.push(username);
            await kv.set(["requests", friendUsername], currentRequests);
        }
        sendToUser(friendUsername, { type: 'new_friend_request', payload: username });
        socket.send(JSON.stringify({ type: 'info', payload: '好友请求已发送' }));
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
        const updatedRequests = (myRequestsEntry.value ?? []).filter(req => req !== friendUsername);
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
        for await (const entry of iter) { atomicOp.delete(entry.key); }
        await atomicOp.commit();
        sendToUser(username, { type: 'friend_deleted', payload: friendUsername });
        sendToUser(friendUsername, { type: 'friend_deleted', payload: username });
        break;
      }
      
      // ！！！新增：删除账户的终极逻辑
      case 'delete_account': {
        console.log(`[用户: ${username}] 请求删除账户`);
        const atomicOp = kv.atomic();
        
        // 1. 从所有好友的好友列表中移除自己，并删除聊天记录
        const friendsEntry = await kv.get<string[]>(["friends", username]);
        if (friendsEntry.value) {
            for (const friend of friendsEntry.value) {
                const theirFriendsEntry = await kv.get<string[]>([ "friends", friend]);
                if (theirFriendsEntry.value) {
                    const updatedTheirFriends = theirFriendsEntry.value.filter(f => f !== username);
                    atomicOp.set(["friends", friend], updatedTheirFriends);
                }
                const chatId = getChatId(username, friend);
                const iter = kv.list({ prefix: ["messages", chatId] });
                for await (const entry of iter) {
                    atomicOp.delete(entry.key);
                }
                // 通知好友
                sendToUser(friend, { type: 'friend_deleted', payload: username });
            }
        }
        
        // 2. 删除自己的所有数据
        atomicOp.delete(["users", username]);
        atomicOp.delete(["friends", username]);
        atomicOp.delete(["requests", username]);
        
        // 3. 提交所有数据库更改
        await atomicOp.commit();
        
        // 4. 通知此设备操作成功，然后关闭所有连接
        socket.send(JSON.stringify({ type: 'account_deleted' }));
        const userConns = userSockets.get(username);
        if (userConns) {
            for (const s of userConns) {
                s.close();
            }
        }
        console.log(`[用户: ${username}] 账户已成功删除`);
        break;
      }
    }
  };

  socket.onclose = async () => {
    console.log(`[用户: ${username}] 的一个设备已断开`);
    const sockets = userSockets.get(username);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        userSockets.delete(username);
        await kv.set(["users", username], { username, online: false });
        console.log(`[用户: ${username}] 已完全离线`);
      }
    }
  };
}

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

console.log("🚀 聊天服务器已启动，访问 http://localhost:8000");
serve(handler, { port: 8000 });
