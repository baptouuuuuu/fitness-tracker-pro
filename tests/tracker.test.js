import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { exercises } from '../exercises.js';

test('comptes, invitations, isolation, feedback, limites et abonnement', async t => {
  let subscriptionStatus = 'active';
  const stripeFetch = async url => {
    let response;
    if (url.endsWith('/customers')) response = {id:'cus_test'};
    else if (url.endsWith('/checkout/sessions')) response = {id:'cs_test', url:'https://checkout.stripe.com/test'};
    else if (url.endsWith('/checkout/sessions/cs_test')) response = {status:'open', url:'https://checkout.stripe.com/test'};
    else if (url.includes('/subscriptions?')) response = {has_more:false, data:[{status:subscriptionStatus, items:{data:[{price:{id:'price_test'}}]}}]};
    else throw new Error(`Unexpected Stripe request: ${url}`);
    return {ok:true, json:async () => response};
  };
  const server = createApp({database:':memory:', appUrl:'http://localhost:3000', stripeKey:'sk_test', stripePrice:'price_test', stripeWebhookSecret:'whsec_test', stripeFetch});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, {cookie, body, origin = 'http://localhost:3000', headers = {}} = {}) {
    const response = await fetch(base + path, {method:body === undefined ? 'GET' : 'POST',
      headers:{...(cookie ? {cookie} : {}), ...(body === undefined ? {} : {'Content-Type':'application/json', origin}), ...headers},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status, data:await response.json(), cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function register(email, invite) {
    return request('/api/register', {body:{email,password:'password-long-123', ...(invite ? {invite} : {})}});
  }
  const pro = await register('pro@example.com');
  const other = await register('other@example.com');
  assert.equal(pro.status, 201);
  assert.equal((await request('/api/me', {cookie:pro.cookie})).data.role, 'professional');
  assert.equal((await request('/api/invites', {cookie:pro.cookie, body:{}, origin:'http://evil.example'})).status, 403);
  const invite1 = await request('/api/invites', {cookie:pro.cookie, body:{}});
  const invite2 = await request('/api/invites', {cookie:pro.cookie, body:{}});
  const token1 = new URLSearchParams(new URL(invite1.data.url).hash.slice(1)).get('invite');
  const token2 = new URLSearchParams(new URL(invite2.data.url).hash.slice(1)).get('invite');
  const client = await register('client@example.com', token1);
  assert.equal(client.data.role, 'client');
  assert.equal((await register('extra@example.com', token1)).status, 400);
  assert.equal((await register('extra@example.com', token2)).status, 403);
  assert.equal((await request('/api/clients', {cookie:client.cookie})).status, 403);
  assert.equal((await request('/repdb-data.js', {cookie:client.cookie})).status, 403);
  const clientId = (await request('/api/clients', {cookie:pro.cookie})).data[0].id;
  const session = {format:'fitness-maker-session', version:1, name:'Séance privée', items:[{exerciseId:exercises[0].id, sets:2, work:20, rest:10}]};
  assert.equal((await request('/api/assignments', {cookie:other.cookie, body:{clientId,session}})).status, 404);
  const created = await request('/api/assignments', {cookie:pro.cookie, body:{clientId,session}});
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request('/api/assignments', {cookie:other.cookie})).data.length, 0);
  assert.equal((await request('/api/assignments', {cookie:client.cookie})).data[0].items[0].exercise.name, exercises[0].name);
  assert.equal((await request(`/api/assignments/${id}/session`, {cookie:pro.cookie, body:{completed:true, feedback:'interdit'}})).status, 403);
  assert.equal((await request(`/api/assignments/${id}/exercise`, {cookie:client.cookie, body:{index:1, completed:true, feedback:''}})).status, 400);
  assert.equal((await request(`/api/assignments/${id}/exercise`, {cookie:client.cookie, body:{index:0, completed:true, feedback:'Difficile'}})).status, 200);
  assert.equal((await request(`/api/assignments/${id}/session`, {cookie:client.cookie, body:{completed:true, feedback:'Bien'}})).status, 200);
  const report = (await request('/api/assignments', {cookie:pro.cookie})).data[0];
  assert.equal(report.feedback, 'Bien');
  assert.equal(report.exercises[0].feedback, 'Difficile');
  assert.ok(report.completedAt);
  for (let i = 0; i < 2; i++) assert.equal((await request('/api/assignments', {cookie:pro.cookie, body:{clientId,session}})).status, 201);
  assert.equal((await request('/api/assignments', {cookie:pro.cookie, body:{clientId,session}})).status, 403);
  assert.equal((await request('/api/billing/checkout', {cookie:pro.cookie, body:{}})).status, 200);
  assert.equal((await request('/api/billing/checkout', {cookie:pro.cookie, body:{}})).data.url, 'https://checkout.stripe.com/test');
  async function webhook() {
    const body = {type:'customer.subscription.updated', data:{object:{customer:'cus_test'}}};
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
    return request('/api/stripe/webhook', {body, headers:{'stripe-signature':`t=${timestamp},v1=${signature}`}});
  }
  assert.equal((await request('/api/stripe/webhook', {body:{type:'customer.subscription.updated'}, headers:{'stripe-signature':'bad'}})).status, 400);
  assert.equal((await webhook()).status, 200);
  assert.equal((await request('/api/me', {cookie:pro.cookie})).data.paid, true);
  assert.equal((await request('/api/assignments', {cookie:pro.cookie, body:{clientId,session}})).status, 201);
  const secondClient = await register('extra@example.com', token2);
  assert.equal(secondClient.data.role, 'client');
  const secondId = (await request('/api/clients', {cookie:pro.cookie})).data.find(c => c.email === 'extra@example.com').id;
  const secondAssignment = await request('/api/assignments', {cookie:pro.cookie, body:{clientId:secondId,session}});
  assert.equal((await request('/api/assignments', {cookie:secondClient.cookie})).data.length, 1);
  assert.equal((await request(`/api/assignments/${id}/session`, {cookie:secondClient.cookie, body:{completed:true, feedback:'interdit'}})).status, 404);
  assert.equal((await request(`/api/assignments/${secondAssignment.data.id}/session`, {cookie:client.cookie, body:{completed:true, feedback:'interdit'}})).status, 404);
  subscriptionStatus = 'canceled';
  assert.equal((await webhook()).status, 200);
  assert.equal((await request('/api/me', {cookie:pro.cookie})).data.paid, false);
  assert.equal((await request('/api/assignments', {cookie:pro.cookie, body:{clientId,session}})).status, 403);
  assert.equal((await request('/api/logout', {cookie:client.cookie, body:{}})).status, 200);
  assert.equal((await request('/api/assignments', {cookie:client.cookie})).status, 401);
});

test('limitation par adresse derrière le proxy uniquement lorsqu’il est approuvé', async t => {
  for (const trustCaddy of [false, true]) {
    const server = createApp({database:':memory:', appUrl:'http://localhost:3000', trustCaddy});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/login`;
    const request = ip => fetch(url, {method:'POST', headers:{origin:'http://localhost:3000', 'content-type':'application/json', 'x-tracker-client-ip':ip}, body:'{}'});
    for (let i = 0; i < 20; i++) assert.equal((await request('192.0.2.1')).status, 400);
    assert.equal((await request('192.0.2.1')).status, 429);
    assert.equal((await request('192.0.2.2')).status, trustCaddy ? 400 : 429);
  }
});
