// Live socket demo: Ada and Tunde chat in real time.
// Usage (Command Prompt, project folder, server running):
//   set CHAT=<chat id>   set ADA=<ada token>   set TUNDE=<tunde token>   (and optionally set URL=http://localhost:4000)
//   node scripts/socket-demo.mjs
import { io } from 'socket.io-client';

const { ADA, TUNDE, CHAT } = process.env;
const URL = process.env.URL || 'http://localhost:4000';
if (!ADA || !TUNDE || !CHAT) {
  console.error('Set ADA, TUNDE and CHAT first (tokens from "npm run seed", chat id from POST /api/v1/chats/direct).');
  process.exit(1);
}

const log = (who, text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${who.padEnd(6)} ${text}`);
const connect = (name, token) =>
  new Promise((resolve, reject) => {
    const s = io(URL, { path: '/ws/v1/chat', auth: { token }, transports: ['websocket'] });
    s.once('READY', () => {
      log(name, 'connected and READY');
      resolve(s);
    });
    s.once('connect_error', (err) => reject(new Error(`${name} could not connect: ${err.message}`)));
  });
const once = (s, event) => new Promise((resolve) => s.once(event, resolve));
const timeout = setTimeout(() => {
  console.error('Timed out after 30 seconds. Is the server running, and are the tokens and chat id correct?');
  process.exit(1);
}, 30000);

try {
  const ada = await connect('Ada', ADA);
  const tunde = await connect('Tunde', TUNDE);

  // 1. Ada sends a message over the socket; Tunde receives it instantly.
  const incoming = once(tunde, 'NEW_MESSAGE');
  const ack = await new Promise((resolve) =>
    ada.emit('SEND_MESSAGE', { conversationId: CHAT, clientMessageId: `demo-${Date.now()}`, text: 'Live message from the socket demo' }, resolve),
  );
  log('Ada', `sent message, server ack: ${JSON.stringify(ack)}`);
  const message = await incoming;
  log('Tunde', `received NEW_MESSAGE: "${message.text}"`);

  // 2. Tunde starts typing; Ada sees the typing indicator.
  const typing = once(ada, 'TYPING');
  tunde.emit('TYPING_START', { conversationId: CHAT });
  log('Ada', `received TYPING: ${JSON.stringify(await typing)}`);

  // 3. Tunde reads the message; Ada gets a read receipt.
  const receipt = once(ada, 'READ_RECEIPT');
  tunde.emit('MARK_READ', { conversationId: CHAT, messageId: ack.messageId });
  log('Ada', `received READ_RECEIPT: ${JSON.stringify(await receipt)}`);

  console.log('\nAll three realtime events worked.');
  ada.close();
  tunde.close();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  process.exit(process.exitCode ?? 0);
}
