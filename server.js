// server.js — WhatsApp Web (não-oficial) multi-tenant, robusto e idempotente
// AVISO: automação via WhatsApp Web viola os Termos do WhatsApp. Use por sua conta e risco.

import 'dotenv/config';                  // carrega .env antes de tudo (ESM)

import express from 'express';
import QRCode from 'qrcode';
import wweb from 'whatsapp-web.js';      // CommonJS -> default import
const { Client, LocalAuth } = wweb;      // destrutura do default CJS

import { db, admin } from './firebaseAdmin.js';
import { saveSession, clearSession } from './sessionStore.js';
import { processIncomingMessage } from './lovableClient.js';

// Validação de exports do whatsapp-web.js
if (!Client || !LocalAuth) {
  throw new Error('[startup] whatsapp-web.js não exportou Client/LocalAuth. Cheque a versão instalada.');
}

// ===== Config =====
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || '';
const SESSION_STORE = (process.env.SESSION_STORE || 'firestore').toLowerCase();
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ===== App =====
const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS opcional
if (CORS_ORIGINS.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    if (CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// ===== Auth (Bearer) =====
function auth(req, res, next) {
  const hdr = req.headers['authorization'] || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!API_KEY || token === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ===== In-memory =====
const clients = new Map();         // tenantId -> { client, status, qr, readyAt }
const clientInitLocks = new Map(); // tenantId -> Promise (evita corrida)

// ===== Helpers =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cap = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) : String(s || ''));

function shouldLog(level) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  const want = (order[level] ?? 2);
  const cur = (order[LOG_LEVEL] ?? 2);
  return want <= cur;
}
function log(tenantId, level, ...args) {
  const lvl = String(level).toLowerCase();
  if (!shouldLog(lvl)) return;
  const prefix = `[${new Date().toISOString()}][${tenantId || '-'}][${level}]`;
  const fn = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
  fn(prefix, ...args);
}

// ===== Core =====
async function ensureClient(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId inválido');
  }

  // Já existe?
  const current = clients.get(tenantId);
  if (current?.client) return current;

  // Lock de inicialização p/ evitar corrida
  if (clientInitLocks.has(tenantId)) {
    await clientInitLocks.get(tenantId);
    return clients.get(tenantId);
  }

  const initPromise = (async () => {
    log(tenantId, 'INFO', 'Inicializando cliente...');
    const entry = { client: null, status: 'starting', qr: '', readyAt: null };

    // LocalAuth separa diretório por clientId (persistente no disco da VM)
    const authStrategy = new LocalAuth({ clientId: `tenant_${tenantId}` });

    const client = new Client({
      authStrategy,
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
        ],
      },
    });

    entry.client = client;
    clients.set(tenantId, entry);

    client.on('qr', async (qr) => {
      entry.qr = qr;
      entry.status = 'qr';
      log(tenantId, 'INFO', 'QR gerado (aguardando scan)');
      try { await saveSession(tenantId, { status: 'qr', ts: Date.now() }); } catch {}
    });

    client.on('ready', async () => {
      entry.status = 'ready';
      entry.readyAt = new Date().toISOString();
      log(tenantId, 'INFO', 'Cliente pronto (ready)');
      try { await saveSession(tenantId, { status: 'ready', ts: Date.now() }); } catch {}
    });

    client.on('authenticated', async () => {
      entry.status = 'authenticated';
      log(tenantId, 'INFO', 'Autenticado');
      try { await saveSession(tenantId, { status: 'authenticated', ts: Date.now() }); } catch {}
    });

    client.on('auth_failure', async (msg) => {
      entry.status = 'auth_failure';
      log(tenantId, 'ERROR', 'Falha de autenticação:', msg);
      try { await saveSession(tenantId, { status: 'auth_failure', msg, ts: Date.now() }); } catch {}
    });

    client.on('disconnected', async (reason) => {
      entry.status = 'disconnected';
      log(tenantId, 'WARN', 'Desconectado:', reason);
      try { await saveSession(tenantId, { status: 'disconnected', reason, ts: Date.now() }); } catch {}
      try { await client.destroy(); } catch {}
      clients.delete(tenantId);
    });

    // ===== Handler de mensagens (delegado ao Lovable) =====
    client.on('message', async (msg) => {
      try {
        const msgId = msg?.id?._serialized || msg?.id?.id || null;
        const from = msg?.from || '';
        const body = cap(msg?.body?.trim?.(), 4000);
        const isGroup = from.endsWith('@g.us');
        const isChat = (msg?.type || 'chat') === 'chat';

        // Ignora msgs próprias, de grupo e não-chat ANTES de logar no Firestore
        if (msg?.fromMe || isGroup || !isChat) return;
        if (!msgId || !from || !body) return;

        // Idempotência
        const ref = db.collection('tenants').doc(tenantId).collection('messages').doc(msgId);
        const exists = await ref.get();
        if (exists.exists) return;

        // Log IN
        await ref.set({
          direction: 'in',
          from,
          text: body,
          raw: {
            id: msg?.id || null,
            to: msg?.to || null,
            timestamp: msg?.timestamp || null,
            type: msg?.type || null,
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        // IA (Lovable) – a função também envia a resposta via client
        let delivered = false;
        try {
          delivered = !!(await processIncomingMessage(entry.client, msg, tenantId));
        } catch (e) {
          log(tenantId, 'ERROR', 'Lovable processIncomingMessage erro:', e?.message || e);
        }

        // Log OUT “técnico” (quem envia o texto é o próprio handler do Lovable)
        await ref.collection('parts').add({
          direction: 'out',
          delivered,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        log(tenantId, 'ERROR', 'Erro no handler de mensagem:', e?.message || e);
      }
    });

    // Inicializa
    try {
      await client.initialize();
    } catch (e) {
      entry.status = 'init_error';
      log(tenantId, 'ERROR', 'Erro ao inicializar cliente:', e?.message || e);
      throw e;
    }

    return entry;
  })();

  clientInitLocks.set(tenantId, initPromise);
  try {
    return await initPromise;
  } finally {
    clientInitLocks.delete(tenantId);
  }
}

// ===== Rotas =====
app.post('/sessions/:tenantId', auth, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const entry = await ensureClient(tenantId);
    return res.json({ tenantId, status: entry.status, readyAt: entry.readyAt || null });
  } catch (e) {
    log(tenantId, 'ERROR', 'create session error:', e?.message || e);
    return res.status(500).json({ error: 'create_session_failed' });
  }
});

app.get('/sessions/:tenantId/qr', auth, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const entry = await ensureClient(tenantId);
    if (!entry.qr) return res.json({ tenantId, status: entry.status, qr: null });
    try {
      const svg = await QRCode.toString(entry.qr, { type: 'svg' });
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    } catch (e) {
      log(tenantId, 'ERROR', 'qr encode error:', e?.message || e);
      return res.status(500).json({ error: 'qr_encode_failed' });
    }
  } catch (e) {
    log(tenantId, 'ERROR', 'qr error:', e?.message || e);
    return res.status(500).json({ error: 'qr_failed' });
  }
});

