import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { closeSync, fchmodSync, openSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSession } from './core.js';
import { exerciseById } from './exercises.js';

const root = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const allowedFiles = new Set(['index.html', 'app.js', 'core.js', 'exercises.js', 'exercises-data.js', 'repdb-data.js', 'legacy-exercises.js', 'equipment-audit.js', 'style.css', 'account.html', 'account.js', 'portal.html', 'portal.js', 'client.html', 'client.js', 'tracker.js', 'tracker.css']);
const professionalFiles = new Set(['app.js', 'exercises.js', 'exercises-data.js', 'repdb-data.js', 'legacy-exercises.js', 'portal.js']);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const calculated = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === calculated.length && timingSafeEqual(expected, calculated);
}

function credentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body.password;
  if (email.length > 254 || !emailPattern.test(email) || typeof password !== 'string' || password.length < 12 || password.length > 256) {
    fail(400, 'Adresse e-mail invalide ou mot de passe de moins de 12 caractères.');
  }
  return { email, password };
}

async function bodyJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) fail(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return { raw, data: JSON.parse(raw || '{}') }; }
  catch { fail(400, 'JSON invalide.'); }
}

function stripeSignature(raw, header, secret) {
  const fields = String(header || '').split(',').map(part => part.split('='));
  const timestamp = fields.find(([key]) => key === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now() - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  return fields.filter(([key]) => key === 'v1').some(([, value]) => {
    if (!/^[a-f0-9]{64}$/i.test(value || '')) return false;
    return timingSafeEqual(expected, Buffer.from(value, 'hex'));
  });
}

export function createApp({ database = 'tracker.sqlite', appUrl = 'http://localhost:3000', stripeKey = '', stripePrice = '', stripeWebhookSecret = '', stripeFetch = fetch } = {}) {
  const origin = new URL(appUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(origin.hostname))) {
    throw new Error('APP_URL doit être une origine HTTPS, ou localhost pour le développement.');
  }
  const secure = origin.protocol === 'https:';
  if (database !== ':memory:') {
    const fd = openSync(database, 'a', 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  }
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professional','client')),
      professional_id INTEGER REFERENCES users(id), stripe_customer TEXT UNIQUE, stripe_customer_key TEXT,
      stripe_checkout TEXT, stripe_checkout_key TEXT,
      paid INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES users(id),
      client_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, items TEXT NOT NULL,
      created_at INTEGER NOT NULL, completed_at INTEGER, feedback TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS exercise_feedback (
      assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      item_index INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
      feedback TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, item_index)
    );`);
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!userColumns.includes('stripe_customer_key')) db.exec('ALTER TABLE users ADD COLUMN stripe_customer_key TEXT');
  if (!userColumns.includes('stripe_checkout')) db.exec('ALTER TABLE users ADD COLUMN stripe_checkout TEXT');
  if (!userColumns.includes('stripe_checkout_key')) db.exec('ALTER TABLE users ADD COLUMN stripe_checkout_key TEXT');
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const attempts = new Map();
  const cookie = (value, maxAge) => `tracker_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  function userFor(req) {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tracker_session='))?.slice(16);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    return get('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?', digest(raw), now());
  }
  function revokeSession(req) {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tracker_session='))?.slice(16);
    if (raw) run('DELETE FROM sessions WHERE token_hash=?', digest(raw));
  }
  function login(res, userId) {
    const raw = token();
    run('DELETE FROM sessions WHERE expires_at<=?', now());
    run('INSERT INTO sessions VALUES (?,?,?)', digest(raw), userId, now() + 7 * 86400);
    res.setHeader('Set-Cookie', cookie(raw, 7 * 86400));
  }
  function requireRole(req, role) {
    const user = userFor(req);
    if (!user) fail(401, 'Connectez-vous pour continuer.');
    if (role && user.role !== role) fail(403, 'Accès interdit.');
    return user;
  }
  function rateLimit(req) {
    const key = req.socket.remoteAddress || 'unknown';
    const cutoff = Date.now() - 15 * 60 * 1000;
    const previous = (attempts.get(key) || []).filter(t => t > cutoff);
    if (previous.length >= 20) fail(429, 'Trop de tentatives. Réessayez plus tard.');
    previous.push(Date.now());
    attempts.set(key, previous);
    if (attempts.size > 10000) {
      for (const [address, times] of attempts) if (times.at(-1) <= cutoff) attempts.delete(address);
    }
  }
  async function stripe(path, params, idempotencyKey) {
    if (!stripeKey || !stripePrice || !stripeWebhookSecret) fail(503, 'Le paiement n’est pas configuré.');
    const response = await stripeFetch(`https://api.stripe.com/v1/${path}`, {
      method: params ? 'POST' : 'GET',
      headers: { Authorization:`Bearer ${stripeKey}`, ...(params ? {'Content-Type':'application/x-www-form-urlencoded'} : {}),
        ...(idempotencyKey ? {'Idempotency-Key':idempotencyKey} : {}) },
      ...(params ? {body:new URLSearchParams(params)} : {})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Stripe API error: ${response.status}`);
    return result;
  }
  function json(res, status, data) {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(JSON.stringify(data));
  }
  function assignmentRow(row) {
    const items = JSON.parse(row.items).map(item => {
      const exercise = exerciseById(item.exerciseId);
      return {...item, exercise:exercise ? {name:exercise.name, steps:exercise.steps} : null};
    });
    return { id:row.id, clientId:row.client_id, clientEmail:row.client_email, name:row.name, items, createdAt:row.created_at, completedAt:row.completed_at, feedback:row.feedback,
      exercises:all('SELECT item_index AS itemIndex, completed, feedback, updated_at AS updatedAt FROM exercise_feedback WHERE assignment_id=? ORDER BY item_index', row.id) };
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://raw.githubusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'POST' && path !== '/api/stripe/webhook' && req.headers.origin !== origin.origin) fail(403, 'Origine non autorisée.');
      if (req.method === 'POST' && path === '/api/stripe/webhook') {
        if (!stripeWebhookSecret) fail(503, 'Webhook non configuré.');
        const { raw, data } = await bodyJson(req);
        if (!stripeSignature(raw, req.headers['stripe-signature'], stripeWebhookSecret)) fail(400, 'Signature invalide.');
        if (['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','checkout.session.completed'].includes(data.type)) {
          const customer = data.data?.object?.customer;
          if (typeof customer === 'string') {
            const user = get('SELECT id FROM users WHERE stripe_customer=? AND role=?', customer, 'professional');
            if (user) {
              const subscriptions = await stripe(`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`);
              if (subscriptions.has_more) throw new Error('Stripe subscription list exceeds limit');
              const paid = subscriptions.data.some(s => ['active','trialing'].includes(s.status) && s.items?.data?.some(item => item.price?.id === stripePrice));
              run('UPDATE users SET paid=?, stripe_checkout=CASE WHEN ? THEN NULL ELSE stripe_checkout END, stripe_checkout_key=CASE WHEN ? THEN NULL ELSE stripe_checkout_key END WHERE id=?', paid ? 1 : 0, paid ? 1 : 0, paid ? 1 : 0, user.id);
            }
          }
        }
        return json(res, 200, {received:true});
      }
      if (req.method === 'POST' && path.startsWith('/api/')) {
        const { data } = await bodyJson(req);
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Requête invalide.');
        if (path === '/api/register') {
          rateLimit(req);
          const {email, password} = credentials(data);
          let professionalId = null, invite;
          if (data.invite) {
            if (typeof data.invite !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.invite)) fail(400, 'Invitation invalide.');
          }
          const hash = passwordHash(password);
          db.exec('BEGIN IMMEDIATE');
          let result;
          try {
            if (get('SELECT id FROM users WHERE email=?', email)) fail(409, 'Cette adresse possède déjà un compte.');
            if (data.invite) {
              invite = get('SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?', digest(data.invite), now());
              if (!invite) fail(400, 'Invitation expirée ou déjà utilisée.');
              professionalId = invite.professional_id;
              const pro = get('SELECT paid FROM users WHERE id=? AND role=?', professionalId, 'professional');
              const count = get('SELECT count(*) AS n FROM users WHERE professional_id=?', professionalId).n;
              if (!pro || (!pro.paid && count >= 1)) fail(403, 'La limite de clients de ce professionnel est atteinte.');
            }
            result = run('INSERT INTO users (email,password,role,professional_id,created_at) VALUES (?,?,?,?,?)', email, hash, invite ? 'client' : 'professional', professionalId, now());
            if (invite) run('UPDATE invites SET used_at=? WHERE token_hash=?', now(), invite.token_hash);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          revokeSession(req);
          login(res, Number(result.lastInsertRowid));
          return json(res, 201, {role:invite ? 'client' : 'professional'});
        }
        if (path === '/api/login') {
          rateLimit(req);
          const {email, password} = credentials(data);
          const user = get('SELECT * FROM users WHERE email=?', email);
          const dummy = '00000000000000000000000000000000:' + '0'.repeat(128);
          if (!passwordMatches(password, user?.password || dummy) || !user) fail(401, 'Identifiants incorrects.');
          revokeSession(req);
          login(res, user.id);
          return json(res, 200, {role:user.role});
        }
        if (path === '/api/logout') {
          revokeSession(req);
          res.setHeader('Set-Cookie', cookie('', 0));
          return json(res, 200, {ok:true});
        }
        if (path === '/api/invites') {
          const user = requireRole(req, 'professional');
          rateLimit(req);
          const count = get('SELECT count(*) AS n FROM users WHERE professional_id=?', user.id).n;
          if (!user.paid && count >= 1) fail(403, 'Offre gratuite : un seul client.');
          const raw = token();
          run('INSERT INTO invites (token_hash,professional_id,expires_at) VALUES (?,?,?)', digest(raw), user.id, now() + 7 * 86400);
          return json(res, 201, {url:`${origin.origin}/account.html#invite=${raw}`});
        }
        if (path === '/api/assignments') {
          const user = requireRole(req, 'professional');
          if (!Number.isSafeInteger(data.clientId) || !get('SELECT id FROM users WHERE id=? AND professional_id=? AND role=?', data.clientId, user.id, 'client')) fail(404, 'Client introuvable.');
          let session;
          try { session = importSession(JSON.stringify(data.session), exerciseById); }
          catch (error) { fail(400, error.message); }
          if (session.items.length > 100) fail(400, 'La séance dépasse 100 exercices.');
          db.exec('BEGIN IMMEDIATE');
          let result;
          try {
            const current = get('SELECT paid FROM users WHERE id=?', user.id);
            if (!current.paid && get('SELECT count(*) AS n FROM assignments WHERE professional_id=?', user.id).n >= 3) fail(403, 'Offre gratuite : trois séances attribuées au maximum.');
            result = run('INSERT INTO assignments (professional_id,client_id,name,items,created_at) VALUES (?,?,?,?,?)', user.id, data.clientId, session.name, JSON.stringify(session.items), now());
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          return json(res, 201, {id:Number(result.lastInsertRowid)});
        }
        const feedbackMatch = path.match(/^\/api\/assignments\/(\d+)\/(exercise|session)$/);
        if (feedbackMatch) {
          const user = requireRole(req, 'client');
          const assignment = get('SELECT * FROM assignments WHERE id=? AND client_id=?', Number(feedbackMatch[1]), user.id);
          if (!assignment) fail(404, 'Séance introuvable.');
          if (typeof data.feedback !== 'string' || data.feedback.length > 2000 || typeof data.completed !== 'boolean') fail(400, 'Feedback invalide.');
          if (feedbackMatch[2] === 'exercise') {
            if (!Number.isInteger(data.index) || data.index < 0 || data.index >= JSON.parse(assignment.items).length) fail(400, 'Exercice invalide.');
            run(`INSERT INTO exercise_feedback VALUES (?,?,?,?,?) ON CONFLICT(assignment_id,item_index)
              DO UPDATE SET completed=excluded.completed,feedback=excluded.feedback,updated_at=excluded.updated_at`,
              assignment.id, data.index, data.completed ? 1 : 0, data.feedback, now());
          } else {
            run('UPDATE assignments SET completed_at=?,feedback=? WHERE id=?', data.completed ? (assignment.completed_at || now()) : null, data.feedback, assignment.id);
          }
          return json(res, 200, {ok:true});
        }
        if (path === '/api/billing/checkout') {
          const user = requireRole(req, 'professional');
          if (user.paid) fail(409, 'Votre abonnement est déjà actif.');
          let customer = user.stripe_customer;
          if (!customer) {
            run('UPDATE users SET stripe_customer_key=? WHERE id=? AND stripe_customer_key IS NULL', token(), user.id);
            const customerKey = get('SELECT stripe_customer_key FROM users WHERE id=?', user.id).stripe_customer_key;
            const result = await stripe('customers', {email:user.email, 'metadata[professional_id]':String(user.id)}, `customer-${customerKey}`);
            customer = result.id;
            run('UPDATE users SET stripe_customer=? WHERE id=? AND stripe_customer IS NULL', customer, user.id);
            customer = get('SELECT stripe_customer FROM users WHERE id=?', user.id).stripe_customer;
          }
          const checkout = get('SELECT stripe_checkout FROM users WHERE id=?', user.id).stripe_checkout;
          if (checkout) {
            const existing = await stripe(`checkout/sessions/${encodeURIComponent(checkout)}`);
            if (existing.status === 'open' && existing.url) return json(res, 200, {url:existing.url});
            if (existing.status === 'complete') fail(409, 'Paiement en cours de vérification ; consultez votre abonnement.');
            if (existing.status !== 'expired') throw new Error('Stripe checkout returned an unexpected status');
            run('UPDATE users SET stripe_checkout=NULL,stripe_checkout_key=NULL WHERE id=? AND stripe_checkout=?', user.id, checkout);
          }
          run('UPDATE users SET stripe_checkout_key=? WHERE id=? AND stripe_checkout_key IS NULL', token(), user.id);
          const checkoutKey = get('SELECT stripe_checkout_key FROM users WHERE id=?', user.id).stripe_checkout_key;
          const result = await stripe('checkout/sessions', {
            mode:'subscription', customer, 'line_items[0][price]':stripePrice, 'line_items[0][quantity]':'1',
            success_url:`${origin.origin}/portal.html?payment=success`, cancel_url:`${origin.origin}/portal.html?payment=cancelled`
          }, `checkout-${checkoutKey}`);
          if (!result.id || !result.url) throw new Error('Stripe checkout response is incomplete');
          run('UPDATE users SET stripe_checkout=? WHERE id=? AND stripe_checkout_key=?', result.id, user.id, checkoutKey);
          return json(res, 200, {url:result.url});
        }
        if (path === '/api/billing/portal') {
          const user = requireRole(req, 'professional');
          if (!user.stripe_customer) fail(400, 'Aucun abonnement à gérer.');
          const result = await stripe('billing_portal/sessions', {customer:user.stripe_customer, return_url:`${origin.origin}/portal.html`});
          return json(res, 200, {url:result.url});
        }
      }
      if (req.method === 'GET' && path === '/api/me') {
        const user = requireRole(req);
        return json(res, 200, {id:user.id, email:user.email, role:user.role, paid:!!user.paid});
      }
      if (req.method === 'GET' && path === '/api/clients') {
        const user = requireRole(req, 'professional');
        return json(res, 200, all('SELECT id,email,created_at AS createdAt FROM users WHERE professional_id=? AND role=? ORDER BY email', user.id, 'client'));
      }
      if (req.method === 'GET' && path === '/api/assignments') {
        const user = requireRole(req);
        const column = user.role === 'professional' ? 'a.professional_id' : 'a.client_id';
        const rows = all(`SELECT a.*, u.email AS client_email FROM assignments a JOIN users u ON u.id=a.client_id WHERE ${column}=? ORDER BY a.created_at DESC,a.id DESC`, user.id);
        return json(res, 200, rows.map(assignmentRow));
      }
      if (req.method === 'GET' && (path === '/' || allowedFiles.has(path.slice(1)))) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        if (professionalFiles.has(file)) requireRole(req, 'professional');
        if (file === 'index.html' || file === 'portal.html' || file === 'client.html') {
          const user = userFor(req);
          if (!user) { res.writeHead(302, {Location:'/account.html'}); return res.end(); }
          if ((file === 'client.html') !== (user.role === 'client')) {
            res.writeHead(302, {Location:user.role === 'client' ? '/client.html' : '/portal.html'}); return res.end();
          }
        }
        const content = await readFile(join(root, file));
        res.writeHead(200, {'Content-Type':mime[extname(file)], 'Cache-Control':'no-store'});
        return res.end(content);
      }
      fail(404, 'Page introuvable.');
    } catch (error) {
      if (!error.status) console.error('Erreur serveur:', error);
      if (!res.headersSent) return json(res, error.status || 500, {error:error.status ? error.message : 'Erreur interne du serveur.'});
      res.end();
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const server = createApp({database:process.env.DATABASE_PATH || 'tracker.sqlite', appUrl,
    stripeKey:process.env.STRIPE_SECRET_KEY, stripePrice:process.env.STRIPE_PRICE_ID, stripeWebhookSecret:process.env.STRIPE_WEBHOOK_SECRET});
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Fitness Tracker écoute sur ${appUrl}`));
}