app.get('/sessions/:tenantId/status', auth, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const entry = await ensureClient(tenantId);
    return res.json({ tenantId, status: entry.status, readyAt: entry.readyAt || null });
  } catch (e) {
    log(tenantId, 'ERROR', 'status error:', e?.message || e);
    return res.status(500).json({ error: 'status_failed' });
  }
});

app.delete('/sessions/:tenantId', auth, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const entry = clients.get(tenantId);
    if (entry?.client) { try { await entry.client.destroy(); } catch {} }
    clients.delete(tenantId);
    try { await clearSession(tenantId); } catch {}
    log(tenantId, 'INFO', 'Sessão encerrada e limpa');
    return res.json({ tenantId, deleted: true });
  } catch (e) {
    log(tenantId, 'ERROR', 'delete error:', e?.message || e);
    return res.status(500).json({ error: 'delete_failed' });
  }
});

app.post('/sessions/:tenantId/sendText', auth, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'missing to/text' });

    const entry = await ensureClient(tenantId);
    let delivered = false;
    const payload = cap(text, 4000);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await entry.client.sendMessage(String(to), payload);
        delivered = true;
        break;
      } catch (e) {
        log(tenantId, 'ERROR', `sendText falha (tentativa ${attempt}):`, e?.message || e);
        if (attempt === 1) await sleep(400);
      }
    }

    await db.collection('tenants').doc(tenantId).collection('messages').add({
      direction: 'out',
      to: String(to),
      text: payload,
      delivered,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, delivered });
  } catch (e) {
    log(tenantId, 'ERROR', 'sendText error:', e?.message || e);
    return res.status(500).json({ error: 'send_failed' });
  }
});

// Health
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/ready',  (_, res) => res.status(200).send('ready'));

// ===== Start & Shutdown =====
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] WWeb multi-tenant up on :${PORT} (store=${SESSION_STORE})`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando servidor...');
  server.close(() => {
    console.log('Servidor fechado.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
